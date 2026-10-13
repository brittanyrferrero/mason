import { execFile, spawn } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db'
import { cleanEnv } from './tmux'

// Updates: Mason is built from a git checkout, so "an update" means new commits on GitHub that this build doesn't have.
// Mason checks now and then (one `git fetch`, the only network call besides summaries) and shows a quiet Update button.
// Updating pulls, rebuilds and reopens Mason with scripts/install-app.sh; sessions keep running in tmux throughout.

declare const __MASON_REPO__: string
declare const __MASON_COMMIT__: string
const REPO = __MASON_REPO__
const BUILT = __MASON_COMMIT__ // the commit this copy of Mason was built from

export type UpdateInfo = { count: number; notes: string[] } | null
let latest: UpdateInfo = null
export const updateInfo = () => latest

const canUpdate = () => !!BUILT && existsSync(join(REPO, '.git')) && existsSync(join(REPO, 'scripts', 'install-app.sh'))

function git(args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', ['-C', REPO, ...args], { timeout, env: cleanEnv(), encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out)))
  )
}

// Returns true if what's available changed, so the window can be told.
export async function checkForUpdate(): Promise<boolean> {
  if (!canUpdate()) return false
  const before = JSON.stringify(latest)
  try {
    await git(['fetch', '--quiet', 'origin', 'main'])
    const log = (await git(['log', '--no-merges', '--format=%s', `${BUILT}..origin/main`])).trim()
    const notes = log ? log.split('\n') : []
    latest = notes.length ? { count: notes.length, notes: notes.slice(0, 8) } : null
  } catch {
    // offline, or this checkout has no origin/main: try again next time, keep showing what we knew
  }
  return JSON.stringify(latest) !== before
}

// Runs in the background, detached, because install-app.sh quits Mason partway through and reopens the new build.
// Your login shell runs it so Homebrew, nvm and friends are on the PATH, just like in Terminal.
export function runUpdate(onFail: (message: string) => void): { ok: boolean; error?: string } {
  if (!canUpdate()) return { ok: false, error: 'This copy of Mason wasn’t installed from git, so it can’t update itself.' }
  const log = openSync(join(DATA_DIR, 'update.log'), 'a', 0o600)
  const script = 'set -e; git pull --ff-only origin main; npm install --no-audit --no-fund; scripts/install-app.sh'
  const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', script], {
    cwd: REPO,
    env: cleanEnv(),
    detached: true,
    stdio: ['ignore', log, log]
  })
  // On success install-app.sh quits this copy of Mason, so an exit we live to see means something went wrong.
  child.on('exit', (code) => {
    if (code) onFail('The update didn’t finish, so Mason is still on the old version. Details are in ~/.mason/update.log.')
  })
  child.unref()
  return { ok: true }
}
