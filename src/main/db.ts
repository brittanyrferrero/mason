import Database from 'better-sqlite3'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR = join(homedir(), '.mason')

export type DB = Database.Database

// Mason's own data lives outside the repo, in ~/.mason (owner-only).
// This app used to be called Sidecar; carry its data over the first time Mason runs.
function migrateFromSidecar(): void {
  const old = join(homedir(), '.sidecar')
  if (!existsSync(old) || existsSync(DATA_DIR)) return
  renameSync(old, DATA_DIR)
  for (const suffix of ['', '-wal', '-shm']) {
    const from = join(DATA_DIR, `sidecar.db${suffix}`)
    if (existsSync(from)) renameSync(from, join(DATA_DIR, `mason.db${suffix}`))
  }
}

export function openDb(): DB {
  migrateFromSidecar()
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const db = new Database(join(DATA_DIR, 'mason.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const hadDirs = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_dirs'").get()
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
    -- Your own name and pin for a session. Kept apart from sessions so re-reading transcripts never undoes them.
    CREATE TABLE IF NOT EXISTS session_prefs (
      session_id TEXT PRIMARY KEY,
      name       TEXT,
      pinned     INTEGER NOT NULL DEFAULT 0
    );
    -- Your own notes: on a session ('s:<id>'), on a project ('p:<id>'), or the free-floating 'scratch'.
    -- Keyed by what they're about, so they outlive ending, pausing, and restarts.
    CREATE TABLE IF NOT EXISTS my_notes (
      target     TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- How much each session worked in each folder, so one started in ~ can follow the repo it actually worked in.
    CREATE TABLE IF NOT EXISTS session_dirs (
      session_id TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      n          INTEGER NOT NULL,
      PRIMARY KEY (session_id, cwd)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  // Columns added after the first release.
  const cols = new Set((db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('entrypoint')) db.exec('ALTER TABLE sessions ADD COLUMN entrypoint TEXT')
  // Moved to a project by hand: it stays there, whatever folder it works in.
  // The model Claude last answered with ("claude-opus-5-5"), shown on each window.
  if (!cols.has('model')) db.exec('ALTER TABLE sessions ADD COLUMN model TEXT')
  if (!cols.has('placed')) db.exec('ALTER TABLE sessions ADD COLUMN placed INTEGER NOT NULL DEFAULT 0')
  const prefCols = new Set((db.prepare('PRAGMA table_info(session_prefs)').all() as { name: string }[]).map((c) => c.name))
  // session_dirs is new: read every transcript once more so existing sessions get their folder counts.
  if (!hadDirs) db.exec('DELETE FROM files')
  if (!prefCols.has('starred')) db.exec('ALTER TABLE session_prefs ADD COLUMN starred INTEGER NOT NULL DEFAULT 0')
  // Projects you added yourself stay in the list even with nothing running in them.
  const projCols = new Set((db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name))
  if (!projCols.has('kept')) db.exec('ALTER TABLE projects ADD COLUMN kept INTEGER NOT NULL DEFAULT 0')
  return db
}
