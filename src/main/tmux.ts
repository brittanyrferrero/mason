import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db'

// Mason runs its own private tmux server ("-L mason"), separate from any tmux you use yourself.
// tmux keeps sessions alive when Mason's window closes or the app quits; Mason just attaches to them.
export const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(existsSync) ?? null
const SOCKET = 'mason'
const CONF = join(DATA_DIR, 'tmux.conf')

const CONF_TEXT = `# Written by Mason. Invisible tmux: no status bar, no prefix key, so every keystroke goes to Claude.
set -g status off
set -g prefix None
unbind-key -a
set -g mouse off
set -g history-limit 50000
set -sg escape-time 0
set -g focus-events on
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g window-size latest
set -g aggressive-resize on
set -g set-titles off
`

export const NAME_RE = /^ms-[0-9a-f]{8}$/
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Mason is often launched from the Dock with a bare environment; tmux and the shells it starts need a sane PATH,
// and should not inherit Electron's own variables.
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(ELECTRON|VITE|NODE_OPTIONS|CHROME)/.test(k)) env[k] = v
  env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':')
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  delete env.TMUX
  return env
}

export function baseArgs(): string[] {
  return ['-L', SOCKET, '-f', CONF]
}

function tmux(args: string[]): string {
  if (!TMUX) throw new Error('tmux is not installed')
  return execFileSync(TMUX, [...baseArgs(), ...args], { encoding: 'utf8', timeout: 5000, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
}

export function initTmux(): void {
  writeFileSync(CONF, CONF_TEXT, { mode: 0o600 })
}

export type Hosted = { name: string; tty: string; cwd: string; created: number }

export function listHosted(): Hosted[] {
  if (!TMUX) return []
  try {
    return tmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_tty}\t#{pane_current_path}\t#{session_created}'])
      .split('\n')
      .map((l) => l.split('\t'))
      .filter(([name]) => NAME_RE.test(name ?? ''))
      .map(([name, tty, cwd, created]) => ({ name, tty: tty.replace('/dev/', ''), cwd, created: Number(created) * 1000 }))
  } catch {
    return [] // no server running yet
  }
}

// Starts your normal login shell in the folder (so your PATH, nvm, etc. all work), then types `claude` into it.
// If Claude exits, the shell stays, just like a Terminal tab.
export function startSession(cwd: string, resumeId?: string): string {
  if (resumeId && !SESSION_ID_RE.test(resumeId)) throw new Error('bad session id')
  const name = `ms-${randomBytes(4).toString('hex')}`
  tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '120', '-y', '36'])
  tmux(['send-keys', '-t', name, '-l', resumeId ? `claude --resume ${resumeId}` : 'claude'])
  tmux(['send-keys', '-t', name, 'Enter'])
  return name
}

export function endSession(name: string): void {
  if (!NAME_RE.test(name)) return
  try {
    tmux(['kill-session', '-t', name])
  } catch {}
}
