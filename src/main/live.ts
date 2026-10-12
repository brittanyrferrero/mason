import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CLAUDE_SESSIONS = join(homedir(), '.claude', 'sessions')

type Copy = { pid: number; status: 'working' | 'idle'; tty?: string; tmux?: string }
// One running conversation. `extra` holds any further copies of it (the same conversation resumed in two places).
export type LiveInfo = Copy & { name?: string; cwd?: string; copies: number; extra: Copy[] }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

// Claude Code keeps a small status file per running session in ~/.claude/sessions/<pid>.json.
// It isn't a documented interface, so anything unexpected is treated as "not live".
// Hooks (step 3) will add the "waiting on you" state on top of this.
export function readLive(): Map<string, LiveInfo> {
  const live = new Map<string, LiveInfo>()
  let files: string[] = []
  try {
    files = readdirSync(CLAUDE_SESSIONS).filter((f) => /^\d+\.json$/.test(f))
  } catch {
    return live
  }
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(CLAUDE_SESSIONS, f), 'utf8'))
      if (typeof d.sessionId !== 'string' || typeof d.pid !== 'number' || !alive(d.pid)) continue
      // The same conversation can be resumed in two places at once; count the copies so nothing acts on it blindly.
      // Claude records its tmux pane ("ms-1234abcd:@6.%6"), which names the Mason shell it's in.
      const copy: Copy = { pid: d.pid, status: d.status === 'busy' ? 'working' : 'idle', tmux: typeof d.tmux === 'string' ? d.tmux.split(':')[0] : undefined }
      const prev = live.get(d.sessionId)
      if (prev) prev.copies++, prev.extra.push(copy)
      else live.set(d.sessionId, { ...copy, name: d.name, cwd: d.cwd, copies: 1, extra: [] })
    } catch {
      // half-written file; next pass will catch it
    }
  }
  // One ps call for every live session's terminal, so we know which window each one is in.
  if (live.size) {
    try {
      const copies = [...live.values()].flatMap((l) => [l, ...l.extra])
      const out = execFileSync('ps', ['-o', 'pid=,tty=', '-p', copies.map((c) => c.pid).join(',')], { encoding: 'utf8', timeout: 2000 })
      const ttys = new Map(out.trim().split('\n').map((l) => l.trim().split(/\s+/) as [string, string]))
      for (const c of copies) {
        const t = ttys.get(String(c.pid))
        if (t && /^ttys\d+$/.test(t)) c.tty = t
      }
    } catch {}
  }
  return live
}
