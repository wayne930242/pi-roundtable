# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Dispatch threads in the room list are cards: the title, the room's knight, an in-progress or finished badge, the time and the unread count, with a going-on thread tinted and a finished one at rest. Swiping a finished card to the right clears it (the card slides out, the list closes the gap, and a notice offers Undo for five seconds); a going-on card gives a little and springs back. Holding a card or right-clicking it, or the menu button on a finished one, opens a menu with "Clear this thread" and "Clear all finished"; Delete on a focused finished card clears it, and "Clear finished" in the header of the finished threads clears them all, asking first with the count when there are more than five. Reduced motion skips the slide. The undo is two new owner routes, `POST api/rooms/<thread>/undismiss` and `POST api/rooms/<room>/undismiss-threads` (body `{ "threads": [<keys>] }`, at most 100 keys under that room), which put dismissed threads back on the list for every owner.

### Changed

- The page's word for an agent is now "Knight" in every look: lists, sheets, menus, the table, notifications and the server's refusals. The main agent is the "main knight". The model picker's "Follow the assistant" row is "Default model", and the sheet shows the model it resolves to when it knows it. Agents over MCP outside Discord are "Outside AI clients", and the agent server is the "Bot server". Text only: identifiers, API fields and configuration keys are unchanged.

## [0.26.1] - 2026-10-30

### Added

- `HostCard.keep`: a card the host still wants (a ticket's pinned card while the ticket is open) survives its kind's `retention.textDays` sweep for as long as `card` or `updateCard` passes `keep: true`; `updateCard` without it makes the card ordinary again. Adds the migration `web-host-cards-keep` (a `keep` column).
- `WebApp.rooms.context(room, { limit?, messageChars? })`: a host room's recent messages as the channel-context block `CHANNEL_CONTEXT.read` gives a turn, for a host that starts a turn from a room's `send` hook and has no addressing message. It marks nothing handed over, so a retry reads the same.
- `auth.onSessionVerified(principalId)` for `oidc`: called when a request or an open socket proves a live session, at most once per session every five minutes, so a host can count a person who only has the app open as present. It is not awaited; an error it throws is logged and never fails the request.
- Typing `@AI` as the first word of the box works as the toggle, in a host room that offers both ways and in an agent or group room that offers the `@AI` switch for notes. The word counts in any case when a space, a colon, a comma or the end of the text follows it. While it is there the switch shows on and locked, and it returns to the person's own setting when the token is deleted; the page sends the message with an explicit `mode: "turn"` and cuts the leading token (and the space, colon or comma after it) from the text. Only typing counts: `@AI` later in the text, inside an address such as `a@ai.com` or a word such as `@AIX`, in pasted or dropped text, in a restored draft or in a quote is plain text and the message goes as the switch says. This is the page's shorthand only; the server never reads a message's text for it, so a `note` frame whose text starts with `@AI` stays a note, and only an explicit `mode: "turn"` from a viewer who may send turns starts one. `Composer.onSend` gets a third argument, whether the person addressed the agent, and `Composer` takes `onAddressed`; `ModeToggle` takes `locked`. Rooms without the switch are unchanged.
- Internal notes in an agent or group room: an agent or group room that more than one person reads (the host has more than one owner) gets an `@AI` switch on the composer, on by default. Off, the message is an internal note: it is stored in the room's log with its author, shown live to every other owner and in the history with the author's name and picture and an "Internal note" marker (zh-TW has its own wording), and never given to the agent: no turn runs, it is not in the agent's session, and it is not in any channel context. The server says which rooms take notes: `RoomView.notes` is `true` on the agent and group rooms of a host with more than one owner, absent otherwise, so the page does not guess. A note is a `send` frame with `mode: "note"` (the frame the host rooms already use); a stored note carries `RoomMessage.note: true` (additive column `web_room_messages.note`, migration `web-room-messages-note`). A host with one owner behaves exactly as before: no switch, no new field in the room list or the history, and a `note` frame is still refused as `bad_frame`. The fixture takes `FIXTURE_OWNERS=2` to try it with Ada and Bob.
- The package entry exports the host-facing API: `WEB_APP` and the types `WebApp`, `HostRoomKind`, `HostPage`, `HostCard`, `Viewer`, `OpenTarget`, `ActionResult`, `LinkProver`, `OnboardingStep` and `Notices`, so a host plugin no longer mirrors them.
- The `description` option, and `<meta name="description">`, `og:title`, `og:description` and `og:image` on the page, so a search result and a link preview have a title, a line and the mark. Without `description` a line is derived from `title`.
- `<mount>/icons/mark.svg`, the round-table mark.
- The tab shows a small red dot on its icon, top-right with a white ring, while anything waits (cards waiting, notices, unread messages), and the title leads with `(N) `. The dotted icon is drawn in the browser from the page's own icon, so a host's `icons.dir` keeps its look; Safari ignores a changed tab icon, so there the title's count is the signal. It is a lazy chunk that loads after the first paint. Unread messages now count in the title too, not only cards.

### Changed

- README and the `Notices.raise` doc: a notice's `tag` is the dedupe key, the push tag and the acknowledgement key, visible to the people the notice is for; put no private id in it.
- A host may name the `table` pane for a member or an admin (`panes: { owner, admin?, member }`, with that tier's `rooms` pane too; the default lists still leave it out). Their table seats the host rooms their kinds let them list, newest first, not agents: the agent rooms stay the owners'. A seat is lit by its room's own `activity` and cards, which reach a socket only for a room the person may read now, and a tap opens the room's page, where the kind's `access` decides what they may write and press. There is no dialogue box, seat menu or "Who's at the table" sheet for them, and no new route. `overview`, `workspace`, `skills` and `connectors` stay owners-only. The owners' table is unchanged.
- Following a host room now also sends the follower the room's `activity` frame when a turn is already running, so a seat does not wait for the next change to show it.
- `HostRoomKind.buttons` may return a promise, for a host whose rights source is async.
- README: `WebApp.rooms`, `.notices`, `.pages`, `.onboarding` and `.push` throw until the plugin started; `notices.onAck` is available only after start.
- An ordinary folder is a light section header (chevron, name, count, ⋯), left-aligned like the Home and Pinned labels, not the boxed grey card, which stays for the archive. A folded folder shows a small overlapping stack of the pictures of its first four rooms and, when it holds more, how many more (`+2`).
- An owner can take a finished dispatch thread off the room list: a remove button on each finished row, and "Clear all" in the fold of a room's finished threads. The thread leaves the list for every owner and every open page at once; it is hidden, not deleted, and stays readable by its address and through the links in its room. An open thread cannot be removed (409). The mark is the new column `web_threads.dismissed_at` (migration `web-threads-dismissed`, additive). Routes: `POST api/rooms/<thread>/dismiss`, `POST api/rooms/<room>/dismiss-threads`, and `GET api/rooms/<thread>` for the view of a thread the list does not carry (owners only, like the rest of `api/rooms`).
- `HostPage.icon` and `HostRoomKind.icon`: an optional name from the console's own icon set (`HOST_ICONS`, type `HostIconName`, exported): `chat`, `link`, `activity`, `users`, `megaphone`, `qr`, `settings`, `bell`, `file`, `list`, `shield`, `lock`, `sparkle`. A page's icon shows in the navigation (the list icon stays the default), a kind's beside its section in the room list. A name outside the set is dropped and the default shows. `ConfigView.pages[].icon` and `.kinds[].icon` carry it. The new glyphs load only when a page names one.
- A host room where a viewer may send both a note and a turn shows one `@AI` toggle over the composer's bar instead of the two chips "Note" and "Ask the agent": off sends a note for the room's people only, on sends a turn the agent answers, and the box's hint follows ("Write an internal note…" / "Ask AI…", never naming the room as a recipient, in every shipped locale). The toggle stands in the composer's column (it sat at the pane's edge on a wide screen) and is at least 44 px high. A room open to one way only shows that way's hint and no toggle. `Composer` takes `placeholder` and `above`, and `ModeToggle` is a piece of its own, for any room that offers the choice.
- `HostRoomKind.sendWording`: a kind may word the toggle (`turn.label`) and each way's hint (`note.placeholder`, `turn.placeholder`); text only, a label cut to 40 characters and a placeholder to 100. `HostRoomView.wording` carries it.

### Fixed

- Without a session only the icons the page, the manifest and the sign-in pages link answer (`192.png`, `512.png`, `maskable-512.png`, `apple-180.png`, `badge-96.png`, `mark.svg`, `mark-maskable.svg`); another file a host keeps in `icons.dir` stays behind the sign-in.
- In an agent or group room that more than one owner reads, every owner message was drawn as the viewer's own (right-aligned, accent bubble), so Bob saw Ada's messages as his. A message is the viewer's own only when its author's principal (`RoomMessage.principalId`, which the server already stores and sends on owner messages) is the viewer's; another owner's message is drawn as someone else's, with that person's name and picture, as in host rooms. A message stored without a principal is the viewer's only where one owner reads the room; where several do, it is drawn as an owner nobody can name, never as the viewer's. A room one owner reads draws exactly as before.
- A folder's header no longer turns into an unreadable light fill with white text when the pointer rests on it (on a phone the highlight stuck after a tap), and its title is left-aligned, not centered. The base rule `button:hover:not(:disabled)` out-specified the header's own style; its hover, press and keyboard focus now tint the label and keep its text colour in every look and scheme.
- A row of the room list that is held and dragged on an iPhone now lifts and reorders. iOS Safari lets a page stop a finger's scroll only if a non-passive `touchmove` listener existed when the finger went down; the lift added its own after the hold, so the first move scrolled the page and the browser cancelled the drag. While a row that can be lifted is on the page, a no-op non-passive `touchmove` listener is now held.
- The plain room list (no pin and no folder yet) keeps Agents and Groups by latest activity, as the arranged list and the drawer do. Before, it kept the order the server listed them in, so a room you had just talked to did not move up, even after a reload.
- Under path routing the manifest and the home-screen icon links come after the page's base, so a page opened at a room's URL (`<mount>/room/<key>`) still finds them.
- The page now has a tab icon: the round-table mark, linked as `rel="icon"` on the app, the sign-in page and the sign-in flow's pages, so a browser no longer asks the site root for `/favicon.ico` and gets a 404. A host's own `icons.dir` is kept (add a `mark.svg` to it to replace the SVG too).
- The manifest and the icons answer without a session in `oidc` and `password` mode, so the sign-in page and a link preview have an icon. They were redirected to the sign-in. Nothing else below the mount is open.
- The served page carries the host's `title` in `<title>` from the first byte; it said `Console` until the script ran.

## [0.26.0] - 2026-10-30

The core peer range is now `>=0.26.0 <0.27.0`.

### Fixed

- A card or an unprompted reply in a host room no longer pushes to every owner's phone; host rooms reach phones only through notices.
- A file an agent attaches in a host room is bound to the room and the kind's file retention, so its readers can download it (before, only owners could, and the 30-day agent sweep applied).
- Answering a card in a host room asks the kind's `access` with the person's roles, so a role-gated reader is no longer refused or dropped from the room.
- A link with a tab, newline or space is no longer taken for a path of this origin.

### Changed

- A running turn's strip shows only its three newest tool calls; a button counts the earlier ones and opens them all (and folds them again).

## [0.25.0] - 2026-10-29

The core peer range is now `>=0.25.0 <0.26.0`.

### Added

- Make, archive and arrange agents. The **+** button of the room list and of the switcher drawer opens a menu: **New agent**, **New group** and **Archived**. New agent takes a name, the permanent name (`^[a-z0-9-]{1,32}$`, filled in from the name until typed by hand), the prompt, a model, an optional opening task and a look (the one its role suggests, or one picked in the character creator, which opens in place of the form), and opens the new agent's room. A bad or taken name, an unusable model, a bad look field (`400 {error, field}`) and an unknown skill are refused with the agent server's words before anything is made.
- Archive and restore. **Archive agent** and **Archive group** are in the agent sheet, the room's ⋯ menu and the long-press menu of a row (not on the coordinator's room, which cannot be archived), and ask first, naming what they archive. **Archived** lists archived agents and groups with Restore and Delete; Delete is only for an archived one, asks first and names it, frees the name, and clears the room's messages, cards, mute and modes in this app, and the dispatch threads under it with their messages and cards. Restoring an agent does not put it back in its groups; a group is restored only while all its members are active.
- Skills. The agent sheet lists the host's skills (the Skills pane's catalog when the host supplies one, else the skills addon's) with a switch each, applied as it is flipped. Built-in skills stay on; a host without the skills addon shows no section.
- Groups. **New group** and **Edit group** (the group's header name, its ⋯ menu, its row's menu) take a name, 2 to 6 members in the order picked, and the host; Edit sends only what changed.
- New owner-only routes, with the tier read again, the console `Origin` on every write, `404` for an agent, group or room that does not exist and `400` for a bad body or what the agent server refuses: `POST api/agents` (`201`, the profile), `POST api/agents/<name>/archive`, `POST api/agents/<name>/restore`, `DELETE api/agents/<name>`, `GET` and `PUT api/agents/<name>/skills` (`{add?, remove?}`, one change), `POST api/groups` (`201`), `GET`, `PATCH` and `DELETE api/groups/<name>`, `POST api/groups/<name>/archive` and `restore`, and `GET api/archive`. They call `AgentTeam.createAgent`, `archive`, `restore`, `remove`, `createGroup` and `updateGroup` and the skill registry's `attach`, and tell the open pages to read the room list again. Needs `pi-roundtable` with those methods.
- The new sheets (the new agent form, the group editor and the archive) are one chunk that loads when first opened; the creator takes an `onPick` mode that hands back the look instead of saving it.
- Main prompts. **Main prompts** (a link in Settings, shown only on a host with prompt documents) lists the documents the host registered through `PROMPTS` (`shared` and `guest` from `prompts.*`, and a plugin's own, such as a persona), each with a "Differs from the file version" badge and who set the override and when. One opens in a full-screen sheet with the text in force, **Review changes** (a line diff against what the text was read as, nothing is saved before it), **Save**, **History** (each change newest first, read against the version before it, **Use this text** takes it into the editor to be reviewed again) and **Revert to the file version**, which asks first and names the document. A save sends the text it was edited from (`base`); when the document changed meanwhile the server answers `409 {error, conflict: "changed", current}`, and the page reads the diff again against the text there now and keeps the draft. The override applies from the agent's next turn.
- Agent prompt history. The agent sheet gains **History** for the prompt: the versions of that agent's prompt, who changed it and when, and **Use this text**, which puts a version into the editor to be reviewed like any edit. An agent has no override layer; its saved prompt is the text in force. A prompt change from the sheet is kept under the owner's name.
- Skills editing. The Skills page edits an agent-written skill's whole SKILL.md (frontmatter and body) in a full-screen sheet, with the same frontmatter and size rules as the skill tools (the server's words are shown), a diff to read before **Save**, a history of versions and a `409` that reads the diff again against the version there now (the file is read with its SHA-256 hash and saved with it as `baseHash`). **New skill** starts from a template, reads as an all-added diff and creates the skill, attached to no agent. A built-in, package or linked skill shows a lock and where it comes from instead of **Edit**. Deleting a skill is not offered: the registry has no safe delete, and an agent still carrying one would lose it silently. A page without the owner app keeps the old hint.
- New owner-only routes, with the tier read again, the console `Origin` on every write, `404` for a prompt or skill that does not exist and `400` for a bad body or what the host refuses: `GET api/prompts` (`{documents}`; a document whose file version cannot be read has `broken`, the reason, and the others are listed as usual; the page marks it **File version cannot be read** and shows the reason instead of an editor), `GET` and `PUT api/prompts/<id>` (`{text, base}`; `409` with `current` when `base` is not the text in force), `POST api/prompts/<id>/revert` (`{base}`, with the same `409`), `GET api/prompts/<id>/history`, `GET api/agents/<name>/prompt-history`, `GET` and `PUT api/skill-docs/<name>` (`{text, baseHash}`), `POST api/skill-docs` (`{text}`; `201`) and `GET api/skill-docs/<name>/history`. `GET api/session` carries `prompts: true` when the host has prompt documents and `skillEdit: true` when it has the skills addon; the flags follow the host only, and each route reads the tier again and answers `403` below the owner. The body of a prompt write may be as large as the document's `maxChars` needs for the new text and for `base` (6 bytes a character at most), more than a plugin's roomy document would fit in a fixed 128 KiB; a larger body is `413`. Needs `pi-roundtable` with `PROMPTS` and the skill registry's documents.
- The editors (prompts and skills) are chunks that load when first opened; the page's first load does not grow.
- Pins and folders for the room list. The owners arrange it together, one layout for the whole app that every device shows: Home first, the pinned rooms in the owners' order, the owners' folders in theirs, and the rest (Ungrouped) by latest activity. A room is pinned or in one folder, not both. A room's menu (and the room header's ⋯) gains Pin or Unpin, Move to folder… and, in the list, Move up or Move down; a folder's header folds (per device, in `localStorage`; the folder with the open room shows open, and a folded folder still shows its rooms' waiting cards and working dots) and has a menu to rename, mute or unmute the whole folder, step and delete (after a question; its rooms go to Ungrouped); the list's ⋯ adds a folder and turns on arrange mode, which shows a ⋯ beside each row. The switcher drawer follows the same order with a heading for each folder.
- Reordering by hand: a finger that rests on a row lifts it, and dragging reorders it within its list or moves it into another folder, the pinned list or Ungrouped (a folded folder opens after the finger rests on it); a held folder header moves the folder. The rows make room, the list scrolls near its edges, the drop place is outlined, and Escape or a drop outside every list cancels. A mouse drags once it moves with the button down; a touch within 32 px of a screen edge never lifts a row. Ungrouped stays by activity, so a row dragged within it goes back. The lists keep their order while a row is lifted, the pinned list and empty folders appear as places to drop, and on Android the browser's own long press is the hold. The arranged list, its folders and styles, the lift code (hand-rolled on pointer events, about 5 KB minified) and the drawer's rows are chunks of their own, so a page with nothing arranged downloads next to nothing for them; Move up and Move down are the keyboard way.
- `GET api/rooms` also answers `pins` and `folders`; new owner-only routes `PUT rooms/<key>/pin`, `PUT rooms/<key>/folder`, `POST api/folders`, `PATCH` and `DELETE api/folders/<id>`, and `PUT api/folders/<id>/mute`, which mutes or unmutes every room of a folder through the rooms' own mutes in one step. Each write rereads the person's tier, needs the console's own `Origin`, takes one advisory lock, answers with the whole layout and sends `changed` to the other pages. Three additive tables, `web_room_folders`, `web_room_folder_rooms` and `web_room_pins`, in the new migration `web-room-layout`; nothing is dropped, and a room that no longer exists keeps its place and is not shown. Types `FolderView` and `LayoutView`, and `RoomsView` extends the latter.
- Deleting an agent or a group also drops its pin or folder place.
- Who sits at the round table. A **Who's at the table** button in the page's header opens a sheet (a bottom sheet under 720 px, a dialog wider) that lists every agent with its picture and a switch. Taking an agent off the table is muting its room's push (`PUT rooms/<key>/mute`, shared by every owner and device) and putting it back is unmuting it, so the table, the agent sheet and the room menu share one switch: the table seats exactly the agents whose room is not muted, and muting a room anywhere takes its agent off the table. **Leave the table** is also in a seat's menu (long press, right click or the Menu key; the scene's new `onSeatMenu` option and `seatAt`) and in the dialogue box's ⋯ button. The table re-seats at once and keeps the camera still unless it was on the agent who left, when it returns to `#/table` in place. With everyone off the table the page shows an empty state with the sheet's button; an off-table agent stays in the rooms list with its bell-slash; a group room's table still seats all its members. Traditional Chinese for the new wording.
- Leaving and joining play a short show in the hall's style. A leaving seat squashes and vanishes in flat, outlined smoke clouds that drift up with a few sparkles (about 0.7 s), the others glide to their new places, and a joining seat rises out of a small rune circle with a bounce and a column of light (about 0.85 s). The pictures are drawn on small canvases and disposed when the show ends. Under reduced motion the picture only dips and returns; the 2D fallback fades in over a ring and out inside a puff with CSS. A seat's picture is kept across rings, so the others do not flicker while the ring is rebuilt.
- Traditional Chinese for the new wording.

### Changed

- The search palette (⌘K) and the schedules pane are lazy chunks, and the question and sheet hosts (agent, team, confirms) share one, so the page loads them after the first screen instead of with it.

### Fixed

- The round table's overview keeps every seat and its name in the picture on a phone. It left half a name's width clear of the sides (the names are page text, about 44 px each side of a seat) and counted the standee's emphasis strokes, which stand wider than its board; a window resized during a camera turn now ends that turn on the new picture's overview.

## [0.24.2] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.2; no package-specific behavior changes. The core peer range stays `>=0.24.0 <0.25.0`.

## [0.24.1] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.1; no package-specific behavior changes. The core peer range stays `>=0.24.0 <0.25.0`.

## [0.24.0] - 2026-10-29

The core peer range is now `>=0.24.0 <0.25.0`.

### Added

- The files pane (`workspace`, called Files). The owner browses the agents' workspace, reads files highlighted by CodeMirror 6, and edits, creates, renames and deletes them, on a phone (drill-down, a bottom bar above the keyboard, 16 px editor font) and on a desktop (a resizable tree that remembers its open folders, breadcrumbs, Cmd/Ctrl+S and Cmd/Ctrl+F). It shows `AGENTS.workspace`, the agents' working directory (`agents`) and scratch directory (`scratch`), and `workspace.roots` adds more places: `{ id, label, dir, writable? }`, with `writable` false unless set; `workspace.agents` and `workspace.scratch` set to `false` leave the two out, and a root that is or contains `dataDir` stops the start. The pane is in the default `panes` only when there is a place to show, and a default place that holds `dataDir` is left out with a warning instead of stopping the start; listing the pane without one, or without `rooms`, stops the start. See [the README](README.md#the-files-pane).
- Saves that cannot overwrite a partner's change. A file is read with its SHA-256 hash and saved with it as `baseHash`; the server compares again just before replacing the file and answers `409` with the file as it is (or `gone`) and writes nothing. The page opens a dialog with Copy my text, Reload and Save mine anyway (confirmed a second time), and looks at an open file on focus and every 5 s, with a banner while an edit is open. A save writes a temporary file beside the original with its mode, flushes, re-checks that the directory is still the one inside the place and the file still regular, and renames it; it keeps the line separator, a byte order mark and the final newline.
- New file, New folder, Rename and Delete. None replaces something that exists (`409 exists`); Delete moves to `.rt-trash` at the top of the place, which Trash lists with Restore (never over an existing file) and Delete for good. A link is deleted as a link.
- The rules that keep it inside the places. Every call, a read too, needs an owner and a change needs the console's `Origin`; a path is `400` for a NUL, a leading `/`, a `.`, `..` or empty segment, or more than 4,096 bytes; each directory on the way is resolved with `realpath` and must be inside the place, and a place's own real directory is fixed where it is first seen; a symlink is listed with whether its target is inside, opened as its target when inside, shown and never read or written when outside, and never written through; pipes, sockets and devices are never opened; a file is opened without following a link and its handle compared with what was checked. `.git` (any case) is read-only at any depth and in any place, a place that is not writable refuses every change, a file over 2 MiB is metadata and a download, over 1 MiB is not edited, a text over 1 MiB is `413`, a download is at most 50 MiB, and a directory lists 2,000 entries. NUL bytes or invalid UTF-8 make a file read-only; a picture, PDF, sound or video previews only when its extension is on the allowlist and its bytes agree (PNG, JPEG, GIF, WebP, SVG, PDF, MP3, WAV, OGG, MP4, WebM); it is served inline with its own type, `nosniff`, `frame-ancestors 'self'`, a strong ETag, byte ranges and `Cache-Control: no-store`, under a `sandbox` policy that loads nothing (a PDF has none, because a browser's viewer does not draw under one). An SVG is served inline and sandboxed, and the page shows it only through `<img>`; HTML and XML are always downloads. Saves, creations, renames, deletions and restores are logged with who, where and short hashes, never contents, and refused escapes as warnings. The REST is under `api/workspace`.
- The editor is CodeMirror 6 (state 6.7.6, view 6.43.15, language 6.13.1, commands 6.11.1, search 6.7.2, and languages for TypeScript and JavaScript, JSON, Markdown, CSS, HTML, Python, YAML, Go, Rust, SQL, XML, shell, TOML and Dockerfile), pinned exactly as development dependencies like React. It and each language are chunks of their own that load when a file first opens; the service worker caches them when fetched and does not precache them (the code they share is left to the browser's cache), and never caches `api/workspace`. The editor sits in a shadow root with adopted stylesheets so the page's Content-Security-Policy, which does not apply a `<style>` element, stays as it is. Its colors are the `--code-*` CSS variables in `tokens.css` and, for Camelot, `styles/camelot.css`, so a look or a light/dark switch recolors it at once.
- Traditional Chinese for the new wording, and `WorkspaceRootView`, `WorkspaceFileView`, `WorkspaceListView`, `WorkspaceSaved`, `WorkspaceConflict` and the other types of the pane's API in `src/api-types.ts`.

- Skin tones from the host. `GET api/config` carries `characterSkins`, the six `#rrggbb` colors of the host's `characters.skins` (the character kit's own by default), and the page draws every character, the creator's skin swatches and the round table's seats with them, so a stored look keeps its skin index and takes the new tones as they are. Pass `characters: { skins: EAST_ASIAN_SKINS }` (from `pi-roundtable/characters`) for light East Asian tones. Needs `pi-roundtable` with the option (`HostEnv.characterSkins`).
- A room switcher on phones (screens under 1024 px wide). A swipe right over the messages pulls in a drawer of rooms that follows the finger and snaps open past 40 % of its width or on a fast flick; a tap on the header picture opens the same drawer. Swiping left, tapping outside, Escape or the system Back closes it: opening pushes a history entry, so Back closes the drawer before it leaves the room.
- The drawer lists each room with its picture, name and status (working, cards waiting, yolo, long-running); rooms with a card waiting come first under "Waiting for you", the rest follow by latest activity, and a search field narrows the list. A tap on a row opens that room in place, with no list page in between.
- A room keeps the text typed in its message box and not yet sent while the person is in another room (kept for the page's lifetime; attached files are not kept).
- The swipe never starts from a screen edge: a touch that begins within 32 px of the left or right edge is ignored and left to the system, since many phones use an edge swipe for Back. It also needs mostly horizontal motion (|dx| > 1.5·|dy|, at least 24 px) and ignores touches that begin in a field, a code block or table that scrolls sideways, or a card's option row (`data-swipe-ignore`). It slides with the console's motion lengths, which go to zero under `prefers-reduced-motion`.
- Traditional Chinese for the new wording ("Switch rooms").
- One action menu for a long press, a right click and the keyboard. A touch that rests 450 ms (and moves under 10 px, and does not scroll) opens it with a short vibration where the phone has one; a right click opens it at the pointer (Android's own `contextmenu` after a long press is answered once); the Menu key and Shift+F10 open it from the focused row. On a phone width (under 720 px) it is a bottom sheet that Back, Escape, a tap outside and a drag down close, like the drawer; elsewhere it is a popover at the pointer that keeps inside the window, takes focus, moves it with the arrow keys, Home and End, keeps Tab inside and closes on Escape, a press outside, the person's own scrolling or a resize. The lift that ends a hold does not also follow the row's link. Rows are not selectable and show no system callout while a message's words stay selectable.
- Where the menu opens: an agent's or group's row in the room list and in the drawer (Edit agent, Change look, Yolo mode and Long-running mode as switches, Start over with its confirm; a group has no edit or look, a dispatch thread has no menu); a message (Copy, Copy as Markdown, Quote reply, Select text, and Share where the browser can; Copy takes what is selected inside the message when something is); a message's picture (Agent profile); a card (Copy details: title, text, tool, action, input and files); a file or picture (Download, and Share where the browser can, sending the file itself where the browser allows it and its address otherwise). The innermost target answers, so a file chip's menu opens instead of its message's.
- Edit agent opens the agent's profile, and Change look opens it at the character creator. From the phone drawer the drawer closes first, so Back does not return to it. Quote reply puts the message as a Markdown quote into the room's message box below what is typed, and keeps it in the room's draft when the box is not open.
- A message takes focus (a tab stop) so the Menu key can open its menu.
- Traditional Chinese for the new wording.
- The agent sheet. Tapping the room header's name (an agent's room; a group has none) opens it, and so do Edit agent and Change look in the menus, the room's ⋯ menu and an agent's picture in a message. It is a wide sheet on a desktop and a bottom sheet on a phone. The header's picture stays the switcher's button on a phone, so each tap target has one meaning. It holds what the old profile page edited (display name, prompt, model, thinking level, and the character creator, which Change look scrolls to) and:
  - A prompt editor with a Full screen button that opens the text in a window-sized sheet, and, when the prompt changed, a Review changes step before the save: the changed fields, then the prompt as a line diff with added and removed lines marked. A save that leaves the prompt alone goes straight through.
  - Model and thinking level as chips (the saved choice is pressed) in place of two drop-downs; the thinking levels read in the console's language.
  - A Notifications switch. Off mutes the room's push for every owner and device.
- Per-room push mute. `PUT rooms/<key>/mute` with `{muted: boolean}` (an agent's or group's room, an owner, the console's own Origin, like the other writes; `404` for a room that is not the app's or is a thread, `400` for a body without a boolean) stores the room in a new table, `web_push_muted_rooms` (created idempotently by the web plugin's migration), and tells every open page to read the room list again. The room list gives a muted room `muted: true`. An agent's post in a muted room, or in a thread under it, is not pushed; a waiting card, the long-running cap and a notice (which always names the home room) still are. The quiet hours still hold a notice. A mute that cannot be read does not silence the owner, and logs a warning. Muting is the owners' choice for the room, not a device's. A muted room shows a bell-slash in the list, the drawer and the header, and Notifications is an item of the room menu, the row and drawer menus (a checked item means pushes are on) and the room's ⋯ menu.
- The router's `navigate` takes `{ replace: true }` for a step that stands in for another.
- Traditional Chinese for the new wording.

### Changed

- The characters' parts are drawn medieval (the core's change): the creator's strips show a biretta, a chaperon, a pilgrim hat, an iron skullcap, a mail hauberk, a doublet, an astrolabe, dividers and the like in place of the modern ones, under the same part ids. The English names are in `character-labels.ts` and the zh-TW names in the built-in catalog (`character.hat.mortar`, `character.hat.goggcap`, `character.hat.beret`, `character.hat.goggles`, `character.hat.tallcap`, `character.hat.tricorn`, `character.hat.hardhat`, `character.hat.toque`, `character.hat.cavalier`, `character.hat.fcap`, `character.hat.sailor`, `character.outfit.armor`, `.apron`, `.chef`, `.coat`, `.overalls`, `.vest`, `.sailor`, `character.prop.flask`, `.map`, `.telescope` and `.wrench`); a host that words them itself keeps its wording.
- The test that holds the characters to their share of the first load allows 16 KB gzipped (was 15 KB), for the skin tones the page now reads.
- The agent's own page is gone. `#/agent/<name>`, from a bookmark or an installed app's history, opens the agent's room with the agent sheet on top, in place of its own history entry, so Back goes where it would have gone from the room; a name that is not in the room list goes to the list. The wish "open at the creator" that Change look made is now a flag of the sheet.
- `Sheet` and `Dialog` take `size: "full"`, a window-sized panel. A sheet inside a sheet closes alone: its `cancel` (Escape) and `close` events no longer reach the sheet around it. Text that is visually hidden inside a sheet is positioned against the sheet's body, so a scroll to an element no longer scrolls the sheet's header out of sight.
- The room's menu (the ⋯ button) loads when it is first opened instead of with the page.
- A history step that lands on the page already shown no longer redraws the page or scrolls it to the top.
- `Dialog` is now a thin wrapper over `Sheet`, with an optional `size: "wide"` for documents. The panel has a padded header (title truncating with an ellipsis, an icon close button labelled "Close"), a hairline divider, a body that scrolls under a fixed header, and a uniform border; on phones it is a bottom sheet with a grab handle that can be dragged down. The Skills page's SKILL.md view uses the wide size and lists the frontmatter as a two-column key/value list (leaving out a `name` that repeats the title) above Markdown with a 72-character measure, where code blocks and tables scroll inside themselves. The fixture app now serves the Notes and Skills panes.
- The questions "Turn on yolo mode?" and "Start over?" are drawn by one host for the whole app, so the room menu, a row's menu and the drawer ask the same question in the same words.
- The round table is a council hall drawn in one style. The scene is the same flat, cel-shaded illustration as the characters (a stepped tone gradient on every surface and a dark outline round every solid shape, no photographic textures): a night stone hall of slate and navy with a teal rune circle on the floor, banners, torches with a flat flame, a stained-glass window with moonlight, and a ring of tall dark-wood podiums with a gold nameplate on the front and back. Light is the same hall by day (warmer stone, sun through the window); the Camelot look recolours the banners and the trim and leaves the hall alone. An agent stands behind its podium as a waist-up standee: the character without its frame, cut out along its outline with a thin light rim, turning to the camera within limits. A thinking seat shows a "…" badge and bobs, a waiting seat a gold "!", a speaking seat a light on its podium; a "done" and an "error" seat have a tick and a cross. The owner's own podium is the camera's home, and a ring of more than twelve agents shows twelve and a "+N" podium. Names are drawn through a font stack that carries Chinese (`system-ui`, PingFang TC, Noto Sans TC, Microsoft JhengHei), so a zh-TW name is lettered as the page shows it; the old 3D labels printed boxes.
- The table has two cameras. The overview stands behind the owner's podium, raised, and a drag or swipe turns it round the ring and snaps to a podium; a wheel turn or a pinch moves in on the podium across the ring and back out. The close-up of a speaker stands low inside the ring, tilted a little, with the speaker large and the others soft behind it, and thin speed lines flash for 400 ms on a new speaker. A turn follows the ring the shorter way and takes 450 to 650 ms. Under `prefers-reduced-motion` the camera cuts, and there are no speed lines, bob or flicker. A swipe never starts within 32 px of the screen's edge. The scene stops drawing while the page is hidden or the table is off screen, draws a few frames a second while nothing moves (so a torch flickers without keeping the GPU busy), and caps the pixel ratio at 2 (1.5 on phones). three.js stays a lazy chunk of its own.
- The names of the seats are page elements laid over the podiums, not a texture: at least 12 px on the screen at any distance, in a font stack that carries Chinese, and each is a button for the seat, so a name can be tapped and a keyboard reaches every seat. The agents stand side by side across the ring from the owner's own podium, which sits low at the near edge so the rune circle and the other podiums are in view, and the standees stand about half as large again, chest and hands over the desk. The standee's board has a dark line outside its light rim and a thickness in a mid tone of the seat's colour, so it reads on the fairest skin. A speaking seat gets the concept art's three gold emphasis strokes beside its head, which pop in with a small bounce.
- A dialogue box on the Round table page. Tapping a podium (or its name) turns the camera to that agent, and a box slides up as the camera arrives, with a nameplate tab in the speaker's colour and picture, the line being said (Markdown, typed out while it streams, a tap or Enter shows it whole, no typing under reduced motion), the cards waiting for an answer in the room's own card components, and the room's message box beneath, with its unsent text kept per room. A Log button opens the room's whole message list as a sheet over the scene; a "back" button returns to the whole ring. The address is `#/table/<agent>` (an agent's name or the key of its room): Back returns to the whole ring, a link opens the scene at that agent, moving from one agent to another replaces the address, and an address that names nobody seated goes back to `#/table` in place. Traditional Chinese for the new wording.
- A group room's "Table" button now switches the room between its list and the scene, and the choice is kept per room (it opened a panel or sheet with the members' table before). In the scene the whole group conversation runs in the dialogue box, the camera turns to whoever replies and rests on the whole ring while the owner speaks, a seat tapped by hand holds until the next line, and a speaker change never takes the focus from the message box. Under Camelot the compact strip of the members still stands under the header in the list view.
- On a phone held upright the scene fills the top 55 % and the dialogue box the rest, and the box collapses to its nameplate line; on its side the scene is whole and the box lies over its bottom third.
- The no-WebGL table (and the compact strip) draws the same hall in SVG: podiums with gold plates that letter Chinese, standees cut out with a rim and a dark line, the owner's low desk, the focused seat marked, the same palette and the same dialogue box over it.


## [0.23.2] - 2026-10-29

### Added

- Quiet hours for Web Push, 23:00 to 08:00 by default. In the window an agent's post and a notice (the `notify` tool, and a notice another channel delivered) are not pushed, so a night report waits in its room; a card (one waiting, or "Long-running cap reached") is still pushed. The window is read on the console's time zone, through `Intl`, and may cross midnight.
- The option `push.quietHours`: `{ start: "HH:MM", end: "HH:MM" }` (two different times on a 24-hour clock) or `false` for no quiet hours. Anything else stops the start, like the other options.
- Settings shows the window and its time zone to the owner, read-only, in English and Traditional Chinese (`SessionView.quietHours`).

## [0.23.1] - 2026-10-29

### Added

- A built-in Traditional Chinese (Taiwan) catalog, used when `presentation.locale` is `zh-TW`, `zh-Hant-TW` or `zh-Hant` (any case, `_` or `-`). It covers every string the page translates, the character creator's classes (`character.class.<id>`), what each suits (`character.jobs.<id>`), parts and palettes, the sign-in page and the fixed wording of the server's refusals. A key in `presentation.messages` wins over the catalog, and every other locale stays in English. A test fails when a string in the page's code has no entry.
- The round table words its screen-reader labels (the table and each seat's state) through the page's dictionary instead of in English only.
- The page translates the app API's refusals (`There is no such room, agent or file.` and the like) through the same dictionary.

### Fixed

- The header's brand mark shows the served install icon (`<mount>/icons/192.png`, so `icons.dir` changes it too) instead of a fixed sparkle.

## [0.23.0] - 2026-10-29

The package becomes the owner app of a host, and keeps the console that came first.

### Added

- The owner app (`rooms` pane, on by default): the same agent team as on Discord, in rooms of its own, one per active agent and group, with Home the coordinator's. `surface` (default `app`) is the rooms' key prefix and `cardGraceSeconds` (default 120) how long a turn waits on a card. A WebSocket at `<mount>/api/socket` (subprotocol `roundtable.app.v1`) carries messages, Stop, cards (approval, question, questionnaire, time limit), progress, typing, modes and yolo approvals to every open page of every owner; its upgrade passes the console's authenticator and origin, closes with 4401 when the credential lapses (an hour at most under `password`, so a logout or a new password ends it) and with 4403 when its person is no owner, and every frame that changes something reads the owner's tier again. REST under `api/`: `session`, `rooms`, `rooms/<key>/messages`, `rooms/<key>/mode`, `rooms/<key>/start-over`, `uploads`, `files/<id>`, `schedules`, `agents/<name>`, `agents/<name>/character`, `models`, and `avatars/<hash>.png`. Messages are kept in `web_room_messages`, uploads and reply files under `<dataDir>/web/`, and files are served as downloads with `content-security-policy: sandbox` and `nosniff`. A room key a client names must be one of the app's rooms whose agent or group exists, and a message from a visitor a verifier admitted without an actor is refused with `forbidden`. `PANES` gains `rooms`, `schedules` and `table`; `ConfigView.app` tells the page the surface. See the README's "App protocol".
- The owner app's page (`rooms` pane), mobile first: a bottom tab bar under 720 px and a side rail above, with the older panes under "More" on a phone. **Rooms** lists Home (the coordinator's room) first, then agents, groups and dispatch threads, with badges for working, cards waiting, yolo and long-running. A **room** shows each message with its author's picture and name, Markdown with raw HTML left as text, files, a live progress strip (streamed text, tool chips, Stop), and inline cards: approvals with their details and a copy button, questions with options, Other and Cancel, questionnaires, a turn's time-limit card in its own `wording`, and late cards. The composer sticks above the keyboard, takes files (button, paste or drop) and shows Stop while a turn runs. The room's menu turns yolo mode on (after a confirmation that says what it approves) and off, turns long-running mode on and off, starts over (after a confirmation) and opens the agent's **profile** (name, prompt, model, thinking); a banner stays at the top of a room while a mode is on, and yolo approvals appear in the conversation. **Schedules** lists and cancels; **Settings** has the color scheme, an install hint or button, and Log out under `password` auth (`SessionView.auth` tells the page the mode). Ctrl or ⌘ + K switches rooms. Every string is an English key for `presentation.messages`.
- Dispatch threads on the owner app: the app's surface implements the core's `SurfaceThreads`. A coding or background dispatch, or a `message_agent` between rooms, started in a room opens its thread there: one start line in the room, edited to link the thread once it exists (the new `edited` frame), then the dispatch's posts, its cards and its report in the thread's room, where agents speak under their own names and a coding worker's progress is edited in place. A thread's room is read only (`send` is refused with `read_only`) but its cards are answered there. Closing marks the thread closed and keeps it readable; after a restart the host closes the threads the last run left open, with a restart notice. The room list nests each thread under its room with the finished ones folded away (`RoomView.closed`; the list keeps the 30 newest), the start line links the thread's room, and a room list that does not know a thread yet is fetched again before the page says the room is missing. `RoomLog.edit` and `WebThreads.list` are new; `WebThreads.listOpen` is gone.
- Above 1024 px the room list stands beside the open room, with the open one marked. A failed update of the page (code that a release replaced while it was open) reloads once by itself and otherwise shows a card with Reload; any other failure shows the same card instead of a blank page. A message that cannot go says "Not sent" with Try again and Discard, a lost connection shows a banner under the room's header, and answered cards show the answer given. Opening or reloading a room in place (a link, a notification, an installed page restoring its route) works, and Enter that commits an input method's text does not send the message in Safari.
- Ended cards stay in a room's history. An approval, a question, a questionnaire or a time-limit card is kept in the new table `web_room_cards` when it ends, with its outcome (`approved`, `declined`, `answered`, `expired`, `cancelled`, `withdrawn`), who answered, what was answered (the choices and text, or each answer and the note) and when, and `GET rooms/<key>/messages` returns `cards` beside `messages` and `more`: the cards that opened within the page's span, so every card is on exactly one page and stands among the messages by `PromptFrame.at`, as a card sent again after a reload does. A reload, a new tab or an automatic reload no longer loses them, and the page no longer keeps only the newest 30 ended cards: it keeps those of the messages it holds. `prompt_closed` carries `by`, `answer` and `closedAt` too, so a page that watched the card shows what one that reloaded shows; a card that is shown already approved keeps its wax seal still. `ClosedCard`, `CardAnswer`, `MessagesView.cards` and `CardLog` are new; the owner app lists `CardLog.migration` (add only).
- `ServerFrame` `refused` carries `prompt` when the refused frame answered a card, and `PromptFrame` carries `at` (when the card opened), which places a card sent again after a reload among the messages by time.
- Files of any kind, 100 MiB each (the `uploadMaxBytes` option), streamed to disk as they arrive instead of held whole. An image is checked by its first bytes, a UTF-8 text is kept as text (`text/markdown`, `text/csv`, `application/json` or `text/plain`), and anything else as `application/octet-stream` with its own name; the type the browser reported no longer decides, and `ready.uploads.types` is gone. A person may have 16 files and 400 MiB waiting, and a file over the limit is refused with 413 before it is read when its length says so. Stored files are streamed back, not read whole. See the README's "Uploads".
- A paste of 4,000 characters or more becomes a `pasted-text-<n>.txt` chip (with its size and first line; a click puts it back in the box when it fits), and a message over 32,000 characters is sent as `message.txt` with the line "(long text attached)". A full set of file slots says so instead of dropping the file.
- The `auth` option: `{ mode: "none" }`, `{ mode: "password" }` or `{ mode: "verifier", verifier }`. The `verifier` option stays as shorthand for the last, giving both throws, and giving neither still refuses to start. One authenticator now checks every request, page, API and event stream, in place of the server's own admission step, and the owner app's WebSocket upgrade will use it too.
  - `none` must be written out. It serves only on a unix socket or TCP on `127.0.0.1`, `::1` or `localhost`, unless `trustNetwork: true`; it warns at every start, and speaks for the primary owner (or `principal`) through the plugin identity `token:web-console`.
  - `password` reads a secret of at least 12 characters from the environment (`ROUNDTABLE_WEB_PASSWORD` by default), serves a login page with no script, and sets a signed `HttpOnly`, `SameSite=Strict` cookie (`Secure` over https) keyed from `<dataDir>/web/session.key` and the password, so a new password signs everyone out. A failed login waits one second, ten failures in 15 minutes lock every login with `429` and `Retry-After`, and `POST <mount>/auth/logout` clears the session.
- `Verdict.admitted.expiresAt`: when a verifier's assertion lapses. `cloudflareAccess` fills it from the token's `exp`, and `admitAs(actor, expiresAt?)` takes it.
- An installable app (PWA). `<mount>/manifest.webmanifest` (`id`, `start_url` and `scope` are `<mount>/`, `display: standalone`, `title` as the name, colors from `appearance.look`), `<mount>/sw.js` and `<mount>/icons/*`; the page links the manifest with `crossorigin="use-credentials"` so a proxy cookie reaches it. The service worker precaches the hashed assets and `index.html`, serves assets cache-first and navigations network-first with the cached shell as the offline fallback, never touches `api/`, `auth/`, `login`, `files/` or `avatars/`, and returns redirects untouched, so a proxy's login still works and a shared device keeps no data after logout. The package ships the five icons (`192.png`, `512.png`, `maskable-512.png`, `apple-180.png`, `badge-96.png`); `icons.dir` replaces the set, and the release preflight requires `dist/sw.js` and the icons. Settings shows an install button where the browser offers one and the iPhone hint otherwise.
- Web Push for the owner app (`rooms` pane). An owner turns it on per device in Settings, where every device is listed and can be removed; logging out unsubscribes the device. The server pushes only when no page of that owner is in view: when a card opens in an app room ("Card waiting", or "Long-running cap reached" for a time-limit card in a long-running room), when an agent posts in a room that no message from a page started (a schedule's or report's reply, or a late one), and for a `notify` notice, through a new `DirectChannelProvider` named `web:<surface>` (`deliver` writes the notice in the Home room and pushes it, `mirror` only pushes when another channel such as Discord delivered). The payload is sealed for the device with RFC 8291 `aes128gcm` and posted with an RFC 8292 VAPID token, using WebCrypto and the existing `jose`, with no new dependency; it carries a title, the room key and, unless `push.preview` is `false`, the first 120 characters. The VAPID key is made on first start in `<dataDir>/web/vapid.json` (0600) and a file that cannot be read stops startup. A subscription's endpoint must be `https` on a known push service (Google, Mozilla, Apple, Microsoft, or `push.endpointHosts`), or the request answers 400; a 404 or 410, or five failures in a row, drops the device. New routes `GET api/push/key`, `GET/POST/DELETE api/push/subscriptions` and `DELETE api/push/subscriptions/<id>`, table `web_push_subscriptions`, option `push` (`preview`, `endpointHosts` and `subject`, the VAPID contact, which defaults to an https `origin`; push stays off, and devices cannot subscribe, until one is set), and the service worker's `push` and `notificationclick` handlers. `SessionView.push`, `PushKeyView`, `PushDevicesView` and `PushDeviceView` are new.
- Characters in the page (`rooms` pane). Agents are drawn as their composed characters on the room list, in the room's header, in messages, in the room switcher and on the profile, in place of the drawn pictures. Each character moves with its state (`thinking`, `working`, `waiting` while a card is open, `done`, `error`, `sleepy`), which the page works out from `activity`, `presence` and the cards, and stands still under reduced motion; an agent's accent color (`--agent-accent`) colors its row, header, progress strip and composer focus ring. The profile gains a creator: a live preview that cycles the states, the 24 classes, eight palettes and custom colors, strips for the parts, "Suggest from role", "Randomize", and Save through `PUT api/agents/<name>/character` with a refused field shown under its strip. Settings picks the Modern or Camelot look per device, and `ConfigView.look` goes on the page as `data-look`. The page checks every spec with `parseCharacter` before it draws one and injects only `composeSvg`'s output. The character kit loads as a chunk of its own, so the first load grows by under 4 KB gzipped. `RoomState` gains `phase`, `agent`, `outcome` and `presence`, and the labels are the message keys `character.class.<id>`, `character.<kind>.<id>` and `character.palette.<name>`. See the README's "Characters in the page".
- Characters on the server (`rooms` pane). An agent room's `RoomView.character` and `AgentProfileView.character` carry its composed character, and `PUT api/agents/<name>/character` changes it (owner only, at most 4 KiB; `400 {error, field}` for a look that is not a character). `activity` frames gain `phase`, `agent` and `outcome`, a `presence` frame says which agents are busy, even in Discord, and `appearance: { look: "modern" | "camelot" }` sets the default look and the manifest colors (`ConfigView.look`).
- The Camelot look (`rooms` pane). Under `appearance.look: "camelot"`, or a device's pick in Settings, the page takes parchment and night-castle colors with gold, serif headings from the system fonts, gold rules and header corners, the shield frame on characters, a wax seal in the agent's accent on an approved approval card (stamped in 450 ms when the card turns approved while the page shows it, still on a card shown already approved, hanging over the card's lower corner), and a candle and rune strip on the progress strip. The `theme-color` tags and the pre-paint `theme-init.js` follow the look and the scheme, and the script puts `data-look` on the page before the first paint. Settings shows each look as a swatch with a line about it. Everything is CSS and transform or opacity animation, static under reduced motion, with no new font or image. `PAGE_COLORS` (`src/page-colors.ts`) holds the toolbar colors, `themeInitScript(look)` and `presentPage`'s fourth argument carry the look, and `bun run fixture:app` takes `LOOK=camelot`. See the README's "The Camelot look".
- The round table (`table` pane, on by default after `rooms`, and needing it). Every active agent sits at one round table, the coordinator first, in every look: the seat shows the character in the shield, the agent's accent and its state (`sleepy` as `idle`, and `speaking` for the member a group round names), and a click opens the agent's room. A change of face redraws that seat's picture after 300 ms. A WebGL scene (the `three` chunk is fetched when the view first opens, never precached) or an SVG table where there is no WebGL; the camera starts high enough for the ring to fill a phone's canvas, more than ten seats on a phone are also listed as buttons, and under reduced motion the table is one still frame. A group room's header gains a "Table" button (a sheet on a phone, a panel elsewhere) and, under Camelot, a compact strip of its members with the speaker lit. Seat names are drawn in front of the table and of every badge, at 11 px or more (the plates grow with the canvas as far as their neighbours leave room, and where that is not enough the plates carry only their color bar and the seats are listed as buttons under the table), and cut with an ellipsis only when longer than their plate; the seat across the table stands a little higher so the far edge does not cut its head; `?nogl` on the page address draws the SVG table. `PANES` gains `table`; the default `panes` list becomes `rooms`, `table`, `overview`, `schedules`, `conversations`, `notes`, and a host that lists its panes keeps them as written. See the README's "The round table".
- Light and dark color schemes, from one token file (`web/tokens.css`): the page follows the system until the person picks one in Settings or with the header button, which is kept in `localStorage` and applied before the first paint; the switch grows as a circle from the button where the browser has view transitions. Motion is limited to `transform` and `opacity` and stops under `prefers-reduced-motion`.
- `bun run fixture:app`: a host over a scratch PostgreSQL database with scripted agents (`approve`, `ask`, `quiz`, `timeout`, `late`, `stream`, `dispatch`, `exchange`) for trying the app in a browser.

### Changed

- **Breaking:** the default `panes` are `rooms`, `table`, `overview`, `schedules`, `conversations`, `notes` (they were `overview`, `conversations`, `notes`). An explicit list is kept as written, so a host that listed its panes adds the new ones by hand; `schedules` and `table` need `rooms`.
- The `verifier` option is shorthand for `auth: { mode: "verifier", verifier }`; giving both `auth` and `verifier` throws, and giving neither still refuses to start. One authenticator now checks every request, in place of the server's own admission step.
- The agent reads an upload up to `uploadMaxBytes`, not 25 MiB: the app's surface declares `maxAttachmentBytes` as that limit, and `readAttachment` answers `{ path }` of the stored file instead of its bytes, so the host copies a large file from disk without holding it. A file over 25 MiB reaches the turn as a file for tools (not shown to the model, not read by `read_attachment`). The upload route asks the listener for `uploadMaxBytes` plus the form's framing (`maxRequestBodyBytes`), so `uploadMaxBytes` is no longer capped at 120 MiB; any whole number of bytes the listener can be asked for is accepted. `ConsoleServer.routes` takes that limit as its second argument, and `Uploads.read` answers an `AttachmentFile`.
- The theme colour follows the page's scheme (a `<meta name="theme-color">` for each, and `<script src="theme-init.js">` in the head applies a stored scheme before the first paint, as a file because the page's policy allows scripts from itself only); the manifest's colours are the light page's. Buttons, inputs and switches are at least 44 px high on a phone or with a coarse pointer, and control borders and the off switch meet 3:1 contrast. The progress strip has no Stop of its own (the composer's replaces Send while a turn runs), and a time-limit card without its own wording says "Stop turn".
- The fixture host (`bun run fixture`) takes `FIXTURE_AUTH=cloudflare|none|password`, and serves the `overview`, `conversations` and `notes` panes only.
- The Discord link and Cleanup are not offered for an agent group that has no channel: `GroupView.channelId` is optional and the overview card shows neither without it.
- The push subscription routes cap the body at 8 KiB of bytes (the declared length and what streams in) and refuse a body that starts with a byte order mark.

### Security

- `none` and `password` resist the network, not an agent whose shell runs as the same user: that agent can reach the listener's socket, the password variable and `<dataDir>/web/session.key`, and so act as the owner. Only a `verifier` resists it. The README's Authentication section describes the modes, and its threat model says what each does not resist.
- Every write needs an authenticated owner whose tier is read again, the owner app's JSON bodies are counted as they stream against a 64 KiB limit, and a download name's `'`, `(`, `)` and `*` are percent-encoded and bidirectional override characters dropped. The owner app's uploads are streamed to disk and counted, and a form cut short leaves no file behind.

## [0.22.5] - 2026-10-25

- Release in lockstep with pi-roundtable 0.22.5. `engines.bun` is now `>=1.4.4` (was `1.3.0`) so no supported setup runs a Bun with the Brotli decoder bug (CVE-2026-111497). The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.4] - 2026-10-25

- Release in lockstep with pi-roundtable 0.22.4; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.3] - 2026-10-23

- Release in lockstep with pi-roundtable 0.22.3; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.2] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.2; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.1] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.1; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.0] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.0. The core peer range moves to `>=0.22.0 <0.23.0`. The skills page shows skills from npm packages, with the package as their source.

## [0.21.0] - 2026-10-20

- Release in lockstep with pi-roundtable 0.21.0. The core peer range moves to `>=0.21.0 <0.22.0`.

## [0.20.0] - 2026-10-18

- Release in lockstep with pi-roundtable 0.20.0. The core peer range moves to `>=0.20.0 <0.21.0`.

## [0.19.2] - 2026-10-18

- Release in lockstep with pi-roundtable 0.19.2. The core peer range stays `>=0.19.0 <0.20.0`.

## [0.19.1] - 2026-10-18

- Release in lockstep with pi-roundtable 0.19.1. The core peer range stays `>=0.19.0 <0.20.0`.

## [0.19.0] - 2026-10-17

- Release in lockstep with pi-roundtable 0.19.0. The core peer range moves to `>=0.19.0 <0.20.0`.

## [0.18.0] - 2026-10-17

- Release in lockstep with pi-roundtable 0.18.0. The core peer range moves to `>=0.18.0 <0.19.0`.

## [0.17.3] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.3; no package-specific behavior changes. The core peer range stays `>=0.17.0 <0.18.0`.

## [0.17.2] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.2; no package-specific behavior changes. The core peer range stays `>=0.17.0 <0.18.0`.

## [0.17.1] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.1; no package-specific behavior changes. The core peer range stays `>=0.17.0 <0.18.0`.

## [0.17.0] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.0; no package-specific behavior changes. The core peer range moves to `>=0.17.0 <0.18.0`.

## [0.16.0] - 2026-10-16

- Release in lockstep with pi-roundtable 0.16.0; no package-specific behavior changes. The core peer range moves to `>=0.16.0 <0.17.0`.

## [0.15.4] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.4; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.3] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.3; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.2] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.2; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.1] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.1; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.0] - 2026-10-14

- Release in lockstep with pi-roundtable 0.15.0; no package-specific behavior changes. The core peer range moves to `>=0.15.0 <0.16.0`.

## [0.14.1] - 2026-10-14

- Release in lockstep with pi-roundtable 0.14.1; no package-specific behavior changes. The core peer range stays `>=0.14.0 <0.15.0`.

## [0.14.0] - 2026-10-14

- Release in lockstep with pi-roundtable 0.14.0; no package-specific behavior changes. The core peer range moves to `>=0.14.0 <0.15.0`.

## [0.13.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.13.0; no package-specific behavior changes. The core peer range moves to `>=0.13.0 <0.14.0`.

## [0.12.1] - 2026-10-13

- Release in lockstep with pi-roundtable 0.12.1; no package-specific behavior changes. The core peer range stays `>=0.12.0 <0.13.0`.

## [0.12.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.12.0; no package-specific behavior changes. The core peer range moves to `>=0.12.0 <0.13.0`.

## [0.11.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.11.0; no package-specific behavior changes. The core peer range moves to `>=0.11.0 <0.12.0`.

## [0.10.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.10.0; no package-specific behavior changes. The core peer range moves to `>=0.10.0 <0.11.0`.

## [0.9.13] - 2026-10-13

- Release in lockstep with pi-roundtable 0.9.13; no package-specific behavior changes.

## [0.9.12] - 2026-10-11

- Release in lockstep with pi-roundtable 0.9.12; no package-specific behavior changes.

## [0.9.11] - 2026-10-11

- Release in lockstep with pi-roundtable 0.9.11; no package-specific behavior changes.

## [0.9.10] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.10; no package-specific behavior changes.

## [0.9.9] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.9; no package-specific behavior changes.

## [0.9.8] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.8; no package-specific behavior changes.

## [0.9.7] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.7; no package-specific behavior changes.

## [0.9.6] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.6; no package-specific behavior changes.

## [0.9.5] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.5; no package-specific behavior changes. 0.9.4 was tagged but never published.

## [0.9.3] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.3; no package-specific behavior changes.

## [0.9.2] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.2; no package-specific behavior changes.
- The README named `>=0.8.0 <0.9.0` as the peer range of pi-roundtable; it is `>=0.9.0 <0.10.0`.

## [0.9.1] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.1; no package-specific behavior changes.

## [0.9.0] - 2026-10-09

- Admit only owners, each as their own principal: the verifier reports who signed in (`Verdict.actor`, built with `admitAs`), and the console reads the host's `IDENTITY`, never making or claiming a principal. An identity linked to anyone but an owner is refused, and so is one linked to no one, on a single-owner host too, with one warning per identity that names the line to add to `access.owners[].identities` and the `roundtable principal link` command. An identity of the `legacy` provider, an alias 0.9 keeps for a 0.8 id, is refused. A verifier that reports no actor is taken as the primary owner, or `ownerId`, with one warning. The plugin now requires `IDENTITY`.
  **Upgrading:** add your Access identity, `cloudflareAccessIdentity(teamDomain, sub)`, to your entry in `access.owners[].identities`, or the console answers 403 and logs the identity to add; see the README's "Upgrading from 0.8".
- `cloudflareAccess` reports the user as `oidc:<base64url(https://<teamDomain>)>:<sub>`, named by their email, and refuses a token that names no user; `cloudflareAccessIdentity(teamDomain, sub)` writes that identity for `access.owners[].identities`.
- The Notes pane shows the signed-in owner's own notes, and any principal's through a picker (`GET api/principals`, `?principal=<id>` on the notes API). `ownerId` is no longer required and is deprecated.
- A conversation the host's registry records shows whose it is, by display name, and whether it is private or shared (`ConversationView.principal`, `visibility`).

## [0.8.0] - 2026-10-07

- List the conversations the host's registry (`CONVERSATIONS`) records beside the ones found by their directory names, under a new "Plugin conversations" section with their title and first message, and read their transcripts. A conversation from before the registry is still found by name.

## [0.7.18] - 2026-10-05

- Release in lockstep with pi-roundtable 0.7.18; no package-specific behavior changes.

## [0.7.5] - 2026-10-03

- Show a skill of any size, and add `skills.errorDetail` to show why one cannot be read.

## [0.7.4] - 2026-10-03

- Show a `channel name unavailable` detail for a channel Discord cannot name.

## [0.7.3] - 2026-10-03

- Add feature ports (notes, skills, connectors, cleanup), page presentation and routing options, and the matching console pages.

## [0.7.2] - 2026-10-02

First release published by the lockstep workflow; no changes to the package.
The `v0.7.1` tag published nothing.

## [0.7.0] - 2026-10-02

Prepared for the first npm publication.
The earlier `0.1.0` was local-only and was never published on npm.

### Changed

- Move into the pi-roundtable workspace with preserved Git history and lockstep version `0.7.0`.
  The core peer range is `>=0.7.0 <0.8.0`, and the shared `publish.yml` releases all packages from one `v*` tag.

### Added

- `webConsole(options)`: a plugin that serves a web console on a route of the host's HTTP listener, `/console` by default. The Overview pane shows the agent team, the Conversations pane lists the owner, agent, group-member (`agentgroup_<channel>_<agent>`), and outside-agent conversations stored on disk and shows each transcript (and its archives), and the Notes pane views and edits the owner's memory. The `panes` option chooses the panes.
- Live updates over a server-sent event stream: a change in the channel queue or the agent team, or a note written through the console, reaches an open page as one coalesced `changed` event.
- A `verifier` option, required: `RequestVerifier`, a function from a request to `{ admitted: true }` or `{ admitted: false, reason }`. The plugin throws when the config is loaded if it is missing, so a host never serves the console unauthenticated. `admit()` and `refuse(reason)` build the answers.
- `cloudflareAccess({ teamDomain, audience, email, keys? })`, the built-in verifier: it admits a request whose `Cf-Access-Jwt-Assertion` token is signed by the team's keys, issued by the team, addressed to the application, and carries an allowed email.
- Requests that change data must carry the console's own `Origin` (the required `origin` option); every response carries `nosniff` and a same-origin referrer policy, and the page carries a Content-Security-Policy with `frame-ancestors 'none'`.
- Options `ownerId`, `dataDir`, `mountPath`, `listener`, `title`, `relayNotes`, and `exclude`, checked when the plugin is created.
- The page ships prebuilt in `dist/` with relative URLs, so it works under any `mountPath` and an operator needs no build step. `bun run build` rebuilds it from a checkout.
- Types for the API shapes (`ConfigView`, `OverviewView`, `ConversationsView`, `TranscriptView`, `NoteView`, and the rest).
