# claude.ai projects in Mason

**Status:** plan, not built. Tracked in [ROADMAP.md](../ROADMAP.md) under Later.

## The idea

Some of the work Mason holds also has a home on claude.ai: a Project with instructions, files and chats.
Right now the two don't know about each other, so you keep the link between them in your head.
That's exactly what Mason is meant to take off your hands.

You choose which claude.ai projects join Mason. **Nothing shows up on its own.** Most claude.ai projects
have nothing to do with Mason, and a flood of them would be the opposite of calm.

## What we can and can't reach

- **claude.ai has no public API for Projects.** Mason can't list your projects or read their chats and files
  through any supported route. (The Claude API is a separate product and can't see your claude.ai account.)
- **The Claude desktop app can use local MCP servers.** The desktop app runs the same Projects as claude.ai,
  so a chat inside any project can call tools Mason provides, all on your Mac. This is the one official bridge.
- **claude.ai can export your data** (Settings, Privacy, Export data) as a zip of conversations and projects. It's a
  snapshot, it comes as an emailed download link, and there's no matching import.
- **The website itself** can be driven by Mason with your login, the way a browser is. It works but it's unofficial:
  any redesign of claude.ai can break it.

## The plan, in four parts

Built in this order. Each part is useful on its own.

### 1. Links

Paste a claude.ai project link into Mason. It sits under the Mason project you choose (or on its own) with
its name and an optional note, in the same quiet style as everything else. Click opens it in Claude
(the desktop app if it's installed, otherwise the browser).

- Small, offline, can't break.
- The linked list is what parts 2 to 4 use: it's how "you choose which ones" is expressed everywhere.

### 2. Connector (claude.ai to Mason)

Mason runs a small local MCP server and offers to add it to the Claude desktop app's config, backing up the
config first, as `scripts/hooks.mjs` does for Claude Code settings. A chat in a claude.ai project can then:

- **stash to Mason:** "save this", "later: …", "add a note to my Mason project X". Lands in **Saved**, tagged with the project
- **read from Mason:** "what was I doing on mason?" returns the where-was-I recaps, notes and handoffs
- **spin off:** "start this in Claude Code in ~/mason" opens a new session in Mason with the chat's context, like `/spinoff`

Notes:
- Official and local: it uses the desktop app's own MCP support, with no claude.ai login involved.
- It only works in the desktop app, not claude.ai in a browser.
- It doesn't let Mason see projects; it lets projects reach Mason when you ask them to.
- Read tools only return what Mason already shows you (recaps, notes, handoffs), not raw transcripts.

### 3. Send to claude.ai (Mason to claude.ai)

On a session, note or handoff: **Send to claude.ai**, then pick one of your linked projects. Mason uploads it as a
`.md` file into that project's knowledge, so chats there know where you left off. A linked project can also hold
one file, such as "Mason – where I am", that Mason replaces whenever you ask.

How: Mason opens claude.ai in a window of its own; you log in once there (Mason never sees your password, but it
keeps a login session the way a browser does). Mason then does what you would do: open the project and upload.

- **Unofficial and fragile.** A claude.ai redesign can break it, so keep the job this small.
- **Never fails silently.** If the upload can't finish, Mason copies the text to the clipboard, opens the
  project, and says "paste it here".
- **Only when you ask.** No background syncing.

### 4. Import (maybe)

Drop a claude.ai export zip on Mason; it reads the projects you've linked and brings their past chats in as
searchable history (in **Find**). A snapshot only. Worth doing only if parts 1 to 3 leave a gap.

## Privacy

Mason's rule is "local only, except short summaries". Part 3 is the first time Mason would send your session text
somewhere else. It goes only to your own claude.ai account, only when you click Send, and only to a project you
linked. The README's privacy line needs updating when part 3 ships.

## Not doing

- Showing all your claude.ai projects automatically.
- Reading claude.ai through its private web API in the background.
- Two-way sync. Everything moves because you asked it to.
