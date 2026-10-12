import { existsSync } from 'node:fs'
import type { DB } from './db'
import { readLive } from './live'
import { listHosted, SESSION_ID_RE, startSession } from './tmux'

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

// Returns how many sessions were reopened. Does nothing if tmux is still running (Mason only quit or crashed).
export function reopenAfterRestart(db: DB): number {
  if (listHosted().length) return 0
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined
  if (!row) return 0
  let saved: { at: number; ids: string[] }
  try {
    saved = JSON.parse(row.value)
  } catch {
    return 0
  }
  if (!Array.isArray(saved.ids) || Date.now() - saved.at > MAX_AGE) return 0
  const live = readLive()
  let n = 0
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
