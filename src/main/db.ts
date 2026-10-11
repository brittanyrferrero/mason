import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR = join(homedir(), '.sidecar')

export type DB = Database.Database

// Sidecar's own data lives outside the repo, in ~/.sidecar (owner-only).
export function openDb(): DB {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const db = new Database(join(DATA_DIR, 'sidecar.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY,
      key        TEXT NOT NULL UNIQUE,   -- git common dir, or the folder for non-git work
      name       TEXT NOT NULL,
      root       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,    -- Claude Code session id
      project_id    INTEGER REFERENCES projects(id),
      cwd           TEXT,
      branch        TEXT,
      ai_title      TEXT,
      first_prompt  TEXT,
      last_prompt   TEXT,
      last_text     TEXT,                -- Claude's most recent reply (plain text)
      pr_url        TEXT,
      started_at    INTEGER,
      last_activity INTEGER,
      entrypoint    TEXT,                -- 'cli' for sessions you ran; 'sdk-*' for automated runs (hidden)
      transcript    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_activity ON sessions(last_activity);
    CREATE TABLE IF NOT EXISTS files (
      path   TEXT PRIMARY KEY,
      offset INTEGER NOT NULL            -- bytes already ingested
    );
    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      kind       TEXT NOT NULL,          -- 'message' | 'idea' | 'later'
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoffs (
      id            INTEGER PRIMARY KEY,
      session_id    TEXT REFERENCES sessions(id),
      source        TEXT NOT NULL,       -- 'pause' | 'auto' | 'end'
      last_happened TEXT,
      stopped       TEXT,
      next_step     TEXT,
      resume_prompt TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY,
      session_id TEXT,
      kind       TEXT NOT NULL,
      payload    TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  // Columns added after the first release.
  const cols = new Set((db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('entrypoint')) db.exec('ALTER TABLE sessions ADD COLUMN entrypoint TEXT')
  return db
}
