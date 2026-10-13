import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { DB } from './db'
import { projectIdFor, workProjectIdFor } from './projects'

export const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')

type Patch = {
  cwd?: string
  entrypoint?: string
  branch?: string
  ai_title?: string
  first_prompt?: string
  last_prompt?: string
  last_text?: string
  pr_url?: string
  started_at?: number
  last_activity?: number
  dirs: Map<string, number> // records per working folder in this chunk
}

// Pull plain text out of a message's content (a string or an array of blocks).
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

// Skip harness plumbing that shows up as user messages (command echoes, reminders, tool output).
function isRealPrompt(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && !t.startsWith('<') && !t.startsWith('[Request interrupted')
}

function applyRecord(rec: any, patch: Patch): void {
  if (rec.isSidechain) return
  // A session belongs to the folder it started in (but see followRepo for ones started in ~).
  if (typeof rec.cwd === 'string') {
    patch.cwd ??= rec.cwd
    patch.dirs.set(rec.cwd, (patch.dirs.get(rec.cwd) ?? 0) + 1)
  }
  if (typeof rec.entrypoint === 'string') patch.entrypoint ??= rec.entrypoint
  if (typeof rec.gitBranch === 'string' && rec.gitBranch) patch.branch = rec.gitBranch
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN

  switch (rec.type) {
    case 'ai-title':
      if (typeof rec.aiTitle === 'string') patch.ai_title = rec.aiTitle
      break
    case 'pr-link':
      if (typeof rec.prUrl === 'string') patch.pr_url = rec.prUrl
      break
    case 'user': {
      if (rec.isMeta) break
      const text = textOf(rec.message?.content)
      if (!isRealPrompt(text)) break
      patch.first_prompt ??= text
      patch.last_prompt = text
      if (!Number.isNaN(ts)) patch.last_activity = ts
      break
    }
    case 'assistant': {
      const text = textOf(rec.message?.content).trim()
      if (text) patch.last_text = text
      if (!Number.isNaN(ts)) patch.last_activity = ts
      break
    }
  }
  if (!Number.isNaN(ts)) patch.started_at ??= ts
}

function ingestFile(db: DB, path: string): boolean {
  const size = statSync(path).size
  const row = db.prepare('SELECT offset FROM files WHERE path = ?').get(path) as { offset: number } | undefined
  let offset = row?.offset ?? 0
  if (size < offset) offset = 0 // file was rewritten
  if (size === offset) return false

  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(size - offset)
  readSync(fd, buf, 0, buf.length, offset)
  closeSync(fd)

  // Only consume complete lines; a half-written last line waits for the next pass.
  const end = buf.lastIndexOf(0x0a) + 1
  if (end === 0) return false
  const patch: Patch = { dirs: new Map() }
  for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
    if (!line) continue
    try {
      applyRecord(JSON.parse(line), patch)
    } catch {
      // ignore a malformed line rather than stalling the whole file
    }
  }

  const id = basename(path, '.jsonl')
  const existing = db.prepare('SELECT cwd, first_prompt, started_at FROM sessions WHERE id = ?').get(id) as
    | { cwd: string | null; first_prompt: string | null; started_at: number | null }
    | undefined
  const cwd = existing?.cwd ?? patch.cwd ?? null
  const projectId = cwd ? projectIdFor(db, cwd) : null

  db.prepare(
    `INSERT INTO sessions (id, project_id, cwd, entrypoint, branch, ai_title, first_prompt, last_prompt, last_text, pr_url, started_at, last_activity, transcript)
     VALUES (@id, @project_id, @cwd, @entrypoint, @branch, @ai_title, @first_prompt, @last_prompt, @last_text, @pr_url, @started_at, @last_activity, @transcript)
     ON CONFLICT(id) DO UPDATE SET
       project_id    = COALESCE(project_id, excluded.project_id),
       cwd           = COALESCE(cwd, excluded.cwd),
       entrypoint    = COALESCE(entrypoint, excluded.entrypoint),
       branch        = COALESCE(excluded.branch, branch),
       ai_title      = COALESCE(excluded.ai_title, ai_title),
       first_prompt  = COALESCE(first_prompt, excluded.first_prompt),
       last_prompt   = COALESCE(excluded.last_prompt, last_prompt),
       last_text     = COALESCE(excluded.last_text, last_text),
       pr_url        = COALESCE(excluded.pr_url, pr_url),
       started_at    = COALESCE(started_at, excluded.started_at),
       last_activity = MAX(COALESCE(last_activity, 0), COALESCE(excluded.last_activity, 0))`
  ).run({
    id,
    project_id: projectId,
    cwd,
    entrypoint: patch.entrypoint ?? null,
    branch: patch.branch ?? null,
    ai_title: patch.ai_title ?? null,
    first_prompt: patch.first_prompt ?? null,
    last_prompt: patch.last_prompt ?? null,
    last_text: patch.last_text ?? null,
    pr_url: patch.pr_url ?? null,
    started_at: patch.started_at ?? null,
    last_activity: patch.last_activity ?? null,
    transcript: path
  })
  const addDir = db.prepare('INSERT INTO session_dirs (session_id, cwd, n) VALUES (?, ?, ?) ON CONFLICT(session_id, cwd) DO UPDATE SET n = n + excluded.n')
  for (const [dir, n] of patch.dirs) addDir.run(id, dir, n)
  if (cwd === homedir()) followRepo(db, id)
  db.prepare('INSERT INTO files (path, offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset').run(
    path,
    offset + end
  )
  return true
}

// Claude is often started in ~ and then cd's into a project. Such a session belongs to the project it spent the
// most time in, rather than to "Home". Sessions started inside a project folder stay with that project.
function followRepo(db: DB, id: string): void {
  const dirs = db.prepare('SELECT cwd, n FROM session_dirs WHERE session_id = ?').all(id) as { cwd: string; n: number }[]
  const score = new Map<number, number>()
  for (const d of dirs) {
    const pid = workProjectIdFor(db, d.cwd)
    if (pid) score.set(pid, (score.get(pid) ?? 0) + d.n)
  }
  const [best, n] = [...score].sort((a, b) => b[1] - a[1])[0] ?? []
  if (best && n >= 5) db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(best, id)
}

// Reads only what's new since last time. Subagent transcripts live in subfolders and are skipped.
export function ingestAll(db: DB): number {
  let changed = 0
  let dirs: string[] = []
  try {
    dirs = readdirSync(CLAUDE_PROJECTS)
  } catch {
    return 0
  }
  const run = db.transaction(() => {
    for (const dir of dirs) {
      let files: string[] = []
      try {
        files = readdirSync(join(CLAUDE_PROJECTS, dir)).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const f of files) {
        try {
          if (ingestFile(db, join(CLAUDE_PROJECTS, dir, f))) changed++
        } catch {
          // a file vanished mid-read; it'll be picked up (or forgotten) next pass
        }
      }
    }
  })
  run()
  return changed
}
