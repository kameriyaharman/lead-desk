import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'leads.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,            -- phone digits when known, else lid user part
  phone TEXT,
  lid TEXT,
  wa_name TEXT,                   -- name the client set on WhatsApp
  name TEXT,                      -- name you set / AI found
  stage TEXT DEFAULT 'new',       -- new, talking, interested, quote, won, lost
  need TEXT,
  budget TEXT,
  summary TEXT,
  next_action TEXT,
  follow_up_at INTEGER,           -- epoch ms
  follow_type TEXT,               -- call | message
  follow_source TEXT,             -- ai | manual
  priority TEXT,                  -- hot | warm | cold
  hidden INTEGER DEFAULT 0,       -- 1 = not a lead (personal chat etc.)
  is_lead_ai INTEGER,             -- AI verdict
  created_at INTEGER,
  first_msg_at INTEGER,
  last_msg_at INTEGER,
  last_in_at INTEGER,
  last_out_at INTEGER,
  ai_dirty INTEGER DEFAULT 0,
  ai_at INTEGER,
  note TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_me INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT,
  text TEXT
);
CREATE INDEX IF NOT EXISTS msg_lead_ts ON messages(lead_id, ts);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  text TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

export const kv = {
  get: (k) => db.prepare('SELECT v FROM kv WHERE k=?').get(k)?.v ?? null,
  set: (k, v) => db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)),
};

export function logEvent(leadId, text) {
  db.prepare('INSERT INTO events(lead_id, ts, text) VALUES(?,?,?)').run(leadId, Date.now(), text);
}
