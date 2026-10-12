import { execFile, execFileSync } from 'node:child_process'
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
  // Launched from the Dock there's no locale, and tmux then treats the terminal as plain ASCII: Claude's UI
  // renders as underscores and list-panes mangles tabs. Ask for UTF-8 unless the user already chose a locale.
  if (!env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LANG = 'en_US.UTF-8'
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

// resume: the conversation Mason started this shell for, so it can be named before Claude is up (or after it exits).
export type Hosted = { name: string; tty: string; cwd: string; created: number; resume?: string }

export function listHosted(): Hosted[] {
  if (!TMUX) return []
  try {
    // Space-separated, path last: tmux can rewrite tabs in its output, and only the path can contain spaces.
    return tmux(['list-panes', '-a', '-F', '#{session_name} #{pane_tty} #{session_created} r#{@mason_resume} #{pane_current_path}'])
      .split('\n')
      .map((l) => l.match(/^(\S+) (\S+) (\d+) r(\S*) (.*)$/))
      .filter((m): m is RegExpMatchArray => !!m && NAME_RE.test(m[1]))
      .map(([, name, tty, created, resume, cwd]) => ({
        name,
        tty: tty.replace('/dev/', ''),
        cwd,
        created: Number(created) * 1000,
        resume: SESSION_ID_RE.test(resume) ? resume : undefined
      }))
  } catch {
    return [] // no server running yet
  }
}

// Starts your normal login shell in the folder (so your PATH, nvm, etc. all work), then types `claude` into it.
// If Claude exits, the shell stays, just like a Terminal tab.
export function startSession(cwd: string, resumeId?: string, briefPath?: string): string {
  if (resumeId && !SESSION_ID_RE.test(resumeId)) throw new Error('bad session id')
  const name = `ms-${randomBytes(4).toString('hex')}`
  tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '120', '-y', '36'])
  if (resumeId) tmux(['set-option', '-t', name, '@mason_resume', resumeId])
  // A fresh start from a handoff hands Claude the brief as its first message, read from a file so nothing needs quoting.
  const first = briefPath ? ` "$(cat '${briefPath.replace(/'/g, `'\\''`)}')"` : ''
  tmux(['send-keys', '-t', name, '-l', resumeId ? `claude --resume ${resumeId}` : `claude${first}`])
  tmux(['send-keys', '-t', name, 'Enter'])
  return name
}

// What a shell without a running Claude is showing, in a few words.
export function peek(name: string): 'trust' | 'shell' | 'starting' {
  try {
    const lines = tmux(['capture-pane', '-p', '-t', name]).split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.some((l) => /trust this folder/i.test(l))) return 'trust'
    if (/[%$#❯>]$/.test(lines.at(-1) ?? '')) return 'shell'
  } catch {}
  return 'starting'
}

// Scrolling uses tmux's own history (copy mode), so you can read back everything Claude printed, not just
// what's on screen. -e drops out of copy mode by itself once you scroll back to the bottom.
const scrolled = new Set<string>()
export function scroll(name: string, lines: number): void {
  if (!TMUX || !NAME_RE.test(name) || !Number.isFinite(lines) || !lines) return
  const run = (args: string[], then?: () => void) => execFile(TMUX!, [...baseArgs(), ...args], { timeout: 5000, env: cleanEnv() }, () => then?.())
  const move = () => run(['send-keys', '-t', name, '-X', '-N', String(Math.min(50, Math.abs(lines | 0) || 1)), lines < 0 ? 'scroll-up' : 'scroll-down'])
  if (lines > 0) {
    move()
    return
  }
  scrolled.add(name)
  run(['copy-mode', '-e', '-t', name], move)
}

// Typing while scrolled back jumps to the bottom first, like any terminal. Synchronous so the keystroke lands after.
export function unscroll(name: string): void {
  if (!scrolled.delete(name)) return
  try {
    tmux(['send-keys', '-t', name, '-X', 'cancel'])
  } catch {} // already back at the bottom
}

export function endSession(name: string): void {
  if (!NAME_RE.test(name)) return
  try {
    tmux(['kill-session', '-t', name])
  } catch {}
}
