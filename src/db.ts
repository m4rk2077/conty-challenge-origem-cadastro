import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS origin_tokens (
      token TEXT PRIMARY KEY, origin_type TEXT NOT NULL CHECK (origin_type IN ('campaign', 'referral')),
      origin_id TEXT NOT NULL, active INTEGER NOT NULL CHECK (active IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS resolved_clicks (
      click_id TEXT PRIMARY KEY, token TEXT NOT NULL REFERENCES origin_tokens(token),
      idempotency_key TEXT NOT NULL, original_click_at TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(token, idempotency_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS installations (
      installation_id TEXT PRIMARY KEY, first_open_at TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS touches (
      installation_id TEXT NOT NULL REFERENCES installations(installation_id), click_id TEXT NOT NULL,
      origin_token TEXT NOT NULL, origin_type TEXT CHECK (origin_type IN ('campaign', 'referral')),
      origin_id TEXT, touched_at TEXT NOT NULL, original_click_at TEXT, received_at TEXT NOT NULL,
      token_state TEXT NOT NULL CHECK (token_state IN ('valid', 'invalid', 'inactive', 'unknown_click', 'click_token_mismatch')),
      recorded_after_signup INTEGER NOT NULL CHECK (recorded_after_signup IN (0, 1)),
      PRIMARY KEY(installation_id, click_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS touch_receipts (
      receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id TEXT NOT NULL, click_id TEXT NOT NULL, origin_token TEXT NOT NULL,
      touched_at TEXT NOT NULL, received_at TEXT NOT NULL,
      duplicate INTEGER NOT NULL CHECK (duplicate IN (0, 1)),
      recorded_after_signup INTEGER NOT NULL CHECK (recorded_after_signup IN (0, 1)),
      FOREIGN KEY(installation_id, click_id) REFERENCES touches(installation_id, click_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS signups (
      signup_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL UNIQUE REFERENCES installations(installation_id),
      signed_up_at TEXT NOT NULL, origin_type TEXT NOT NULL CHECK (origin_type IN ('campaign', 'referral', 'organic')),
      origin_id TEXT, winning_click_id TEXT, decision_reason TEXT NOT NULL, decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(installation_id, winning_click_id) REFERENCES touches(installation_id, click_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS receipts_installation ON touch_receipts(installation_id, receipt_id);
  `);
  return db;
}

export function seedOrigins(db: DatabaseSync): void {
  const insert = db.prepare('INSERT INTO origin_tokens(token, origin_type, origin_id, active) VALUES (?, ?, ?, ?) ON CONFLICT(token) DO NOTHING');
  insert.run('tok_cmp_summer', 'campaign', 'summer_2026', 1);
  insert.run('tok_ref_crt123', 'referral', 'crt_123', 1);
  insert.run('tok_cmp_inactive', 'campaign', 'old_campaign', 0);
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
