import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DATA_DIR, type DB } from './db'
import { CLAUDE_PROJECTS, textOf } from './ingest'

// /stash inside Claude parks something in Mason without derailing the session.
// Mason's UserPromptSubmit hook catches the prompt, drops it in ~/.mason/stash, and blocks it,
// so Claude never sees it and it costs no turn. Mason files it here.
//   /stash              Claude's last reply
//   /stash 2            the reply before that
//   /stash idea <text>  an idea to spin off later (plain "/stash <text>" means the same)
//   /stash later <text> something to come back to

export const STASH_DIR = join(DATA_DIR, 'stash')
export const STASH_COMMAND_FILE = join(DATA_DIR, 'stash-command.md') // copied to ~/.claude/commands by scripts/hooks.mjs

// Only shown if Mason's hook isn't installed; with the hook, the prompt never reaches Claude.
const STASH_COMMAND = `---
description: Save to Mason - Claude's last reply, or "idea …" / "later …"
argument-hint: [idea|later|2] [text]
---
<!-- Written by Mason. -->
Reply with exactly this and nothing else: "Mason's hooks aren't installed, so that wasn't saved. Run: node ~/mason/scripts/hooks.mjs install"
`

export function writeStashCommand(): void {
  writeFileSync(STASH_COMMAND_FILE, STASH_COMMAND, { mode: 0o600 })
  mkdirSync(STASH_DIR, { recursive: true, mode: 0o700 })
}

// Claude's replies, newest last, read from the end of the transcript (the last 4 MB is plenty).
function lastReplies(transcript: string, want: number): string[] {
  const size = statSync(transcript).size
  const start = Math.max(0, size - 4_000_000)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(transcript, 'r')
  readSync(fd, buf, 0, buf.length, start)
  closeSync(fd)
  const replies: string[] = []
  const lines = buf.toString('utf8').split('\n')
  for (let i = lines.length - 1; i >= 0 && replies.length < want; i--) {
    try {
      const rec = JSON.parse(lines[i])
      if (rec.type !== 'assistant' || rec.isSidechain) continue
      const text = textOf(rec.message?.content).trim()
      if (text) replies.unshift(text)
    } catch {
      // partial first line from slicing, or a malformed one
    }
  }
  return replies
}

function parse(prompt: string, transcript: string | null): { kind: string; body: string } | null {
  const rest = prompt.replace(/^\/stash\b/i, '').trim()
  const tagged = /^(idea|later)\b[:\s]*([\s\S]*)$/i.exec(rest)
  const reply = (n: number) => {
    if (!transcript) return ''
    const r = lastReplies(transcript, n)
    return r.length >= n ? r[r.length - n] : ''
  }
  if (tagged) return { kind: tagged[1].toLowerCase(), body: tagged[2].trim() || reply(1) }
  if (/^\d{1,2}$/.test(rest)) return { kind: 'message', body: reply(Number(rest)) }
  if (rest) return { kind: 'idea', body: rest }
  return { kind: 'message', body: reply(1) }
}

// Files every stashed item. Returns how many were saved.
export function takeStashes(db: DB): number {
  let files: string[] = []
  try {
    files = readdirSync(STASH_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return 0
  }
  let saved = 0
  for (const f of files) {
    const path = join(STASH_DIR, f)
    try {
      const d = JSON.parse(readFileSync(path, 'utf8'))
      const sid = typeof d.session_id === 'string' && /^[0-9a-f-]{36}$/.test(d.session_id) ? d.session_id : null
      const prompt = typeof d.prompt === 'string' ? d.prompt : ''
      // Only read transcripts where Claude Code keeps them.
      const t = typeof d.transcript_path === 'string' ? resolve(d.transcript_path) : ''
      const transcript = t.startsWith(CLAUDE_PROJECTS + '/') && t.endsWith('.jsonl') ? t : null
      const at = Number(f.split('.')[0]) * 1000 || Date.now()
      // The session may not be read in yet; wait a little so the note can say where it came from.
      const known = sid && db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sid)
      if (sid && !known && Date.now() - at < 60_000) continue
      const item = parse(prompt, transcript)
      if (item?.body) {
        db.prepare('INSERT INTO notes (session_id, kind, body, created_at) VALUES (?, ?, ?, ?)').run(known ? sid : null, item.kind, item.body.slice(0, 20_000), at)
        saved++
      }
      rmSync(path)
    } catch {
      // half-written; try again next pass (the hook writes atomically, so this is rare)
      try {
        if (Date.now() - statSync(path).mtimeMs > 60_000) rmSync(path)
      } catch {}
    }
  }
  return saved
}
