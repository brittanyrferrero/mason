import { execFile } from 'node:child_process'

// Finds the Terminal.app tab whose tty matches and brings it to the front.
// The tty is passed as an argument (never pasted into the script), so nothing user-controlled is ever run.
const FOCUS_TAB = [
  'on run argv',
  '  set wanted to "/dev/" & item 1 of argv',
  '  tell application "Terminal"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        if tty of t is wanted then',
  '          set selected of t to true',
  '          set index of w to 1',
  '          activate',
  '          return "ok"',
  '        end if',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  return "missing"',
  'end run'
]

export function focusTerminalTab(tty: string): Promise<boolean> {
  const args = FOCUS_TAB.flatMap((line) => ['-e', line]).concat(tty)
  return new Promise((resolve) => {
    execFile('osascript', args, { timeout: 8000 }, (err, stdout) => resolve(!err && stdout.trim() === 'ok'))
  })
}
