import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR } from './db'

// Spin-off: a side thought becomes its own Claude session in the same folder, without leaving the one you're in.
//   /spinoff <thought>   inside Claude. Mason's hook catches it (Claude never sees it, no turn spent).
//   ⌘⇧N                 in the Open tab, for the focused window.
// The new session starts with your thought as its first message, plus one line on where it came from.

export const SPINOFF_DIR = join(DATA_DIR, 'spinoff')
export const SPINOFF_COMMAND_FILE = join(DATA_DIR, 'spinoff-command.md') // copied to ~/.claude/commands by scripts/hooks.mjs

// Only shown if Mason's hook isn't installed; with the hook, the prompt never reaches Claude.
const SPINOFF_COMMAND = `---
description: Spin a side thought off into a new Claude session in this project (Mason)
argument-hint: <the side thought>
---
<!-- Written by Mason. -->
Reply with exactly this and nothing else: "Mason's hooks aren't installed, so nothing was spun off. Run: node ~/mason/scripts/hooks.mjs install"
`

export function writeSpinoffCommand(): void {
  writeFileSync(SPINOFF_COMMAND_FILE, SPINOFF_COMMAND, { mode: 0o600 })
  mkdirSync(SPINOFF_DIR, { recursive: true, mode: 0o700 })
}

export type Spin = { from: string | null; cwd: string; thought: string }

// Spin-offs caught by the hook since last time. Old ones (Mason wasn't running) are dropped rather than
// surprising you with sessions starting long after you asked.
export function takeSpinoffs(): Spin[] {
  const out: Spin[] = []
  let files: string[] = []
  try {
    files = readdirSync(SPINOFF_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return out
  }
  for (const f of files) {
    const path = join(SPINOFF_DIR, f)
    try {
      const d = JSON.parse(readFileSync(path, 'utf8'))
      rmSync(path)
      const at = Number(f.split('.')[0]) * 1000
      if (!at || Date.now() - at > 10 * 60_000) continue
      if (typeof d.cwd !== 'string' || !d.cwd.startsWith('/')) continue
      const thought = typeof d.prompt === 'string' ? d.prompt.replace(/^\/spinoff\b/i, '').trim() : ''
      const from = typeof d.session_id === 'string' && /^[0-9a-f-]{36}$/.test(d.session_id) ? d.session_id : null
      out.push({ from, cwd: d.cwd, thought: thought.slice(0, 10_000) })
    } catch {
      // half-written; the hook writes atomically, so this is rare
    }
  }
  return out
}

// The first message for the new session, in a file it's started with (nothing needs quoting). Removed after a minute.
export function spinPrompt(thought: string, fromTitle: string | null): string | undefined {
  if (!thought) return undefined
  const context = fromTitle ? `\n\n(This is a side thought I spun off from another session in this project, “${fromTitle}”. Treat it as its own task.)` : ''
  const path = join(SPINOFF_DIR, `prompt-${randomBytes(6).toString('hex')}.md`)
  writeFileSync(path, thought + context, { mode: 0o600 })
  setTimeout(() => rmSync(path, { force: true }), 60_000)
  return path
}
