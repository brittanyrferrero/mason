import { homedir } from 'node:os'
import * as pty from 'node-pty'
import { baseArgs, cleanEnv, NAME_RE, TMUX } from './tmux'

// A view of a session is called a client: the session's own name for its Open-tab window, or "<name>~peek" for Peek,
// so both can be attached at once. Each client is one attached tmux client.
export const CLIENT_RE = /^(ms-[0-9a-f]{8})(~peek)?$/
export const sessionOf = (client: string) => client.replace(/~peek$/, '')

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
  if (!TMUX || !CLIENT_RE.test(name) || !NAME_RE.test(sessionOf(name))) return false
  detach(name)
  const p = pty.spawn(TMUX, [...baseArgs(), 'attach-session', '-t', sessionOf(name)], {
    name: 'xterm-256color',
    cols: Math.max(20, Math.min(400, cols | 0)),
    rows: Math.max(5, Math.min(200, rows | 0)),
    cwd: homedir(),
    env: cleanEnv() as Record<string, string>
  })
  // A client being replaced still says goodbye on its way out (leave full screen, paste mode off, "[lost tty]").
  // That must not reach the view that replaced it, or its scrolling breaks, so only the current client is heard.
  p.onData((d) => clients.get(name) === p && onData(d))
  p.onExit(() => {
    if (clients.get(name) !== p) return
    clients.delete(name)
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
