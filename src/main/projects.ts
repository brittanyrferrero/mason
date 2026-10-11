import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import type { DB } from './db'

const cache = new Map<string, number>()

// Worktrees share a git common dir, so room-booking, room-booking-linen, etc. roll up into one project.
function projectKeyFor(cwd: string): { key: string; root: string } {
  if (existsSync(cwd)) {
    try {
      const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      if (common) {
        const root = basename(common) === '.git' ? dirname(common) : common
        return { key: common, root }
      }
    } catch {
      // not a git repo
    }
  }
  return { key: cwd, root: cwd }
}

function nameFor(root: string): string {
  return root === homedir() ? 'Home' : basename(root)
}

export function projectIdFor(db: DB, cwd: string): number {
  const hit = cache.get(cwd)
  if (hit) return hit

  let { key, root } = projectKeyFor(cwd)

  // A deleted worktree folder (e.g. room-booking-tlink) can't be asked about git anymore.
  // Fold it into the existing project whose folder name it extends.
  if (!existsSync(cwd)) {
    const parent = db
      .prepare(`SELECT id, root FROM projects WHERE ? LIKE root || '-%' ORDER BY length(root) DESC LIMIT 1`)
      .get(cwd) as { id: number } | undefined
    if (parent) {
      cache.set(cwd, parent.id)
      return parent.id
    }
  }

  const existing = db.prepare('SELECT id FROM projects WHERE key = ?').get(key) as { id: number } | undefined
  const id =
    existing?.id ??
    Number(
      db
        .prepare('INSERT INTO projects (key, name, root, created_at) VALUES (?, ?, ?, ?)')
        .run(key, nameFor(root), root, Date.now()).lastInsertRowid
    )
  cache.set(cwd, id)
  return id
}
