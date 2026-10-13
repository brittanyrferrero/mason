import { existsSync } from 'node:fs'
import type { DB } from './db'
import { readLive } from './live'
import { listHosted, SESSION_ID_RE, startSession, startTerminal } from './tmux'

// After a Mac restart the tmux server is gone, and with it every session that was running inside Mason.
// Mason keeps a running list of those sessions, and on launch, if tmux is empty, resumes each one in its folder.

const KEY = 'reopen'
const MAX_AGE = 7 * 24 * 60 * 60_000
let last = ''

export function rememberHostedIds(db: DB, ids: string[]): void {
  const key = JSON.stringify([...ids].sort())
  if (key === last) return
  last = key
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    KEY,
    JSON.stringify({ at: Date.now(), ids: JSON.parse(key) })
  )
}

// Plain terminals come back too: a fresh shell in the folder each was last in (what was running in it can't be).
const TERMS_KEY = 'reopenTerms'
let lastTerms = ''
export function rememberTerminals(db: DB, terms: { cwd: string; project?: number }[]): void {
  const key = JSON.stringify(terms)
  if (key === lastTerms) return
  lastTerms = key
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    TERMS_KEY,
    JSON.stringify({ at: Date.now(), terms })
  )
}

function reopenTerminals(db: DB): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TERMS_KEY) as { value: string } | undefined
  if (!row) return 0
  let n = 0
  try {
    const saved = JSON.parse(row.value) as { at: number; terms: { cwd: string; project?: number }[] }
    if (!Array.isArray(saved.terms) || Date.now() - saved.at > MAX_AGE) return 0
    for (const t of saved.terms) {
      if (typeof t.cwd !== 'string' || !existsSync(t.cwd)) continue
      const project = typeof t.project === 'number' && db.prepare('SELECT 1 FROM projects WHERE id = ?').get(t.project) ? t.project : undefined
      if (project === undefined) continue
      startTerminal(t.cwd, project)
      n++
    }
  } catch {}
  return n
}

// Returns how many sessions were reopened. Does nothing if tmux is still running (Mason only quit or crashed).
export function reopenAfterRestart(db: DB): number {
  if (listHosted().length) return 0
  const terms = reopenTerminals(db)
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined
  if (!row) return terms
  let saved: { at: number; ids: string[] }
  try {
    saved = JSON.parse(row.value)
  } catch {
    return terms
  }
  if (!Array.isArray(saved.ids) || Date.now() - saved.at > MAX_AGE) return terms
  const live = readLive()
  let n = terms
  for (const id of saved.ids) {
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id) || live.has(id)) continue // already running somewhere
    const r = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(id) as { cwd: string | null } | undefined
    if (!r?.cwd || !existsSync(r.cwd)) continue
    try {
      startSession(r.cwd, id)
      n++
    } catch {}
  }
  return n
}
