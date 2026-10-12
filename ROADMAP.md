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
- [x] Open tab by project: group windows under project headings, or show just one project (⌘P)
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
- [x] **Focus on one.** F (or the target on hover) puts a session first and dims the rest; "Focusing on …  Stop" up top.
- [x] **Star.** A quiet marker on sessions you care about (*); doesn't move anything.
- [x] **Done today.** A small list of what got finished today, from ended sessions and their summaries.
- [x] **Find** (/ or ⌘F): filters the live list as you type and searches every past conversation, any age; click to resume. `*` for starred.

Not doing: time cues ("working 40 min") and nudges about sessions waiting too long.

## Later

- [ ] Global hotkey to bring Mason forward from anywhere
- [ ] Peek: enlarge a session over the list without opening it; answer a permission prompt from there
- [ ] Reopen sessions after a Mac restart
- [ ] Menu bar icon with the waiting count
