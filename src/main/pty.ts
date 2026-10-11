import { homedir } from 'node:os'
import * as pty from 'node-pty'
import { baseArgs, cleanEnv, NAME_RE, TMUX } from './tmux'

// One attached tmux client per window in the Open tab. Closing the window only detaches;
// the session keeps running in tmux.
const clients = new Map<string, pty.IPty>()

export function attach(
  name: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: () => void
): boolean {
  if (!TMUX || !NAME_RE.test(name)) return false
  detach(name)
  const p = pty.spawn(TMUX, [...baseArgs(), 'attach-session', '-t', name], {
    name: 'xterm-256color',
    cols: Math.max(20, Math.min(400, cols | 0)),
    rows: Math.max(5, Math.min(200, rows | 0)),
    cwd: homedir(),
    env: cleanEnv() as Record<string, string>
  })
  p.onData(onData)
  p.onExit(() => {
    if (clients.get(name) === p) clients.delete(name)
    onExit()
  })
  clients.set(name, p)
  return true
}

export function write(name: string, data: string): void {
  clients.get(name)?.write(data)
}

export function resize(name: string, cols: number, rows: number): void {
  try {
    clients.get(name)?.resize(Math.max(20, Math.min(400, cols | 0)), Math.max(5, Math.min(200, rows | 0)))
  } catch {}
}

export function detach(name: string): void {
  const p = clients.get(name)
  if (!p) return
  clients.delete(name)
  try {
    p.kill()
  } catch {}
}

export function detachAll(): void {
  for (const name of [...clients.keys()]) detach(name)
}
