// WhatsApp side: links as a linked device (like WhatsApp Web) and ONLY READS.
// This module never sends messages, never marks chats as read, never goes "online".
import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion, fetchLatestWaWebVersion, useMultiFileAuthState,
  isLidUser, isPnUser, jidNormalizedUser,
} from 'baileys';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import { db, DATA_DIR, kv, logEvent } from './db.mjs';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const AUTH_DIR = path.join(DATA_DIR, 'auth');
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 90);
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });
const log = (...a) => console.log('[wa]', ...a);

db.exec(`CREATE TABLE IF NOT EXISTS contacts (jid TEXT PRIMARY KEY, name TEXT)`);

export const wa = { status: 'disconnected', qr: null, me: null, error: null, since: null, sock: null, historyProgress: null };
let reconnectTimer = null;
let watchdog = null;
let starting = false;
let attempt = Number(kv.get('wa_browser') ?? process.env.WA_BROWSER ?? 0); // browser profile; must stay the one the phone was linked with
let refused = 0; // handshakes refused in a row while already linked
const BROWSERS = () => [Browsers.macOS('Desktop'), Browsers.ubuntu('Chrome'), Browsers.windows('Chrome')];

function setStatus(s, extra = {}) {
  Object.assign(wa, { status: s, since: Date.now() }, extra);
  log('status', s, extra.error || '');
  bus.emit('wa', publicStatus());
}
export function publicStatus() {
  return { status: wa.status, qr: wa.qr, me: wa.me, error: wa.error, since: wa.since, historyProgress: wa.historyProgress };
}
// true only once a phone has actually been linked (not just keys generated)
export function isPaired() {
  try { return !!JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8'))?.me?.id; } catch { return false; }
}

const userPart = (jid) => (jid || '').split('@')[0].split(':')[0];
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/* ---------- text extraction ---------- */
function unwrap(m) {
  if (!m) return m;
  return m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
    || m.documentWithCaptionMessage?.message || m.editedMessage?.message || m;
}
function extract(message) {
  const m = unwrap(message);
  if (!m) return null;
  if (m.conversation) return { kind: 'text', text: m.conversation };
  if (m.extendedTextMessage?.text) return { kind: 'text', text: m.extendedTextMessage.text };
  if (m.imageMessage) return { kind: 'image', text: '[Photo] ' + (m.imageMessage.caption || '') };
  if (m.videoMessage) return { kind: 'video', text: '[Video] ' + (m.videoMessage.caption || '') };
  if (m.audioMessage) return { kind: 'audio', text: m.audioMessage.ptt ? '[Voice note]' : '[Audio]' };
  if (m.documentMessage) return { kind: 'doc', text: '[Document] ' + (m.documentMessage.fileName || m.documentMessage.caption || '') };
  if (m.stickerMessage) return { kind: 'sticker', text: '[Sticker]' };
  if (m.contactMessage) return { kind: 'contact', text: '[Contact card] ' + (m.contactMessage.displayName || '') };
  if (m.locationMessage) return { kind: 'location', text: '[Location] ' + (m.locationMessage.name || m.locationMessage.address || '') };
  if (m.buttonsResponseMessage) return { kind: 'text', text: m.buttonsResponseMessage.selectedDisplayText || '' };
  if (m.listResponseMessage) return { kind: 'text', text: m.listResponseMessage.title || '' };
  if (m.templateButtonReplyMessage) return { kind: 'text', text: m.templateButtonReplyMessage.selectedDisplayText || '' };
  return null; // reactions, protocol messages, polls, etc.
}

/* ---------- identity ---------- */
async function resolve(key) {
  const jid = key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid === 'status@broadcast') return null;
  let pn = null, lid = null;
  if (isPnUser(jid)) pn = jid;
  else if (isLidUser(jid)) {
    lid = jid;
    if (key.remoteJidAlt && isPnUser(key.remoteJidAlt)) pn = key.remoteJidAlt;
    else {
      try { pn = await wa.sock?.signalRepository?.lidMapping?.getPNForLID(jid); } catch { pn = null; }
    }
  } else return null;
  if (!lid && key.remoteJidAlt && isLidUser(key.remoteJidAlt)) lid = key.remoteJidAlt;
  const phone = pn ? userPart(jidNormalizedUser(pn)) : null;
  const lidU = lid ? userPart(lid) : null;
  if (!phone && !lidU) return null;
  if (phone && wa.me && phone === wa.me) return null; // chat with yourself
  return { phone, lid: lidU, id: phone || 'lid' + lidU, jid };
}

const mergeLead = db.transaction((fromId, toId) => {
  db.prepare('UPDATE OR IGNORE messages SET lead_id=? WHERE lead_id=?').run(toId, fromId);
  db.prepare('UPDATE events SET lead_id=? WHERE lead_id=?').run(toId, fromId);
  const a = db.prepare('SELECT * FROM leads WHERE id=?').get(fromId);
  if (a) {
    db.prepare(`UPDATE leads SET
      first_msg_at=MIN(COALESCE(first_msg_at,?),?), created_at=MIN(COALESCE(created_at,?),?),
      name=COALESCE(name,?), wa_name=COALESCE(wa_name,?), ai_dirty=1 WHERE id=?`)
      .run(a.first_msg_at, a.first_msg_at, a.created_at, a.created_at, a.name, a.wa_name, toId);
  }
  db.prepare('DELETE FROM leads WHERE id=?').run(fromId);
});

function ensureLead(who, ts) {
  if (who.phone && who.lid) {
    const old = db.prepare('SELECT id FROM leads WHERE id=?').get('lid' + who.lid);
    if (old) {
      if (!db.prepare('SELECT id FROM leads WHERE id=?').get(who.id)) {
        db.prepare('INSERT INTO leads(id, phone, lid, created_at, first_msg_at) VALUES(?,?,?,?,?)').run(who.id, who.phone, who.lid, ts, ts);
      }
      mergeLead('lid' + who.lid, who.id);
    }
  }
  const ex = db.prepare('SELECT id FROM leads WHERE id=?').get(who.id);
  if (!ex) {
    const cname = db.prepare('SELECT name FROM contacts WHERE jid IN (?,?)').get(who.phone || '-', who.lid || '-')?.name || null;
    db.prepare('INSERT INTO leads(id, phone, lid, wa_name, created_at, first_msg_at) VALUES(?,?,?,?,?,?)')
      .run(who.id, who.phone, who.lid, cname, ts, ts);
    return true;
  }
  db.prepare('UPDATE leads SET phone=COALESCE(phone,?), lid=COALESCE(lid,?) WHERE id=?').run(who.phone, who.lid, who.id);
  return false;
}

const insertMsg = db.prepare('INSERT OR IGNORE INTO messages(id, lead_id, from_me, ts, kind, text) VALUES(?,?,?,?,?,?)');

async function ingest(msg, { history = false } = {}) {
  if (!msg?.key || !msg.message) return false;
  const ex = extract(msg.message);
  if (!ex || !ex.text?.trim()) return false;
  const ts = Number(msg.messageTimestamp || 0) * 1000 || Date.now();
  if (history && ts < Date.now() - HISTORY_DAYS * 864e5) return false;
  const who = await resolve(msg.key);
  if (!who) return false;
  const fromMe = msg.key.fromMe ? 1 : 0;
  const created = ensureLead(who, ts);
  const r = insertMsg.run(`${who.id}:${msg.key.id}`, who.id, fromMe, ts, ex.kind, ex.text.trim().slice(0, 4000));
  if (!r.changes) return false;
  db.prepare(`UPDATE leads SET
      last_msg_at=MAX(COALESCE(last_msg_at,0),?),
      first_msg_at=MIN(COALESCE(first_msg_at,?),?),
      created_at=MIN(COALESCE(created_at,?),?),
      last_in_at=CASE WHEN ?=0 THEN MAX(COALESCE(last_in_at,0),?) ELSE last_in_at END,
      last_out_at=CASE WHEN ?=1 THEN MAX(COALESCE(last_out_at,0),?) ELSE last_out_at END,
      wa_name=CASE WHEN ?=0 AND ? IS NOT NULL THEN ? ELSE wa_name END,
      ai_dirty=1
    WHERE id=?`).run(ts, ts, ts, ts, ts, fromMe, ts, fromMe, ts, fromMe, msg.pushName || null, msg.pushName || null, who.id);
  if (created && !history) logEvent(who.id, 'New lead from WhatsApp');
  return true;
}

function saveContacts(list) {
  const up = db.prepare('INSERT INTO contacts(jid,name) VALUES(?,?) ON CONFLICT(jid) DO UPDATE SET name=excluded.name');
  const setName = db.prepare('UPDATE leads SET wa_name=COALESCE(wa_name,?) WHERE phone=? OR lid=?');
  for (const c of list || []) {
    const name = c.name || c.notify || c.verifiedName;
    if (!name) continue;
    for (const j of [c.id, c.phoneNumber, c.lid]) {
      if (!j) continue;
      const u = userPart(j);
      up.run(u, name);
      setName.run(name, u, u);
    }
  }
}

/* ---------- connection ---------- */
function killSocket() {
  const s = wa.sock;
  wa.sock = null;
  try { s?.ev?.removeAllListeners?.(); } catch { /* ignore */ }
  try { s?.end?.(undefined); } catch { /* ignore */ }
}

export async function startWhatsApp(force = false) {
  if (force === true && wa.status !== 'connected') { clearTimeout(watchdog); killSocket(); starting = false; if (!isPaired()) attempt = 0; }
  if (starting || (wa.sock && ['connecting', 'qr', 'connected'].includes(wa.status))) return;
  starting = true;
  clearTimeout(reconnectTimer);
  clearTimeout(watchdog);
  try {
    setStatus('connecting', { qr: null, error: null });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = process.env.WA_VERSION ? process.env.WA_VERSION.split('.').map(Number) : null;
    if (!version) {
      try { const r = await withTimeout(fetchLatestWaWebVersion(), 6000); if (r?.isLatest !== false && r?.version) version = r.version; } catch (e) { log('web version check failed:', e?.message); }
    }
    if (!version) {
      try { ({ version } = await withTimeout(fetchLatestBaileysVersion(), 6000)); } catch (e) { log('version check skipped:', e?.message); }
    }
    log('using WA version', version?.join('.') || 'bundled default', 'browser profile', attempt % 3);
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      browser: BROWSERS()[attempt % 3],
      markOnlineOnConnect: false,   // phone keeps getting notifications
      syncFullHistory: true,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 30000,
    });
    wa.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    // if nothing happens (no QR, no login) in 45s, stop and let the user retry
    watchdog = setTimeout(() => {
      if (wa.sock === sock && wa.status === 'connecting') {
        log('watchdog: no response from WhatsApp');
        killSocket();
        setStatus('error', { qr: null, error: 'WhatsApp did not respond. Please try again.' });
      }
    }, 45000);

    sock.ev.on('connection.update', async (u) => {
      if (wa.sock !== sock) return;
      if (u.connection || u.qr) log('update', u.connection || '', u.qr ? 'qr' : '', u.lastDisconnect?.error?.output?.statusCode || '');
      if (u.qr) setStatus('qr', { qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }) });
      if (u.connection === 'open') {
        clearTimeout(watchdog);
        wa.me = userPart(jidNormalizedUser(sock.user?.id));
        kv.set('wa_me', wa.me);
        kv.set('wa_browser', attempt % 3); // remember the profile this device was linked with
        refused = 0;
        setStatus('connected', { qr: null, error: null });
      }
      if (u.connection === 'close') {
        clearTimeout(watchdog);
        const code = u.lastDisconnect?.error?.output?.statusCode;
        wa.sock = null;
        if (code === DisconnectReason.loggedOut || code === 401) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          setStatus('logged_out', { qr: null, error: 'This device was unlinked from your phone. Scan a new QR code to reconnect.' });
        } else if (!isPaired() && wa.status === 'connecting' && attempt % 3 < 2) {
          attempt++;
          log('handshake refused, retrying with another browser profile', attempt);
          reconnectTimer = setTimeout(startWhatsApp, 1500);
        } else if (!isPaired() && code !== DisconnectReason.restartRequired) {
          setStatus('disconnected', { qr: null, error: wa.status === 'qr' ? 'The QR code expired. Generate a new one to try again.' : 'Could not connect to WhatsApp. Please try again.' });
        } else {
          if (code === 428 && ++refused % 3 === 0) { attempt++; log('linked session refused 3 times, trying browser profile', attempt % 3); }
          setStatus('reconnecting', { qr: null });
          reconnectTimer = setTimeout(startWhatsApp, code === DisconnectReason.restartRequired ? 500 : 4000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      let changed = false;
      for (const m of messages) changed = (await ingest(m, { history: type !== 'notify' })) || changed;
      if (changed) bus.emit('change');
    });
    sock.ev.on('messaging-history.set', async ({ messages, contacts, progress }) => {
      saveContacts(contacts);
      let n = 0;
      for (const m of messages) if (await ingest(m, { history: true })) n++;
      wa.historyProgress = progress ?? wa.historyProgress;
      log('history chunk', messages?.length || 0, 'msgs,', n, 'saved, progress', progress);
      bus.emit('wa', publicStatus());
      if (n) bus.emit('change');
    });
    sock.ev.on('contacts.upsert', (c) => { saveContacts(c); bus.emit('change'); });
    sock.ev.on('contacts.update', (c) => saveContacts(c));
  } catch (e) {
    console.error('[wa] start failed', e);
    killSocket();
    setStatus('error', { error: 'Could not start the WhatsApp connection: ' + (e?.message || e) });
    if (isPaired()) reconnectTimer = setTimeout(startWhatsApp, 15000);
  } finally {
    starting = false;
  }
}

export async function disconnectWhatsApp() {
  clearTimeout(reconnectTimer);
  clearTimeout(watchdog);
  const s = wa.sock;
  try { if (s && wa.status === 'connected') await withTimeout(s.logout(), 8000); } catch { /* already gone */ }
  killSocket();
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  setStatus('disconnected', { qr: null, me: null, error: null, historyProgress: null });
}

export function bootWhatsApp() {
  wa.me = kv.get('wa_me');
  if (isPaired()) startWhatsApp();
  else fs.rmSync(AUTH_DIR, { recursive: true, force: true }); // half-finished link attempt: start clean
}
