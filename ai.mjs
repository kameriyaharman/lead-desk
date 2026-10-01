// Reads each lead's chat and fills in what you need to know: requirement, budget,
// stage, a short summary, the next thing to do and when to follow up.
import Anthropic from '@anthropic-ai/sdk';
import { db, logEvent } from './db.mjs';
import { bus } from './whatsapp.mjs';

const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const aiEnabled = () => !!client;

const IST = 5.5 * 3600e3;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtIST(ms) {
  const d = new Date(ms + IST);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} (${DAYS[d.getUTCDay()]})`;
}
export function parseIST(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - IST;
}

const BUSINESS = process.env.BUSINESS_CONTEXT ||
  'Chatturai, an AI cinematic production studio in New Delhi (brand films, ads, reels, AI video, trailers, and a mentorship program for AI studio founders).';

const SYSTEM = `You help a business owner in India manage WhatsApp leads. The business: ${BUSINESS}
You read one WhatsApp chat between the business ("ME") and one contact ("CLIENT") and return ONLY a JSON object, no other text.
Chats are often in Hinglish (Hindi in Roman script), Hindi or English.

Fields:
- "is_lead": true if the contact is a prospective or current customer/enquiry for the business; false for family, friends, vendors, spam, OTP/delivery bots, or staff.
- "name": the client's name or company if it appears in the chat, else null.
- "need": what the client wants, max 12 words, in English. null if unclear.
- "budget": budget or quoted price as written (e.g. "₹50k", "₹1.2L quoted"), else null.
- "stage": one of "new" (only enquired, no real reply yet), "talking" (discussion going on), "interested" (clearly interested / asked price or details), "quote" (price or proposal sent, waiting), "won" (confirmed, advance paid, or work started), "lost" (said no, went silent after many follow-ups, or chose someone else).
- "summary": 1-2 short sentences in English: what has happened so far and where it stands now.
- "next_action": the single next thing ME should do, max 12 words, in English, e.g. "Send the quotation PDF", "Call to confirm budget".
- "follow_up_at": when ME should next contact the client, as "YYYY-MM-DD HH:MM" in India time. Rules: if the client asked for a specific time ("kal call karna", "Monday ko baat karte hain", "after Diwali"), use that. If the client's last message is unanswered, use within 2 hours of now (but during 10:00-20:00). If ME promised to send something, use the promised time or next working day 11:00. If waiting on the client after a quote, 2 days after the last message at 11:00. If stage is won or lost or is_lead is false, null. Never return a time in the past; if the right time already passed, return now + 30 minutes.
- "follow_type": "call" if a call was asked for or is clearly better, else "message".
- "priority": "hot" (ready to buy / urgent / big budget), "warm", or "cold".`;

function transcript(leadId) {
  const rows = db.prepare('SELECT from_me, ts, text FROM messages WHERE lead_id=? ORDER BY ts DESC LIMIT 60').all(leadId).reverse();
  return rows.map((r) => `[${fmtIST(r.ts)}] ${r.from_me ? 'ME' : 'CLIENT'}: ${r.text}`).join('\n');
}

const STAGES = new Set(['new', 'talking', 'interested', 'quote', 'won', 'lost']);

async function analyse(lead) {
  const chat = transcript(lead.id);
  if (!chat) return;
  const prompt = `Now (India time): ${fmtIST(Date.now())}
Contact saved as: ${lead.name || lead.wa_name || 'unknown'} · phone ${lead.phone || 'hidden'}
Current stage in my CRM: ${lead.stage}${lead.note ? `\nMy private note: ${lead.note}` : ''}

CHAT:
${chat}`;
  const res = await client.messages.create({
    model: MODEL, max_tokens: 600, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  const txt = (res.content || []).map((c) => c.text || '').join('');
  const json = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  let fu = json.follow_up_at ? parseIST(json.follow_up_at) : null;
  if (fu && fu < Date.now()) fu = Date.now() + 30 * 60e3;
  const stage = STAGES.has(json.stage) ? json.stage : lead.stage;
  const closed = stage === 'won' || stage === 'lost' || json.is_lead === false;
  db.prepare(`UPDATE leads SET is_lead_ai=?, name=COALESCE(name, ?), need=?, budget=?, stage=?, summary=?, next_action=?,
      follow_up_at=?, follow_type=?, follow_source='ai', priority=?, ai_at=?,
      ai_dirty=CASE WHEN last_msg_at > ? THEN 1 ELSE 0 END WHERE id=?`)
    .run(json.is_lead === false ? 0 : 1, json.name || null, json.need || null, json.budget || null, stage,
      json.summary || null, json.next_action || null, closed ? null : fu, json.follow_type === 'call' ? 'call' : 'message',
      ['hot', 'warm', 'cold'].includes(json.priority) ? json.priority : null, Date.now(), Date.now(), lead.id);
  if (stage !== lead.stage) logEvent(lead.id, `AI moved stage: ${lead.stage} → ${stage}`);
}

let running = false;
async function tick() {
  if (!client || running) return;
  running = true;
  try {
    const settle = Date.now() - 90e3;           // wait till the chat pauses
    const recent = Date.now() - 45 * 864e5;     // skip very old history chats
    const batch = db.prepare(`SELECT * FROM leads WHERE ai_dirty=1 AND hidden=0 AND last_msg_at < ? AND last_msg_at > ?
                              ORDER BY last_msg_at DESC LIMIT 6`).all(settle, recent);
    let changed = false;
    for (const lead of batch) {
      try { await analyse(lead); changed = true; }
      catch (e) {
        console.error('AI failed for', lead.id, e?.status || '', e?.message || e);
        if (e?.status === 401 || e?.status === 403) break;
        db.prepare('UPDATE leads SET ai_dirty=0, ai_at=? WHERE id=?').run(Date.now(), lead.id); // avoid retry loop
      }
    }
    if (changed) bus.emit('change');
  } finally { running = false; }
}

export function startAI() {
  if (!client) { console.log('AI off: set ANTHROPIC_API_KEY to turn on chat understanding.'); return; }
  setInterval(tick, 30e3);
  setTimeout(tick, 5e3);
}
export const reanalyse = (id) => { db.prepare('UPDATE leads SET ai_dirty=1 WHERE id=?').run(id); setTimeout(tick, 100); };
