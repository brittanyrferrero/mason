import { execFile, execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { DB } from './db'
import { DATA_DIR } from './db'
import { cleanEnv } from './tmux'

// Summaries: a few words on what a session is about, and a two-line "where was I?" recap.
// Written by Claude through your own `claude` login (a small, fast model), so there's no API key to manage.
// This is the one thing Mason sends anywhere, and it can be turned off.

const QUIET_MS = 90_000 // wait until a session has been still this long, so it isn't summarized mid-thought
const RECENT_MS = 3 * 24 * 60 * 60 * 1000 // only bother with sessions touched in the last few days
const RETRY_MS = 30 * 60 * 1000 // after a failure, leave it alone for a while
const EXCERPT_CHARS = 12_000

export type Summary = { title: string; doing: string; next: string }

export function initSummaries(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS summaries (
    session_id TEXT PRIMARY KEY,
    title      TEXT,
    doing      TEXT,
    next       TEXT,
    upto       INTEGER NOT NULL DEFAULT 0,  -- the session's last_activity when this was written
    tried_at   INTEGER NOT NULL DEFAULT 0
  )`)
}

export function summariesOn(db: DB): boolean {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'summaries'").get() as { value: string } | undefined
  return r?.value !== 'off'
}

export function setSummaries(db: DB, on: boolean): void {
  db.prepare("INSERT INTO settings (key, value) VALUES ('summaries', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? 'on' : 'off')
}

export function readSummaries(db: DB): Map<string, Summary> {
  const rows = db.prepare('SELECT session_id, title, doing, next FROM summaries WHERE title IS NOT NULL').all() as ({ session_id: string } & Summary)[]
  return new Map(rows.map((r) => [r.session_id, { title: r.title, doing: r.doing, next: r.next }]))
}

// Mason is often launched from the Dock with a bare PATH, so ask your login shell where `claude` lives.
let claudeBin: string | null | undefined
function findClaude(): string | null {
  if (claudeBin !== undefined) return claudeBin
  claudeBin = null
  try {
    const found = execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').pop()
    if (found && existsSync(found)) claudeBin = found
  } catch {}
  for (const p of [`${homedir()}/.local/bin/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (!claudeBin && existsSync(p)) claudeBin = p
  return claudeBin
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

// The conversation as plain "You:" / "Claude:" lines: the opening ask, then as much of the recent end as fits.
function excerpt(path: string): string {
  const size = statSync(path).size
  const start = Math.max(0, size - 2_000_000) // the tail of a long transcript is what matters
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  readSync(fd, buf, 0, buf.length, start)
  closeSync(fd)
  const lines: string[] = []
  for (const line of buf.toString('utf8').split('\n')) {
    try {
      const rec = JSON.parse(line)
      if (rec.isSidechain || rec.isMeta) continue
      const text = textOf(rec.message?.content).trim()
      if (!text) continue
      if (rec.type === 'user' && !text.startsWith('<') && !text.startsWith('[Request interrupted')) lines.push(`You: ${text}`)
      else if (rec.type === 'assistant') lines.push(`Claude: ${text}`)
    } catch {}
  }
  const first = lines.find((l) => l.startsWith('You:'))?.slice(0, 1500) ?? ''
  let tail = ''
  for (let i = lines.length - 1; i >= 0 && tail.length < EXCERPT_CHARS; i--) tail = lines[i].slice(0, 3000) + '\n\n' + tail
  return `${first}\n\n…\n\n${tail}`.slice(-EXCERPT_CHARS - 1600)
}

const PROMPT = `You write tiny status notes for someone with ADHD who juggles many Claude Code sessions and needs to remember where each one was.
Read the conversation excerpt and reply with ONLY a JSON object, no code fence:
{"title": "...", "doing": "...", "next": "..."}
- title: 2-5 words naming what this session is about (e.g. "Room booking cancel flow"). No quotes, no trailing period.
- doing: one short sentence, what was being worked on most recently, in plain words.
- next: one short sentence, the very next step. If Claude ended by asking something, start with "Waiting on you: ". If the work is finished and nothing is left, write exactly "Done for now". Under 15 words.`

function ask(bin: string, input: string): Promise<Summary | null> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['-p', PROMPT, '--model', 'haiku', '--no-session-persistence', '--tools', '', '--output-format', 'json'],
      { cwd: DATA_DIR, env: cleanEnv(), timeout: 90_000, maxBuffer: 4_000_000 },
      (err, stdout) => {
        if (err) return resolve(null)
        try {
          const raw = String(JSON.parse(stdout).result ?? '')
          const s = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
          const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
          const out = { title: clean(s.title, 60), doing: clean(s.doing, 200), next: clean(s.next, 200) }
          resolve(out.title ? out : null)
        } catch {
          resolve(null)
        }
      }
    )
    child.stdin?.end(input)
  })
}

let running = false

// One pass: summarize, one at a time, the sessions that changed since their last summary and have gone quiet.
export async function summarizeDue(db: DB, busy: Set<string>, onDone: () => void): Promise<void> {
  if (running || !summariesOn(db)) return
  const bin = findClaude()
  if (!bin) return
  running = true
  try {
    const now = Date.now()
    const due = db
      .prepare(
        `SELECT s.id, s.transcript, s.last_activity FROM sessions s LEFT JOIN summaries m ON m.session_id = s.id
         WHERE s.last_activity > ? AND s.last_activity < ? AND COALESCE(s.entrypoint, 'cli') NOT LIKE 'sdk%'
           AND s.last_activity > COALESCE(m.upto, 0) AND COALESCE(m.tried_at, 0) < ?
         ORDER BY s.last_activity DESC LIMIT 5`
      )
      .all(now - RECENT_MS, now - QUIET_MS, now - RETRY_MS) as { id: string; transcript: string; last_activity: number }[]
    for (const r of due) {
      if (!summariesOn(db)) break
      if (busy.has(r.id) || !existsSync(r.transcript)) continue
      db.prepare('INSERT INTO summaries (session_id, tried_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET tried_at = excluded.tried_at').run(r.id, Date.now())
      const s = await ask(bin, excerpt(r.transcript))
      if (!s) continue
      db.prepare('UPDATE summaries SET title = ?, doing = ?, next = ?, upto = ? WHERE session_id = ?').run(s.title, s.doing, s.next, r.last_activity, r.id)
      onDone()
    }
  } finally {
    running = false
  }
}
