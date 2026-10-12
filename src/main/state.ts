import type { DB } from './db'
import type { Need } from './events'
import type { LiveInfo } from './live'
import { readHandoffs } from './handoff'
import { readSummaries, summariesOn } from './summarize'
import { peek, type Hosted } from './tmux'

export type SessionStatus = 'working' | 'needs' | 'idle'

export type SessionView = {
  id: string // Claude session id, or "tmux:<name>" for a Mason shell where Claude isn't running (yet)
  title: string
  now: string
  status: SessionStatus
  branch: string | null
  lastActivity: number
  host: string | null // tmux session name when it lives inside Mason; null when it's in a Terminal window
  pinned: boolean
  next?: string // from the summary: the very next step
  myNote?: string
}

export type PausedView = {
  id: string
  title: string
  project: string
  pickUp: string
  next?: string
  myNote?: string
  handoff?: { stopped: string; next: string; brief: string } // from /pause
  lastActivity: number
}

export type AppState = {
  projects: { id: number; name: string; sessions: SessionView[]; myNote?: string }[]
  paused: PausedView[]
  ideas: { id: number; body: string; from: string }[]
  canHost: boolean
  summaries: boolean
  scratch: string
}

// Closed sessions from the last month are resumable; only the most recent few are shown to keep the panel short.
const RECENT_MS = 30 * 24 * 60 * 60 * 1000
const PAUSED_LIMIT = 25

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
  const hostNames = new Set(hosted.map((h) => h.name))
  const hostOf = (c: { tty?: string; tmux?: string }) => (c.tmux && hostNames.has(c.tmux) ? c.tmux : (c.tty && hostByTty.get(c.tty)) || null)
  const claimed = new Set<string>()
  const prefs = new Map(
    (db.prepare('SELECT session_id, name, pinned FROM session_prefs').all() as { session_id: string; name: string | null; pinned: number }[]).map((p) => [p.session_id, p])
  )
  const pinned = (id: string) => !!prefs.get(id)?.pinned
  // Your own name wins; then Claude's summary (it keeps up as the work drifts); then Claude Code's first-prompt title.
  const sums = readSummaries(db)
  const myNotes = new Map((db.prepare('SELECT target, body FROM my_notes').all() as { target: string; body: string }[]).map((n) => [n.target, n.body]))
  const myNote = (id: string) => myNotes.get(`s:${id}`)
  const handoffs = readHandoffs(db)
  const title = (r: Pick<Row, 'id' | 'ai_title' | 'first_prompt'>) => prefs.get(r.id)?.name || sums.get(r.id)?.title || r.ai_title || oneLine(r.first_prompt, 60) || 'New session'
  const byProject = new Map<number, AppState['projects'][number]>()
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
        // A /pause handoff is Claude's own word on where it stopped, so it beats the summary.
        pickUp: handoffs.get(r.id)?.stopped || sums.get(r.id)?.doing || oneLine(r.last_text) || oneLine(r.last_prompt),
        next: handoffs.get(r.id)?.next || sums.get(r.id)?.next || undefined,
        handoff: handoffs.get(r.id),
        myNote: myNote(r.id),
        lastActivity: r.last_activity ?? 0
      })
      continue
    }
    const host = hostOf(l)
    if (host) claimed.add(host)
    const need = needs.get(r.id)
    // Further copies of the same conversation in Mason get their own row, so you can open or end each one.
    for (const c of l.extra) {
      const h = hostOf(c)
      if (!h) continue
      claimed.add(h)
      add(r.project_id, r.project, {
        id: `tmux:${h}`,
        title: title(r),
        now: 'Another copy of this conversation. End the ones you don’t need.',
        status: c.status,
        branch: null,
        lastActivity: r.last_activity ?? 0,
        host: h,
        pinned: false
      })
    }
    add(r.project_id, r.project, {
      id: r.id,
      title: title(r),
      // While Claude works, its latest words are the freshest news; once it stops, the recap says where you were.
      now:
        l.copies > 1
          ? `Running in ${l.copies} places at once`
          : (need?.message ?? ((l.status !== 'working' && sums.get(r.id)?.doing) || oneLine(r.last_text) || oneLine(r.last_prompt))),
      next: !need && l.status !== 'working' ? sums.get(r.id)?.next || undefined : undefined,
      myNote: myNote(r.id),
      status: need ? 'needs' : l.status,
      branch: r.branch && r.branch !== 'HEAD' ? r.branch : null,
      lastActivity: r.last_activity ?? 0,
      host,
      pinned: pinned(r.id)
    })
  }

  // A brand-new Claude has no transcript for a moment; still show the row so "+ New session" feels instant.
  for (const [id, l] of live) {
    if (seen.has(id) || !l.cwd) continue
    const host = hostOf(l)
    if (host) claimed.add(host)
    const p = projectFor(l.cwd)
    const need = needs.get(id)
    add(p.id, p.name, { id, title: 'New session', now: need?.message ?? 'Say hi to get started', status: need ? 'needs' : l.status, branch: null, lastActivity: Date.now(), host, pinned: pinned(id) })
  }
  // Mason shells where Claude isn't running: still starting, stuck on its first question, or exited.
  for (const h of hosted) {
    if (claimed.has(h.name)) continue
    const p = projectFor(h.cwd)
    const r = h.resume ? (db.prepare('SELECT id, ai_title, first_prompt FROM sessions WHERE id = ?').get(h.resume) as Pick<Row, 'id' | 'ai_title' | 'first_prompt'> | undefined) : undefined
    const seen = peek(h.name)
    add(p.id, p.name, {
      id: `tmux:${h.name}`,
      title: r ? title(r) : 'New session',
      now: seen === 'trust' ? 'Asking whether to trust this folder' : seen === 'shell' ? 'Claude isn’t running here' : 'Starting Claude…',
      status: seen === 'trust' ? 'needs' : 'idle',
      branch: null,
      lastActivity: h.created,
      host: h.name,
      pinned: false
    })
  }

  const ideas = db
    .prepare(
      `SELECT n.id, n.body, COALESCE(sp.name, s.ai_title, 'a session') AS "from" FROM notes n
       LEFT JOIN sessions s ON s.id = n.session_id LEFT JOIN session_prefs sp ON sp.session_id = n.session_id
       WHERE n.kind = 'idea' ORDER BY n.created_at DESC`
    )
    .all() as AppState['ideas']

  // Pinned sessions lead their project; within that, anything waiting on you comes first.
  const projects = [...byProject.values()]
  const rank = (s: SessionView) => (s.pinned ? 2 : 0) + (s.status === 'needs' ? 1 : 0)
  for (const p of projects) p.sessions.sort((a, b) => rank(b) - rank(a))
  for (const p of projects) p.myNote = myNotes.get(`p:${p.id}`)
  return { projects, paused, ideas, canHost, summaries: summariesOn(db), scratch: myNotes.get('scratch') ?? '' }
}
