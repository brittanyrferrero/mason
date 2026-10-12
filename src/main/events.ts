import { closeSync, existsSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db'

// Claude Code hooks run this script. It records one short line per event and never blocks Claude:
// no network, no output, and it only pulls out the few fields Mason needs (so huge tool payloads aren't copied).
export const HOOK_SCRIPT = join(DATA_DIR, 'hook.sh')
export const EVENTS_FILE = join(DATA_DIR, 'events.jsonl')

const HOOK_TEXT = `#!/bin/sh
# Written by Mason. Records Claude Code hook events so Mason can show which sessions are waiting on you.
dir="$HOME/.mason"
[ -d "$dir" ] || exit 0
umask 077
input=$(cat)
# /stash: hand the prompt to Mason and block it, so Claude never sees it and it costs no turn.
if [ "$1" = UserPromptSubmit ]; then
  case "$input" in
    *'"prompt":"/stash'*|*'"prompt": "/stash'*)
      mkdir -p "$dir/stash"
      tmp="$dir/stash/.$$"
      printf '%s' "$input" > "$tmp" && mv "$tmp" "$dir/stash/$(date +%s).$$.json"
      printf '%s\\n' '{"decision":"block","reason":"Saved to Mason ✓  (not sent to Claude)"}'
      exit 0 ;;
  esac
fi
field() { printf '%s' "$input" | sed -n "s/.*\\"$1\\" *: *\\"\\([^\\"\\\\\\\\]*\\)\\".*/\\1/p" | head -n 1 | tr -d '\\t\\r\\n'; }
printf '%s\\t%s\\t%s\\t%s\\n' "$1" "$(field session_id)" "$(field notification_type)" "$(field message)" >> "$dir/events.jsonl" 2>/dev/null
exit 0
`

export function writeHookScript(): void {
  writeFileSync(HOOK_SCRIPT, HOOK_TEXT, { mode: 0o700 })
}

export type Need = { since: number; message: string }

const needs = new Map<string, Need>()
let offset = 0
// The session you last typed into, so a quick capture can say where the thought came from.
// Only events seen while Mason is running count; replaying the log at startup doesn't.
let caughtUp = false
let lastPrompt: { sid: string; at: number } | null = null
export function lastActiveSession(withinMs: number): string | null {
  return lastPrompt && Date.now() - lastPrompt.at < withinMs ? lastPrompt.sid : null
}

function isWaiting(type: string, message: string): boolean {
  if (type === 'permission_prompt' || type === 'elicitation_dialog') return true
  if (type) return false // idle_prompt, auth_success, …
  // Older Claude Code versions send no type; the 60-second "waiting for your input" nudge isn't a real block.
  return /permission|approve/i.test(message) && !/waiting for your input/i.test(message)
}

function apply(line: string): void {
  const [event, sid, type = '', message = ''] = line.split('\t')
  if (!sid || !/^[0-9a-f-]{36}$/.test(sid)) return
  switch (event) {
    case 'Notification':
      if (isWaiting(type, message)) needs.set(sid, { since: Date.now(), message: message || 'Claude needs you' })
      break
    case 'PreToolUse': // only registered for AskUserQuestion
      needs.set(sid, { since: Date.now(), message: 'Claude has a question for you' })
      break
    case 'UserPromptSubmit':
      if (caughtUp) lastPrompt = { sid, at: Date.now() }
      needs.delete(sid)
      break
    case 'PostToolUse':
    case 'Stop':
    case 'SessionEnd':
      needs.delete(sid)
      break
  }
}

// Reads only what's new. Once the file is fully read and large, it's rotated so it never grows without limit.
export function readEvents(): Map<string, Need> {
  if (!existsSync(EVENTS_FILE)) return needs
  const size = statSync(EVENTS_FILE).size
  if (size < offset) offset = 0
  if (size > offset) {
    const fd = openSync(EVENTS_FILE, 'r')
    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    closeSync(fd)
    const end = buf.lastIndexOf(0x0a) + 1
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) if (line) apply(line)
    offset += end
  }
  caughtUp = true
  if (offset > 1_000_000 && offset === size) {
    renameSync(EVENTS_FILE, EVENTS_FILE + '.old')
    offset = 0
  }
  return needs
}

// Forget sessions that are no longer running.
export function pruneNeeds(live: Set<string>): void {
  for (const id of needs.keys()) if (!live.has(id)) needs.delete(id)
}
