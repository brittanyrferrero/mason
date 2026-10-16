import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DB } from './db'
import { cleanEnv } from './tmux'

// Worktrees: a new session in a git project gets its own copy of the repo on its own branch (Claude Code's
// `claude --worktree`, kept in <project>/.claude/worktrees/), so sessions running side by side never touch each
// other's files or commits. Claude removes an untouched one when you exit; Mason tidies up the rest once their
// branch is merged.

const run = promisify(execFile)
const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'].find(existsSync) ?? null
export const WORKTREE_DIR = join('.claude', 'worktrees')

export function worktreesOn(db: DB): boolean {
  return (db.prepare("SELECT value FROM settings WHERE key = 'worktrees'").get() as { value: string } | undefined)?.value !== 'off'
}

export function setWorktrees(db: DB, on: boolean): void {
  db.prepare("INSERT INTO settings (key, value) VALUES ('worktrees', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? 'on' : 'off')
}

// Only a repo's main folder gets worktrees: Home and other plain folders start Claude right there, as before.
export function isGitRoot(root: string): boolean {
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], env: cleanEnv() }).trim()
    return top === root
  } catch {
    return false
  }
}

const git = async (cwd: string, args: string[]) => (await run('git', ['-C', cwd, ...args], { timeout: 15_000, env: cleanEnv() })).stdout.trim()

// Merged: its pull request was merged on GitHub (squash merges included) and nothing was committed after it.
async function merged(root: string, branch: string): Promise<boolean> {
  if (!GH) return false
  try {
    const out = (await run(GH, ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'headRefOid', '--limit', '1'], { cwd: root, timeout: 20_000, env: cleanEnv() })).stdout
    const pr = JSON.parse(out)[0] as { headRefOid: string } | undefined
    return !!pr && pr.headRefOid === (await git(root, ['rev-parse', branch]))
  } catch {
    return false // no GitHub remote, or gh isn't signed in: keep it
  }
}

let tidying = false
// Removes a worktree in <project>/.claude/worktrees only when all of these hold, so no work is ever lost:
// nothing is running in it, it has no uncommitted changes, and either its pull request was merged or it never
// got a commit and no conversation happened in it (a paused conversation keeps its folder so it can resume).
export async function tidyWorktrees(db: DB, inUse: string[]): Promise<number> {
  if (tidying) return 0
  tidying = true
  let removed = 0
  try {
    const roots = db.prepare('SELECT DISTINCT root FROM projects').all() as { root: string }[]
    for (const { root } of roots) {
      const dir = join(root, WORKTREE_DIR)
      if (!existsSync(dir)) continue
      let list = ''
      try {
        list = await git(root, ['worktree', 'list', '--porcelain'])
      } catch {
        continue
      }
      const base = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => git(root, ['branch', '--show-current']).catch(() => 'main'))
      for (const block of list.split('\n\n')) {
        const path = block.match(/^worktree (.+)$/m)?.[1]
        const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]
        if (!path || !branch || !path.startsWith(dir + '/')) continue
        if (inUse.some((c) => c === path || c.startsWith(path + '/'))) continue
        try {
          if (existsSync(path) && (await git(path, ['status', '--porcelain']))) continue // uncommitted work
          const ahead = Number(await git(root, ['rev-list', '--count', `${base}..${branch}`]))
          const talked = db.prepare("SELECT 1 FROM sessions WHERE cwd = ? OR cwd LIKE ? || '/%' LIMIT 1").get(path, path)
          const done = (ahead === 0 && !talked) || (await merged(root, branch))
          if (!done) continue
          await git(root, ['worktree', 'unlock', path]).catch(() => '')
          await git(root, ['worktree', 'remove', '--force', path])
          await git(root, ['branch', '-D', branch]).catch(() => '')
          removed++
        } catch {
          // leave it be; try again next time
        }
      }
    }
  } finally {
    tidying = false
  }
  return removed
}
