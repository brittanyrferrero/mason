import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CLAUDE_SESSIONS = join(homedir(), '.claude', 'sessions')

export type LiveInfo = { pid: number; status: 'working' | 'idle'; name?: string; tty?: string; cwd?: string }

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
      live.set(d.sessionId, { pid: d.pid, status: d.status === 'busy' ? 'working' : 'idle', name: d.name, cwd: d.cwd })
    } catch {
      // half-written file; next pass will catch it
    }
  }
  // One ps call for every live session's terminal, so we know which window each one is in.
  if (live.size) {
    try {
      const out = execFileSync('ps', ['-o', 'pid=,tty=', '-p', [...live.values()].map((l) => l.pid).join(',')], { encoding: 'utf8', timeout: 2000 })
      const ttys = new Map(out.trim().split('\n').map((l) => l.trim().split(/\s+/) as [string, string]))
      for (const l of live.values()) {
        const t = ttys.get(String(l.pid))
        if (t && /^ttys\d+$/.test(t)) l.tty = t
      }
    } catch {}
  }
  return live
}
