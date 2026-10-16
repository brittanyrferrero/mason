# Mason roadmap

Mason is one quiet place for every Claude Code session, built for an ADHD brain: it should hold the
things your head drops (where you were, what you meant to do next, the idea you had mid-task) and stay
calm until something actually needs you.

Started from [termwall](https://claude.ai/artifact/Nfx7bhFvDoyfx1BK43cV1A) (a wall of Claude sessions
behind a hotkey). Mason keeps that core and adds memory and focus.

**Design rules**
- Minimal and quiet. Options live in quiet dropdowns or keyboard shortcuts, not toolbars.
- Only "waiting on you" is loud. Everything else is muted until you look.
- Capturing a thought must take one keystroke and never pull you out of what you're doing.
- Nothing is lost: ending, pausing, or quitting always leaves a breadcrumb you can pick back up.
- Local only. The single exception is short summaries Claude writes (can be turned off).

## Done

- [x] Every session in one list, grouped by project, with busy / idle / waiting dots
- [x] "Waiting on you" from hooks: coral, sorted first, Dock badge
- [x] Sessions run inside Mason (invisible tmux) and survive closing the window or quitting
- [x] Move a Terminal session into Mason; resume paused sessions; start new ones per project
- [x] Shush: collapse everything except what you open on purpose
- [x] Open tab: several sessions at once, stacked / side by side / grid / one at a time, drag to reorder, ⌘ shortcuts
- [x] Spin-off: /spinoff <thought> in Claude, or ⌘⇧N, starts a side thought as a new session in the same folder
- [x] From easl: ⌘J to the next waiting session, a Mac notification when one starts waiting, drag text into a session
- [x] Plain terminals inside Mason (+ New terminal per project, ⌘T in the Open tab) and + New project for any folder
- [x] Open tab by project: group windows under project headings, or show just one project (⌘P). "By project" holds still; "busiest first" lets busy projects and waiting sessions rise
- [x] Scroll back through a session's history inside Mason

## Now (in this order)

- [x] **Rename and pin.** Give a session your own name (R, or the T on hover); pinned sessions (P) lead their project.
- [x] **Summaries.** Claude writes a few words on what each session is about (the row's title line) and
      a two-line "where was I?" recap: what you were doing and the next step. Can be turned off.
- [x] **Handoffs.** When you pause a session (or it gets long), Claude writes a handoff note so a fresh
      session can pick up exactly where it left off. **/pause** inside Claude does this and stops the session;
      the note shows on the paused list and you can edit it.
- [x] **Persistent notes.** A note on any session or project that survives ending, pausing, and restarts.
      Start one with the pen; long notes fold with "more", and ▴ tucks one away. Plus one free-floating scratchpad.

## Next

- [x] **Quick capture.** ⌃⌥N opens a one-line box from any app; type, Enter, gone.
      Lands in **Saved** tagged with the session you last typed into.
- [x] **/stash** inside Claude: `/stash` keeps Claude's last reply, `/stash 2` the one before, `/stash idea …` and
      `/stash later …` park a thought. A hook files it in **Saved** and blocks the prompt, so Claude never takes a turn.
- [x] **Help card** (? top right): what the dots mean, the commands you can type inside Claude, the global hotkey,
      then the keyboard shortcuts. The empty Saved list explains how to fill it.
- [x] **Focus on one** (Open tab). The target in a window's title bar (⌘⇧F) dims the other windows; nothing moves.
- [x] **Expand** (Open tab). The arrows in a window's title bar (⌘E) make it fill Mason; shrink drops it back
- [x] **Recent edge** (Open tab). The window you just clicked away from keeps a really faint white edge for five minutes
- [x] **Resting** (Open tab). A window untouched for 10 minutes, by you or Claude, gets a quieter title bar; working and waiting ones never do
- [x] **Move a session to another project**: drag its row onto the project in the Projects tab. It stays there; following its folders never moves it back
- [x] **A worktree per session** (on by default, "Worktrees on/off" at the bottom). "+ New session" in a git project starts `claude --worktree`: its own copy of the repo in `.claude/worktrees/` on its own branch, so parallel PR sessions never touch each other. Claude removes an untouched one on exit; Mason clears one away once its PR is merged, never with anything running or uncommitted in it. Other folders start plain
      into the grid, stack, or whatever layout was there. Nothing about the layout changes.
- [x] **Star.** A quiet marker on sessions you care about (*); doesn't move anything.
- [x] **Done today.** A small list of what got finished today, from ended sessions and their summaries.
- [x] **Find** (/ or ⌘F): filters the live list as you type and searches every past conversation, any age; click to resume. `*` for starred.

Not doing: time cues ("working 40 min") and nudges about sessions waiting too long.

- [x] **Updates:** Mason checks GitHub now and then; a quiet **Update** button (top right) shows what's new and rebuilds and reopens Mason on click. Sessions keep running.

## Later

- [x] **Bring Mason forward** from anywhere with ⌃⌥M (press again to put it away)
- [x] **Peek** (Space, or the eye on hover): the session enlarged over the list, live, so you can answer it right there
- [x] **Reopen after a restart:** if tmux is gone when Mason starts, the sessions that were running in it are resumed in their folders
- [x] **Menu bar icon** (m.) with the waiting count; its menu lists what's waiting (click to Peek), Quick capture, Open Mason
