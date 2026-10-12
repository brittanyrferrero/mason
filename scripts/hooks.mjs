#!/usr/bin/env node
// Adds (or removes) Mason's hooks in ~/.claude/settings.json, and its /pause command in ~/.claude/commands.
//   node scripts/hooks.mjs install
//   node scripts/hooks.mjs uninstall
// Always backs the file up to ~/.mason/backups first, and only ever touches entries that run ~/.mason/hook.sh.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SETTINGS = join(homedir(), '.claude', 'settings.json')
const BACKUPS = join(homedir(), '.mason', 'backups')
const MARK = '.mason/hook.sh'
const cmd = (event) => `"$HOME/${MARK}" ${event}`

// event -> matcher (null for events that don't take one)
const EVENTS = {
  Notification: null,
  PreToolUse: 'AskUserQuestion',
  PostToolUse: '*',
  UserPromptSubmit: null,
  Stop: null,
  SessionEnd: null
}

const isOurs = (group) => (group?.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(MARK))

function load() {
  return existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {}
}

function backup() {
  if (!existsSync(SETTINGS)) return null
  mkdirSync(BACKUPS, { recursive: true, mode: 0o700 })
  const to = join(BACKUPS, `settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  copyFileSync(SETTINGS, to)
  return to
}

function strip(settings) {
  if (!settings.hooks) return settings
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups.filter((g) => !isOurs(g))
    if (kept.length) settings.hooks[event] = kept
    else delete settings.hooks[event]
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks
  return settings
}

const action = process.argv[2]
if (action !== 'install' && action !== 'uninstall') {
  console.error('usage: node scripts/hooks.mjs install|uninstall')
  process.exit(1)
}

// /pause: Mason writes the command text to ~/.mason when it starts; this copies it into place.
// Never overwrites a pause.md that Mason didn't write.
const COMMAND_SRC = join(homedir(), '.mason', 'pause-command.md')
const COMMAND = join(homedir(), '.claude', 'commands', 'pause.md')
const commandIsOurs = () => !existsSync(COMMAND) || readFileSync(COMMAND, 'utf8').includes('Written by Mason')
if (action === 'install') {
  if (!existsSync(COMMAND_SRC)) console.log('Open Mason once first (it writes the /pause command), then run this again to add /pause.')
  else if (!commandIsOurs()) console.log(`Left ${COMMAND} alone: it isn't Mason's. /pause was not installed.`)
  else {
    mkdirSync(join(homedir(), '.claude', 'commands'), { recursive: true })
    copyFileSync(COMMAND_SRC, COMMAND)
    console.log(`Installed /pause in ${COMMAND}`)
  }
} else if (existsSync(COMMAND) && commandIsOurs()) {
  rmSync(COMMAND)
  console.log(`Removed ${COMMAND}`)
}

const settings = strip(load())
if (action === 'install') {
  settings.hooks ??= {}
  for (const [event, matcher] of Object.entries(EVENTS)) {
    const group = { hooks: [{ type: 'command', command: cmd(event), timeout: 5 }] }
    if (matcher) group.matcher = matcher
    ;(settings.hooks[event] ??= []).push(group)
  }
}
const saved = backup()
writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')
console.log(`${action === 'install' ? 'Installed' : 'Removed'} Mason hooks in ${SETTINGS}${saved ? `\nBackup: ${saved}` : ''}`)
