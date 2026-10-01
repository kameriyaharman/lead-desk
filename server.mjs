import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, kv, logEvent } from './db.mjs';
import { bus, wa, publicStatus, startWhatsApp, disconnectWhatsApp, bootWhatsApp } from './whatsapp.mjs';
import { startAI, aiEnabled, reanalyse } from './ai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
let SECRET = process.env.SESSION_SECRET || kv.get('session_secret');
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); kv.set('session_secret', SECRET); }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

/* ---------- login ---------- */
const sign = (v) => crypto.createHmac('sha256', SECRET + PASSWORD).update(v).digest('hex');
const makeToken = () => { const v = String(Date.now()); return v + '.' + sign(v); };
function validToken(t) {
  if (!t || !PASSWORD) return false;
  const [v, s] = String(t).split('.');
  if (!v || !s) return false;
  const good = sign(v);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return false;
  return Date.now() - Number(v) < 60 * 864e5; // 60 days
}
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: 'Bahut baar galat password. 15 minute baad try karein.' });
  if (!PASSWORD) return res.status(500).json({ error: 'Server pe DASHBOARD_PASSWORD set nahi hai.' });
  const p = String(req.body?.password || '');
  const ok = p.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(PASSWORD));
  if (!ok) { a.n++; attempts.set(ip, a); return res.status(401).json({ error: 'Password galat hai.' }); }
  attempts.delete(ip);
  res.cookie('sess', makeToken(), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 60 * 864e5 });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('sess'); res.json({ ok: true }); });
app.get('/healthz', (req, res) => res.send('ok'));

app.use('/api', (req, res, next) => validToken(req.cookies.sess) ? next() : res.status(401).json({ error: 'login' }));

/* ---------- data ---------- */
const LEAD_COLS = `id, phone, lid, COALESCE(name, wa_name) AS display_name, name, wa_name, stage, need, budget, summary, next_action,
  follow_up_at, follow_type, follow_source, priority, hidden, is_lead_ai, created_at, first_msg_at, last_msg_at,
  last_in_at, last_out_at, ai_at, ai_dirty, note,
  (SELECT text FROM messages m WHERE m.lead_id = leads.id ORDER BY ts DESC LIMIT 1) AS last_text,
  (SELECT from_me FROM messages m WHERE m.lead_id = leads.id ORDER BY ts DESC LIMIT 1) AS last_from_me,
  (SELECT COUNT(*) FROM messages m WHERE m.lead_id = leads.id) AS msg_count`;

app.get('/api/state', (req, res) => res.json({ wa: publicStatus(), ai: aiEnabled(), now: Date.now() }));

app.get('/api/leads', (req, res) => {
  const hidden = req.query.hidden === '1' ? 1 : 0;
  const rows = db.prepare(`SELECT ${LEAD_COLS} FROM leads WHERE hidden=? ORDER BY last_msg_at DESC LIMIT 3000`).all(hidden);
  res.json({ leads: rows, now: Date.now() });
});

app.get('/api/leads/:id', (req, res) => {
  const lead = db.prepare(`SELECT ${LEAD_COLS} FROM leads WHERE id=?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead nahi mili' });
  const messages = db.prepare('SELECT id, from_me, ts, kind, text FROM messages WHERE lead_id=? ORDER BY ts DESC LIMIT 400').all(lead.id).reverse();
  const events = db.prepare('SELECT ts, text FROM events WHERE lead_id=? ORDER BY ts DESC LIMIT 100').all(lead.id);
  res.json({ lead, messages, events });
});

const STAGES = { new: 'Nayi', talking: 'Baat chal rahi', interested: 'Interested', quote: 'Quote bheja', won: 'Deal pakki', lost: 'Lost' };
app.patch('/api/leads/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead nahi mili' });
  const b = req.body || {};
  const set = {}; const notes = [];
  if ('stage' in b && STAGES[b.stage] && b.stage !== lead.stage) {
    set.stage = b.stage; notes.push(`Stage: ${STAGES[lead.stage] || lead.stage} → ${STAGES[b.stage]}`);
    if (b.stage === 'won' || b.stage === 'lost') set.follow_up_at = null;
  }
  if ('follow_up_at' in b) {
    const v = b.follow_up_at === null ? null : Number(b.follow_up_at);
    if (v !== null && !Number.isFinite(v)) return res.status(400).json({ error: 'Follow-up time galat hai' });
    set.follow_up_at = v; set.follow_source = 'manual';
    notes.push(v ? 'Follow-up aapne set kiya' : 'Follow-up hata diya');
  }
  if ('follow_type' in b) set.follow_type = b.follow_type === 'call' ? 'call' : 'message';
  for (const k of ['name', 'note', 'need', 'budget', 'next_action']) if (k in b) set[k] = b[k] === '' ? null : String(b[k]).slice(0, 2000);
  if ('hidden' in b) { set.hidden = b.hidden ? 1 : 0; notes.push(b.hidden ? 'Lead nahi hai — list se hataya' : 'Wapas leads mein laaya'); }
  const keys = Object.keys(set);
  if (keys.length) db.prepare(`UPDATE leads SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id`).run({ ...set, id: lead.id });
  notes.forEach((n) => logEvent(lead.id, n));
  bus.emit('change');
  res.json({ ok: true });
});

app.post('/api/leads/:id/done', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead nahi mili' });
  const next = req.body?.next_at ? Number(req.body.next_at) : null;
  db.prepare("UPDATE leads SET follow_up_at=?, follow_source='manual' WHERE id=?").run(next, lead.id);
  logEvent(lead.id, `Follow-up ho gaya${lead.follow_type === 'call' ? ' (call)' : ''}`);
  bus.emit('change');
  res.json({ ok: true });
});

app.post('/api/leads/:id/reanalyse', (req, res) => {
  if (!aiEnabled()) return res.status(400).json({ error: 'AI band hai: server pe ANTHROPIC_API_KEY set karein.' });
  reanalyse(req.params.id);
  res.json({ ok: true });
});

app.post('/api/wa/connect', async (req, res) => { await startWhatsApp(); res.json(publicStatus()); });
app.post('/api/wa/disconnect', async (req, res) => { await disconnectWhatsApp(); res.json(publicStatus()); });

/* ---------- live updates ---------- */
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  send('wa', publicStatus());
  let pending = null;
  const onChange = () => { if (!pending) pending = setTimeout(() => { pending = null; send('change', { at: Date.now() }); }, 700); };
  const onWa = (s) => send('wa', s);
  bus.on('change', onChange); bus.on('wa', onWa);
  const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
  req.on('close', () => { clearInterval(ping); clearTimeout(pending); bus.off('change', onChange); bus.off('wa', onWa); });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: 0 }));

app.listen(PORT, () => {
  console.log(`Lead Desk on :${PORT}${PASSWORD ? '' : '  (WARNING: DASHBOARD_PASSWORD not set — login disabled)'}`);
  bootWhatsApp();
  startAI();
});
