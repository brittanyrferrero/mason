import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DB } from './db'
import { DATA_DIR } from './db'
import type { Need } from './events'
import type { LiveInfo } from './live'
import { capturePane, listHosted, pasteText, sendLine } from './tmux'

// When Claude Code updates itself, every running session keeps the old version until it's restarted, and each one
// says so in its footer. Instead, Mason quietly restarts its own sessions onto the new version once they've been idle
// for a while, keeping the conversation (claude --resume) and putting back anything you'd half-typed in the prompt.
// A session whose prompt Mason can't read cleanly is left alone rather than risk losing a draft.

const IDLE_MS = 2 * 60_000 // quiet this long (no Claude activity, no typing) before it's restarted
const RETRY_MS = 30 * 60_000 // after a session couldn't be restarted, leave it alone this long
const DRAFTS = join(DATA_DIR, 'drafts')

export const autoUpdateOn = (db: DB) =>
  (db.prepare("SELECT value FROM settings WHERE key = 'claudeAutoUpdate'").get() as { value: string } | undefined)?.value !== 'off'

// ---- which Claude is installed ----
const CLAUDE = [`${homedir()}/.local/bin/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(existsSync) ?? null
let installed: { version: string; stamp: string } | null = null
export function installedClaude(): string | null {
  if (!CLAUDE) return null
  try {
    // The launcher is a link that moves to the new version when Claude updates, so its target changing means "look again".
    const target = realpathSync(CLAUDE)
    const stamp = `${target}:${statSync(target).mtimeMs}`
    if (installed?.stamp !== stamp) {
      const out = execFileSync(target, ['--version'], { encoding: 'utf8', timeout: 8000 })
      const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1]
      if (version) installed = { version, stamp }
    }
  } catch {}
  return installed?.version ?? null
}

export function older(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

// ---- reading what's typed in Claude's prompt ----
// Claude's input box is the "❯" line between two grey rules (a rule may carry a label, like the session name).
// Returns the draft ('' when the box is empty), or null when the screen doesn't look like that (then nothing happens).
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g
const RULE = /^\s*─{6,}/
export function readDraft(name: string): string | null {
  let raw: string
  try {
    raw = capturePane(name, true)
  } catch {
    return null
  }
  const withColor = raw.replace(/\s+$/, '').split('\n')
  const plain = withColor.map((l) => l.replace(ANSI, '').replace(/ /g, ' '))
  let at = -1
  for (let i = plain.length - 1; i >= 0; i--) if (/^\s*❯/.test(plain[i])) { at = i; break }
  if (at < 0) return null
  let top = at - 1
  while (top >= 0 && !RULE.test(plain[top])) top--
  let bottom = at + 1
  while (bottom < plain.length && !RULE.test(plain[bottom])) bottom++
  if (top < 0 || bottom >= plain.length || bottom - top > 40) return null
  // Grey text right after the ❯ is one of Claude's suggestions, not something you typed.
  const afterPrompt = withColor[at].slice(withColor[at].indexOf('❯') + 1)
  if (/^\s*(\x1b\[[0-9;]*m)*\x1b\[(?:2|90|38;5;24[0-9]|38;5;25[0-5])m\S/.test(afterPrompt)) return ''
  const lines = plain.slice(at, bottom).map((l, i) => (i === 0 ? l.replace(/^\s*❯\s?/, '') : l.replace(/^ {2}/, '')).replace(/\s+$/, ''))
  return lines.join('\n').trim()
}

// ---- restarting one session ----
const waitFor = async (ok: () => boolean, ms: number) => {
  for (let t = 0; t < ms; t += 250) {
    if (ok()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return ok()
}
const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (e: any) {
    return e?.code !== 'EPERM'
  }
}

export type RestartResult = 'restarted' | 'restarted-draft' | 'skipped' | 'draft-not-restored' | 'failed'

export async function restartSession(name: string, sid: string, pid: number, readLive: () => Map<string, LiveInfo>): Promise<RestartResult> {
  const draft = readDraft(name)
  if (draft === null) return 'skipped'
  // Keep a copy of the draft no matter what happens next.
  let saved = ''
  if (draft) {
    mkdirSync(DRAFTS, { recursive: true, mode: 0o700 })
    saved = join(DRAFTS, `${sid}-${Date.now()}.txt`)
    writeFileSync(saved, draft, { mode: 0o600 })
  }
  process.kill(pid, 'SIGTERM')
  if (!(await waitFor(() => gone(pid), 10_000))) return 'failed'
  await new Promise((r) => setTimeout(r, 500)) // let the shell print its prompt
  sendLine(name, `claude --resume ${sid}`)
  const back = await waitFor(() => {
    const l = readLive().get(sid)
    return !!l && l.pid !== pid && readDraft(name) !== null
  }, 45_000)
  if (!back) return 'failed'
  if (!draft) return 'restarted'
  await new Promise((r) => setTimeout(r, 400))
  pasteText(name, draft) // a bracketed paste: line breaks stay in the prompt, nothing is sent
  const restored = await waitFor(() => (readDraft(name) ?? '').replace(/\s+/g, ' ') === draft.replace(/\s+/g, ' '), 4000)
  return restored ? 'restarted-draft' : 'draft-not-restored'
}

// ---- the quiet background loop ----
export type ClaudeUpdateView = { latest: string; behindHere: number; behindTerminal: number } | null

const lastTyped = new Map<string, number>() // Mason session name -> when you last typed in it
export const noteTyping = (name: string) => lastTyped.set(name, Date.now())
const backoff = new Map<string, number>() // session id -> don't try again before this time
let busy = false

export function behind(live: Map<string, LiveInfo>): { latest: string | null; here: [string, LiveInfo, string][]; terminal: number } {
  const latest = installedClaude()
  const hosted = new Set(listHosted().map((h) => h.name))
  const here: [string, LiveInfo, string][] = []
  let terminal = 0
  for (const [sid, l] of live) {
    if (!older(l.version, latest)) continue
    if (l.tmux && hosted.has(l.tmux) && l.copies === 1) here.push([sid, l, l.tmux])
    else terminal++
  }
  return { latest, here, terminal }
}

export function updateView(live: Map<string, LiveInfo>): ClaudeUpdateView {
  const b = behind(live)
  return b.latest && (b.here.length || b.terminal) ? { latest: b.latest, behindHere: b.here.length, behindTerminal: b.terminal } : null
}

export function startClaudeUpdater(opts: {
  db: DB
  readLive: () => Map<string, LiveInfo>
  needs: () => Map<string, Need>
  notice: (text: string) => void
  changed: () => void
}): void {
  setInterval(async () => {
    if (busy || !autoUpdateOn(opts.db)) return
    const live = opts.readLive()
    const now = Date.now()
    const ready = behind(live).here.find(
      ([sid, l, name]) =>
        l.status === 'idle' &&
        now - (l.since ?? now) >= IDLE_MS &&
        now - (lastTyped.get(name) ?? 0) >= IDLE_MS &&
        !opts.needs().has(sid) &&
        now >= (backoff.get(sid) ?? 0)
    )
    if (!ready) return
    const [sid, l, name] = ready
    busy = true
    try {
      const result = await restartSession(name, sid, l.pid, opts.readLive)
      if (result === 'skipped' || result === 'failed') backoff.set(sid, Date.now() + RETRY_MS)
      if (result === 'draft-not-restored') opts.notice('A session restarted onto the new Claude, but its draft didn’t come back. It’s saved in ~/.mason/drafts.')
      if (result === 'failed') opts.notice('Couldn’t restart a session onto the new Claude. It’s still running as it was.')
    } finally {
      busy = false
      opts.changed()
    }
  }, 30_000)
}
