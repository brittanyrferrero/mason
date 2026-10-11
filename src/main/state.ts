import type { DB } from './db'
import type { Need } from './events'
import type { LiveInfo } from './live'
import type { Hosted } from './tmux'

export type SessionStatus = 'working' | 'needs' | 'idle'

export type SessionView = {
  id: string // Claude session id, or "tmux:<name>" for a Mason shell where Claude isn't running (yet)
  title: string
  now: string
  status: SessionStatus
  branch: string | null
  lastActivity: number
  host: string | null // tmux session name when it lives inside Mason; null when it's in a Terminal window
}

export type PausedView = { id: string; title: string; project: string; pickUp: string; lastActivity: number }

export type AppState = {
  projects: { id: number; name: string; sessions: SessionView[] }[]
  paused: PausedView[]
  ideas: { id: number; body: string; from: string }[]
  canHost: boolean
}

// Closed sessions from the last month are resumable; only the most recent few are shown to keep the panel short.
const RECENT_MS = 30 * 24 * 60 * 60 * 1000
const PAUSED_LIMIT = 10

function oneLine(text: string | null, max = 140): string {
  if (!text) return ''
  const line =
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim())
      .find((l) => l.length > 0) ?? ''
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line
}

type Row = {
  id: string
  project_id: number
  project: string
  branch: string | null
  ai_title: string | null
  first_prompt: string | null
  last_text: string | null
  last_prompt: string | null
  last_activity: number | null
}

export function buildState(
  db: DB,
  live: Map<string, LiveInfo>,
  needs: Map<string, Need>,
  hosted: Hosted[],
  projectFor: (cwd: string) => { id: number; name: string },
  canHost: boolean
): AppState {
  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, p.name AS project, s.branch, s.ai_title, s.first_prompt, s.last_text, s.last_prompt, s.last_activity
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE (s.last_activity > ? AND COALESCE(s.entrypoint, 'cli') NOT LIKE 'sdk%') OR s.id IN (SELECT value FROM json_each(?))
       ORDER BY s.last_activity DESC`
    )
    .all(Date.now() - RECENT_MS, JSON.stringify([...live.keys()])) as Row[]

  const hostByTty = new Map(hosted.map((h) => [h.tty, h.name]))
  const claimed = new Set<string>()
  const title = (r: Row) => r.ai_title || oneLine(r.first_prompt, 60) || 'New session'
  const byProject = new Map<number, { id: number; name: string; sessions: SessionView[] }>()
  const add = (pid: number, name: string, s: SessionView) => {
    if (!byProject.has(pid)) byProject.set(pid, { id: pid, name, sessions: [] })
    byProject.get(pid)!.sessions.push(s)
  }
  const paused: PausedView[] = []
  const seen = new Set<string>()

  for (const r of rows) {
    seen.add(r.id)
    const l = live.get(r.id)
    if (!l) {
      if (paused.length >= PAUSED_LIMIT) continue
      paused.push({
        id: r.id,
        title: title(r),
        project: r.project,
        pickUp: oneLine(r.last_text) || oneLine(r.last_prompt),
        lastActivity: r.last_activity ?? 0
      })
      continue
    }
    const host = (l.tty && hostByTty.get(l.tty)) || null
    if (host) claimed.add(host)
    const need = needs.get(r.id)
    add(r.project_id, r.project, {
      id: r.id,
      title: title(r),
      now: need?.message ?? (oneLine(r.last_text) || oneLine(r.last_prompt)),
      status: need ? 'needs' : l.status,
      branch: r.branch && r.branch !== 'HEAD' ? r.branch : null,
      lastActivity: r.last_activity ?? 0,
      host
    })
  }

  // A brand-new Claude has no transcript for a moment; still show the row so "+ New session" feels instant.
  for (const [id, l] of live) {
    if (seen.has(id) || !l.cwd) continue
    const host = (l.tty && hostByTty.get(l.tty)) || null
    if (host) claimed.add(host)
    const p = projectFor(l.cwd)
    const need = needs.get(id)
    add(p.id, p.name, { id, title: 'New session', now: need?.message ?? 'Say hi to get started', status: need ? 'needs' : l.status, branch: null, lastActivity: Date.now(), host })
  }
  // Mason shells where Claude isn't running (just started, or you typed /exit).
  for (const h of hosted) {
    if (claimed.has(h.name)) continue
    // Usually Claude is starting or waiting on its first question (like "trust this folder?").
    const p = projectFor(h.cwd)
    add(p.id, p.name, {
      id: `tmux:${h.name}`,
      title: 'New session',
      now: 'Open it to get going',
      status: 'idle',
      branch: null,
      lastActivity: h.created,
      host: h.name
    })
  }

  const ideas = db
    .prepare(
      `SELECT n.id, n.body, COALESCE(s.ai_title, 'a session') AS "from" FROM notes n LEFT JOIN sessions s ON s.id = n.session_id
       WHERE n.kind = 'idea' ORDER BY n.created_at DESC`
    )
    .all() as AppState['ideas']

  // Anything waiting on you comes first in its project.
  const projects = [...byProject.values()]
  for (const p of projects) p.sessions.sort((a, b) => Number(b.status === 'needs') - Number(a.status === 'needs'))
  return { projects, paused, ideas, canHost }
}
