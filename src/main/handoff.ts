import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, type DB } from './db'

// Handoffs: /pause inside Claude writes a note so you (or a fresh session) can pick up exactly where it stopped.
// Claude runs pause.sh, which drops the note in ~/.mason/handoffs; Mason files it and then stops the session.

export const HANDOFF_DIR = join(DATA_DIR, 'handoffs')
export const PAUSE_SCRIPT = join(DATA_DIR, 'pause.sh')
export const PAUSE_COMMAND_FILE = join(DATA_DIR, 'pause-command.md') // copied to ~/.claude/commands by scripts/hooks.mjs

// Finds which Claude it was run from by walking up to the nearest process that has a Claude status file.
const PAUSE_TEXT = `#!/bin/sh
# Written by Mason. Claude's /pause command runs this to save a handoff note; Mason then stops the session.
dir="$HOME/.mason/handoffs"
mkdir -p "$dir" && chmod 700 "$dir"
umask 077
pid=$PPID
sid=""
while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
  f="$HOME/.claude/sessions/$pid.json"
  if [ -f "$f" ]; then
    sid=$(sed -n 's/.*"sessionId" *: *"\\([0-9a-f-]*\\)".*/\\1/p' "$f" | head -n 1)
    break
  fi
  pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
done
if [ -z "$sid" ]; then
  echo "Couldn't tell which Claude session this is, so the handoff wasn't saved."
  exit 1
fi
tmp="$dir/.$sid.$$"
{ printf '%s\\n%s\\n' "$sid" "$pid"; cat; } > "$tmp" && mv "$tmp" "$dir/$sid.$(date +%s).handoff"
if pgrep -xq Mason; then
  echo "Handoff saved. Mason will stop this session in a few seconds; pick it up again from Mason's paused list."
else
  echo "Handoff saved. Mason isn't running, so this session wasn't stopped; Mason will file the note next time it opens."
fi
`

// The /pause slash command itself (installed into ~/.claude/commands by scripts/hooks.mjs).
export const PAUSE_COMMAND = `---
description: Pause this session in Mason - write a handoff note, then stop
---
<!-- Written by Mason. -->
Pause this session. Write a handoff so that I, or a brand-new Claude session with none of this context, can pick up exactly where we are stopping.

Save it by running this one command, filling in the three parts (keep the two marker lines exactly as written):

~/.mason/pause.sh <<'MASON_HANDOFF'
STOPPED: <one short sentence: where things stand right now>
NEXT: <one short sentence: the very next step>
---
<A brief for a fresh session, in markdown, under 300 words: the goal, what's done, what's left, key files and decisions, anything I was unsure about, and the first thing to do.>
MASON_HANDOFF

Then reply with just "Paused." Do not do any other work after running it.
`

export function writePauseScript(): void {
  writeFileSync(PAUSE_SCRIPT, PAUSE_TEXT, { mode: 0o700 })
  writeFileSync(PAUSE_COMMAND_FILE, PAUSE_COMMAND, { mode: 0o600 })
  mkdirSync(HANDOFF_DIR, { recursive: true, mode: 0o700 })
  chmodSync(HANDOFF_DIR, 0o700)
}

export type Handoff = { stopped: string; next: string; brief: string; at: number }

// Files every new handoff note. Returns the ones fresh enough that their session should be stopped now
// (an old note found at startup is only filed, never acted on).
export function takeHandoffs(db: DB): { sid: string; pid: number }[] {
  const stop: { sid: string; pid: number }[] = []
  let files: string[] = []
  try {
    files = readdirSync(HANDOFF_DIR).filter((f) => f.endsWith('.handoff'))
  } catch {
    return stop
  }
  for (const f of files) {
    const path = join(HANDOFF_DIR, f)
    try {
      const [sid, pidLine, ...rest] = readFileSync(path, 'utf8').split('\n')
      const at = Number(f.split('.')[1]) * 1000
      if (!/^[0-9a-f-]{36}$/.test(sid)) {
        rmSync(path)
        continue
      }
      // The transcript may not be read in yet; leave the note for the next pass.
      if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sid)) {
        if (Date.now() - at > 10 * 60_000) rmSync(path)
        continue
      }
      const body = rest.join('\n')
      const field = (name: string) => body.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1].trim().slice(0, 300) ?? ''
      const brief = (body.split(/^---\s*$/m)[1] ?? '').trim().slice(0, 20_000)
      db.prepare(
        "INSERT INTO handoffs (session_id, source, stopped, next_step, resume_prompt, created_at) VALUES (?, 'pause', ?, ?, ?, ?)"
      ).run(sid, field('STOPPED'), field('NEXT'), brief, at)
      rmSync(path)
      const pid = Number(pidLine)
      if (Date.now() - at < 2 * 60_000 && Number.isInteger(pid) && pid > 1) stop.push({ sid, pid })
    } catch {
      // half-written or unreadable; try again next pass
    }
  }
  return stop
}

// The latest handoff for each session, as long as nothing has happened in that session since
// (a few minutes of slack for Claude's own "Paused." reply).
export function readHandoffs(db: DB): Map<string, Handoff> {
  const rows = db
    .prepare(
      `SELECT h.session_id, h.stopped, h.next_step, h.resume_prompt, h.created_at FROM handoffs h
       JOIN sessions s ON s.id = h.session_id
       WHERE h.created_at = (SELECT MAX(created_at) FROM handoffs WHERE session_id = h.session_id)
         AND COALESCE(s.last_activity, 0) < h.created_at + 5 * 60_000`
    )
    .all() as { session_id: string; stopped: string | null; next_step: string | null; resume_prompt: string | null; created_at: number }[]
  return new Map(rows.map((r) => [r.session_id, { stopped: r.stopped ?? '', next: r.next_step ?? '', brief: r.resume_prompt ?? '', at: r.created_at }]))
}

export function editHandoff(db: DB, sid: string, brief: string): boolean {
  const r = db.prepare('SELECT id FROM handoffs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sid) as { id: number } | undefined
  if (!r) return false
  db.prepare('UPDATE handoffs SET resume_prompt = ? WHERE id = ?').run(brief.slice(0, 20_000), r.id)
  return true
}

// Fresh start: the brief goes in a file the new Claude is started with, so nothing has to be typed or quoted.
export function briefFile(sid: string, brief: string): string {
  const path = join(HANDOFF_DIR, `fresh-${sid}.md`)
  writeFileSync(path, brief, { mode: 0o600 })
  return path
}

