# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A message in the app draws display blocks: a fence of the kind `cards`, `table`, `steps`, `stats`, `mindmap`, `mermaid` or `diff`, or a GitHub alert, becomes a panel instead of a code block, with the `pbs-*` elements of `pi-better-show` (a dependency, pinned exactly). The elements load as a lazy `chunk-blocks-*` that the worker precaches, so history draws offline; a message without a block never loads it. A block that does not parse, one that is not closed yet while a turn streams, and the interactive kinds (`options`, `form`, `suggest`, `checklist`, `review`, answered by typing in this release) stay code blocks, the first with the reason under it. Colors follow the console's light, dark and Camelot schemes, and a theme change redraws.
- `AppSurface.blocks` declares those kinds (a host's room, through `AppSurface.support`, draws none and its turns are not told to write them), so the host sends a reply whole and never cuts a fence; `APP_FORMATTING` tells the model how to write each kind.
- `GET api/diagram?scheme=light|dark&s=<base64url source>` draws a Mermaid diagram as an SVG image for `pbs-diagram`. Any admitted viewer may read it (tier `V`). A source over 8 KB is refused (413), one that cannot be drawn, or takes longer than 3 seconds, answers 422, and the last 200 verdicts are kept, a refusal included. The drawing runs in a worker thread, one at a time, so a heavy diagram never holds the console's event loop; more than five waiting answer 503. The answer carries `image/svg+xml`, `X-Content-Type-Options: nosniff`, an immutable private cache and its own Content-Security-Policy `default-src 'none'; style-src 'unsafe-inline'`; the page shows it only as an `<img>`, which runs no script. The page's Content-Security-Policy does not change.

## [0.37.1] - 2026-11-07

### Fixed

- An archived temp knight's or a dismissed thread's unread count no longer stays in the tab title and the tab dot until a reload: a room that leaves the room list takes its count with it, and a restored room brings the server's count back. A host room, which is never in the list, keeps its count; a finished helper that is still listed keeps its count until read.

## [0.37.0] - 2026-11-06

### Added

- `GET api/presets` answers `{ presets, max }` for owners: every active knight's presets, each with its `agent`, `sharedWith` and `recruits` (per recruiting knight, its `active` and `archived` temp knights and the `last` time one was made).
- `POST api/agents/<name>/presets/<preset>/transfer` with `{ to }` gives the preset to another knight and answers `{ preset }` as moved; a refusal of the team, such as a name the other knight already has, is a 400 in its words.
- A Presets page (`#/presets`, the new `presets` pane, listed on the More page) shows every knight's temp-knight presets, grouped by the knight each belongs to: a row per preset with its name, display name, skill count, whom it is available to (only its knight, all knights, or how many) and how often it was recruited and by how many knights. A search field and a knight filter narrow the list. A row opens the same preset sheet as the Edit knight sheet; "New preset" first asks which knight it belongs to. With no presets, or on a host without temp knights, the page says so. `presets` is in the default owner panes and needs `rooms`; a host that lists its panes adds it by hand.
- The preset sheet, wherever it opens, has a "Recruited by" section (each knight that made temp knights from the preset, with how many are active and archived) and, for a knight's own preset, "Transfer to…", which picks the knight to give it to and asks before moving it.

### Changed

- The Edit knight sheet is tabs under its header, which stay in view: Profile (the picture, notifications and the knight's fields), Skills, Presets (on a host with temp knights, for a knight that is not one), Look and More (the prompt's history and Archive). The arrow keys, Home and End move among them. The sheet opens on the tab shown last in the session, for any knight; `openAgentSheet` takes `tab: "profile" | "skills" | "presets" | "look" | "more"`, and `look` and `skills` still open theirs. An unsaved edit of the fields survives a change of tab, and the creator and the presets load only when their tab is first shown. The notes page's kinds use the same tab bar.
- The skill picker, on the Edit knight sheet and in the preset editor, shows the carried skills on top as chips that remove them, with the count and the built-in ones as one "N built in" chip that stays. Below, a search over names and descriptions, the skill groups as filter chips and a "Show carried" chip; the list shows the skills not carried, one line each with its description cut to the line (a tap shows it whole), and an add or remove button. It shows 8 rows with "Show all ({count})" when nothing is searched. A group picked as the filter shows its switch, which applies or removes the group as before.
- A room row or folder lifted by a long press wiggles while the finger rests on it, stops while it moves, and buzzes once where the phone can; with reduced motion it only lifts. The first 16 px of travel move it at 0.3× and it catches up with the finger by 48 px, so a resting finger no longer looks like it drags. The row's own list no longer shows the yellow dashed frame at lift; another list the row is taken into fills quietly instead of drawing a frame.

## [0.36.0] - 2026-11-06

### Fixed

- A system line in a room, such as a yolo approval quoting a whole command, wraps inside the room instead of widening it; the widened room scrolled sideways and kept the drawer's swipe from opening.

### Added

- Owner-only routes for a knight's temp-knight presets: `GET api/agents/<name>/presets` answers `{ presets, max }`, `PUT api/agents/<name>/presets/<preset>` saves one whole from `{ displayName, prompt, skills?, character?, model?, thinking? }` and answers `{ preset, replaced }`, and `DELETE` of the same path answers 204, or 404 when there is no such preset. A refusal by the team, such as an unknown skill or a 21st preset, is a 400 in its words. The session carries `helpers: true` when the host makes temp knights, and a temp knight's room and profile carry `helper.preset`, the preset it was made from.
- The Edit knight sheet has a "Temp knight presets ({count}/{max})" card under Skills: a row per preset with its name, display name, skill count and the first line of its prompt. A tap opens the preset in a sheet over the knight's, to change and save it whole; "New preset" makes one, and Delete preset asks first. A preset's name is fixed once saved, a refusal shows in the sheet, and a toast says it was created, saved or deleted. The card is left out for a temp knight and on a host without temp knights, and loads only when the sheet opens.
- A temp knight's row, on the rooms page and in the drawer, names the preset it was recruited from: "Recruited from writer", and `<agent>/<name>` for a preset another knight shared.
- Sharing a preset: `GET api/agents/<name>/presets` also answers `shared`, the presets other knights share with this one, each with its `agent`, and each preset carries `sharedWith` (`"all"` or a list of knights; absent for none). The `PUT` takes `sharedWith`: `"all"`, a list of knights, or `null` for none; left out, a replaced preset keeps its sharing. The preset editor has "Available to": Only {knight}, All knights, or Chosen knights, picked from the active knights with the same picker a group's members are picked with. The presets card lists the presets shared with the knight below its own, read-only and marked "Shared by {knight}"; one opens in a view of the preset that offers "Open in {knight}".
- "Save as preset" on the presets card opens a new preset filled in from the knight: its display name, prompt, look, model, thinking level and the skills it carries, the built-in ones aside; the person names it, and it belongs to this knight. "Create a knight from this" in a preset opens the new-knight form filled in from the preset, its skills included; the person names the knight. Both are copies, not links.

### Changed

- The new-knight form, the Edit knight sheet and the preset editor share one set of fields: name, prompt with full screen (and History on the sheet), model and thinking level. The model is one select grouped by provider everywhere, where the sheet showed a chip per model, so a host with many models still shows one line; the new-knight form gains the thinking level. The skill switches and skill groups are one list too: the sheet still saves each switch as it is flipped, the preset editor keeps them in its draft.

## [0.35.0] - 2026-11-06

### Added

- The room drawer shows a room's dispatch threads and temp knights: a row that has any carries a toggle with their count, which opens the rooms page's own thread list under it. The open room starts open and the choice is kept per room on the device; a tap on a thread or temp knight goes there and closes the drawer, and a thread card's swipe is its own, apart from the row's swipe to read and the drawer's swipe to close.
- A temp knight's row marks its room read when swiped right, on the rooms page and in the drawer, the way a room's row does, finished or not; only its own room is marked, not its knight's.
- Swiping a room's row left on the rooms page turns its modes, one step a swipe: none, yolo, yolo and long-running, none again (long-running alone goes to none). It is the same short pull that springs back as the read swipe, mirrored, and shows the modes it turns to. Yolo by swipe asks nothing; one notice names the new modes with an Undo that puts the old ones back. The badges change at once and come back if the server refuses. Read-only rooms, arrange mode, thread cards, temp knights' rows and the drawer are left as they were; the room menu's mode items stay, and still ask before yolo.

### Changed

- Home at the foot of the room drawer goes to the room list, the level above the rooms, instead of the home room; it is there in every room, with or without a home room.
- Swiping a row right to mark it read is a short pull that springs back, not a slide that looks like the row is leaving: the row follows half the finger's way and stops at 80 px, the check turns green and grows a little once letting go will mark it read (56 px of travel, or a flick), and it disarms if pulled back. On release the row springs back in 180 ms (at once with reduced motion) and the Read mark fades as it does. A thread card's swipe to clear still slides out.

## [0.34.0] - 2026-11-04

- Release in lockstep with pi-roundtable 0.34.0 (an agent's shell gets no host secret by default, GH_TOKEN included); peer range `>=0.34.0 <0.35.0`, no package-specific behavior changes.

## [0.33.0] - 2026-11-04

- Release in lockstep with pi-roundtable 0.33.0 (the agents' shell gets a whitelisted environment, secret reads and docker run/exec are held even in yolo, and tool output masks secrets); peer range `>=0.33.0 <0.34.0`, no package-specific behavior changes.

## [0.32.1] - 2026-11-04

### Added

- A message reads as Discord writes it: a line that starts with `-# ` is subtext, a small quiet line (a change report's closing note, for one), and a single line break inside a paragraph stays a line break. Code keeps `-# ` as written.
- The room drawer on a phone has a Home button at its foot that stays in place while the rooms scroll. A tap closes the drawer and opens the home room, the way a row does. Inside the home room it is marked current and only closes the drawer; with no home room there is no button.

### Changed

- Marking rooms read clears their unread counts at once, before the server answers, for every way to it: a row's swipe right, the room menu's "Mark as read", and "Mark all as read" on the page or a folder. A swiped row's badge is gone in the same frame the finger lets go. A refusal puts back the counts it cleared, except where a newer message has counted a room up meanwhile, and says why; Undo works as before.

### Fixed

- A test of a folder's "Mark all as read" waited a fixed time for the folder's menu and could find it not yet drawn on a slow machine; it now waits for the menu to appear.
- The main prompts page words the shared prompt's description in zh-TW again: the catalog keyed it by an older wording than the core registers, so it showed in English. A test now checks every label and description the core registers against the catalog.
- Settings lists the devices that get push without a list indent, each name centred on its Remove button.

## [0.32.0] - 2026-11-03

- Release in lockstep with pi-roundtable 0.32.0 (plugins hear member joins and manage member roles on Discord); no package-specific behavior changes.

## [0.31.8] - 2026-11-03

### Fixed

- The room drawer no longer flickers when a finger lets it go: the finger's place was cleared before the drawer's new state was drawn, so for one frame the panel jumped shut and then slid out again (or, closing, jumped open). The place is now cleared in the same frame as the new state, after every lift, and the panel slides on from where the finger left it.

## [0.31.7] - 2026-11-02

### Added

- A room's row marks the room read when it is swiped right with a finger, on the rooms page (arrange mode and Home included) and in the room drawer. The row follows the finger over a quiet "Read" mark and springs back; let go past 40 % of its width, or flicked, it marks the room read as "Mark all as read" does, with one notice and its Undo. A row with nothing unread only gives a little. A hold still opens the menu or lifts the row, a swipe on a thread card under the row stays the card's, and the drawer does not move with a row's swipe.
- The room menu has "Mark as read" while the room has unread messages: the way to the same action for a keyboard or a screen reader. The swipe's mark is hidden from screen readers.

### Changed

- The swipe a thread card clears itself with and the room row's swipe are one shared module, `lib/row-swipe.ts`: how a swipe is told from a scroll, a tap and a hold, the screen-edge guard, the flick, the threshold, the give of a row that cannot act, and less motion. A thread card behaves as before.

### Fixed

- A menu row that is a button or a link hovers in the quiet `--surface-3` fill with its own text colour wherever it is used, with 12 px on each side. A row of the prompt history sheet and of the files pane wrote only `menu-item`, so it took the base button's accent fill on hover, with light text on yellow, and its text sat 4 px from the fill's edge. The shared rule replaces the long-press menu's own hover, and `--surface-3` stands apart from a sheet's `--raised` background, which `--surface-2` all but matched. The button hover test now counts a hover scoped under another element only for the uses in that scope, which is how it missed these rows.
- The message box shows no scrollbar until its text passes its tallest height. Its height was set from `scrollHeight`, a whole number of pixels, while its padding is not, so a box could stand a fraction of a pixel short of one line of text, and a desktop browser that always draws scrollbars drew one beside it.

## [0.31.6] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.6 (channel context reads a peer bot's message up to `peerMessageChars`, default 4000); no package-specific behavior changes.

## [0.31.5] - 2026-11-02

### Added

- `RoomView.helper.origin`: the room a temp knight was made from, when that is a room of the app (a group's room when a member made it during the group's round). The cards a temp knight asks now show in that room, where its answer goes too, instead of in its knight's own room.

### Fixed

- An answered thread card vanished from the room above at once when the thread held more than a page of messages after it: the thread's trimming took it. It now stays until that room says something newer, as other carried cards do.
- The chat's "cards waiting" chip showed while every waiting card was in view, the first time a page opened a room's chat: the log's full version replaces the first one's card slots, and the chip kept watching the slots taken out of the page. It now watches the slot that stands.
- A room's cards could stand out of place after a reload, which hears the open cards after the ended ones the history brings: a room's views now take its cards in the order they opened.

## [0.31.4] - 2026-11-02

### Fixed

- A card asked in a dispatch thread (or a temp knight's room) did not show in the room the thread hangs under: neither the council's animated scene nor its chat mode showed it, only the waiting count in the top bar. Each view of a room now shows the cards of the rooms under it while they wait, and once answered until the room says something newer, under a "From <thread>" link to where it was asked; the record stays in the thread. The chat's "cards waiting" chip counts them too. The room list's per-room counts are unchanged, so no card is counted twice.

### Changed

- One rule for a room's cards (`web/lib/room-surface.ts`, `roomCards`) and one way to draw each (`RoomCardBody`) serve the chat, the scene's dialogue box and the waiting chip, which each filtered the cards themselves before. A test holds both council views, in the group's room and on the round table, to the same parts: messages, own cards, carried cards and the composer.

## [0.31.3] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.3; no package-specific behavior changes.

## [0.31.2] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.2; no package-specific behavior changes.

## [0.31.1] - 2026-11-01

### Fixed

- The animated scene's dialogue box named the owner as the one working: under the owner's line, its progress strip read "<owner> is working…" while a member ran tools. It now names the round's member, else the turn's agent, else the room's agent.
- In the animated scene the progress strip no longer takes the dialogue box's room: it folds to one line (who works and how many tools ran) that a tap opens to the tool calls and the streamed words. Chat mode keeps the full strip.

## [0.31.0] - 2026-11-01

- Release in lockstep with pi-roundtable 0.31.0; no package-specific behavior changes.

## [0.30.4] - 2026-11-01

### Fixed

- On a phone, typing in the animated scene's dialogue box no longer hides the message box under the on-screen keyboard. The scene used to keep its share of the height while the keyboard was up, so a message of three or four lines pushed the box's last line, the caret and the send button below the visible area. While the message box has the focus on a narrow screen, the dialogue box takes what it holds (at least its usual share), the scene gives way down to a sliver, and past 30 % of the visible height the message box scrolls inside. The layout returns when the message box loses the focus.

## [0.30.3] - 2026-11-01

- 0.30.2 was tagged but never published: its release run stopped on lint (a hook's dependency suppression the change had dropped) before any package was published. 0.30.3 carries 0.30.2's changes.

## [0.30.2] - 2026-11-01

### Fixed

- The animated scene now reports reading, as the chat log does. A stored message counts as read once the dialogue box shows it while the page is visible; a line still waiting in the box's queue, a reply still streaming and an owner's message not yet sent do not count, and a line shown while the page is hidden is reported when the page shows again. The open Log sheet reports the newest message in its view. Before, nothing in the scene moved the read cursor, so unread counts and other people's read marks stayed where the chat log had left them.

## [0.30.1] - 2026-11-01

### Fixed

- In a host's room, a message that is `/clear` or `/new` whole is sent as an ordinary message to the host kind, as any other text is: it is no longer caught for a refusal notice, so a host kind whose own conversation takes that text can receive it. A host's room still has no command menu.
- A Pi extension command is offered in a knight's command menu only when the plugin that declared it also registers it (see the core changelog).

## [0.30.0] - 2026-11-01

### Added

- `/clear` in the message box of an agent's or group's room starts the room over, as the room menu's Start over does: nothing is posted, the same question comes up first ("Start over <name>?"), and the screen clears to the one start-over line, with the old messages open read-only from it as the archived conversation. `/new` does the same. The text must be the command whole (spaces around it and the case do not matter); `/clear now` or a `/clear` with files waiting is a message like any other. A host's room keeps its own conversation, so `/clear` there answers with a notice instead of being sent.
- Typing `/` at the start of the message box opens a small menu of commands above it, with a line on each (`/clear` is the first): ↑ and ↓ move, Enter runs the choice, Tab writes its name into the box, Esc closes it until the text changes, and a tap picks on a phone without closing its keyboard. Nothing acts while an input method composes. The menu and its styles are a lazy chunk. `Composer` takes a `commands` list (`SlashCommand`: name, aliases, one-line description, `run`), so a command to come is one more entry in `lib/room-commands.ts`.
- In a knight's room the same menu also lists the skills the knight carries (`/skill:<name>`, built-in ones included) and the Pi extension commands that plugins declared safe for chat (`chatCommands`, see the core changelog); none of the second kind is listed until a plugin declares it. Picking one writes its name and a space into the box for the arguments, and the message is sent as it is: Pi expands a skill and runs an extension command, and only the owner's message can start either. `GET api/rooms/<room>/commands` (`RoomCommandsView`) lists them; it is an owners-only room route (404 to anyone else), and a group, a thread or a read-only room has none. `AppApiOptions.chatCommands` and `skills.carried` feed it.
- The `?` shortcut list names `/clear`.
- Typing `@` at the start of a word in a council's message box (chat mode and the animated scene) opens a list of the council's members over the box, filtered as you type. The arrows move, Enter or Tab pick, Escape closes it, and a tap picks on a phone; it never acts while an input method is composing. A picked member goes in as `@<display name> `. A leading `@AI` still only toggles the agent and never opens the list. The list is a lazy chunk.

### Changed

- The round table and a group's room share one header (`CouncilHead`): the council's picture, its name with "Group" under it, the reset button where the scene has one, the scene/chat switch, the waiting cards and the room menu. The separate "Council: <name>" chip is gone, and the name no longer shows twice. On the round table the name is the council picker (`<name> ▾` opens the council sheet); in the room it still edits the group, and the room menu has "Edit this council", which opens the same sheet. The header is one row on a 390 px phone.
- The scene/chat switch shows an icon beside its words on a desktop and the icon alone on a narrow or touch screen; the words stay for a screen reader and as the tooltip.
- A tap or click on a knight in the animated scene now also puts `@<display name> ` into the room's message box, at the caret or after the text, and focuses the box, as a tap on a podium in the chat-mode strip does. The camera still turns to that knight and the page does not navigate. The camera still follows only a member's own lines.

## [0.29.2] - 2026-10-31

### Added

- The groups you pick a room from fold like Discord's categories: the owners' folders, and the headings Pinned, Ungrouped, Knights and Groups in the room list, and the same headings and folders in a phone's room drawer. Tap the heading (a chevron, `aria-expanded`) to fold it; a folded group shows how many rooms it holds. The fold is kept per device in `localStorage`, shared by the list and the drawer for the same folder, Pinned and Ungrouped. Home and the drawer's "Waiting for you" never fold.

### Changed

- A tap or Enter on a podium in the council's chat-mode strip mentions that knight in the council's message box instead of opening the knight's room: `@<name> ` goes in at the caret when the box is the one being typed in, and after the text when it is not, and the box takes the focus. The strip's podiums now have the knight's menu too (a long press, a right click or the Menu key), where "Private chat" opens the knight's own room. The animated scene is as it was: a tap turns the camera.
- A folded group keeps its open room under the heading, plus any room with a card waiting for an answer or messages unread, as a Discord category keeps the selected and the unread channels. A folded folder used to open in full while it held the open room; now only that room stays and the others fold away behind the folder's picture stack. Alt+↑/↓ step over the rooms a fold hides. A search (the drawer's field, the room palette) still finds rooms in a folded group.

### Fixed

- In the council's chat-mode strip the room header no longer cuts the figures off at the chin. The figures were drawn larger than the 120 px strip, so only mouths and bodies showed; the podiums now size to the strip (a podium at most 67 px wide, 46 px at the narrowest) and every head stands whole under the header, from two members to eight, at desktop and 390 px width. The strip is as high as before.

## [0.29.1] - 2026-10-31

### Added

- A message's files are one attachment block: a heading "Attachments (N)" in a bordered box unlike inline code, each file a full-width chip with its icon, name and size, on phones and desktops. Agent rooms, host rooms, notes and the round table's dialogue box all show it; a host room still says how many files were removed.
- "Download all" in the heading of a message with two or more files downloads them as one zip, from `GET api/files/zip?room=<room>&message=<id>`. The route answers the room and each file as the single file route does, so someone who may not read the room gets the same refusal. It packs only the files still kept, each under its own name (a repeated name becomes `name-2`, `name-3`), in `attachments-<YYYYMMDD-HHMM>.zip` (the message's UTC time), stored without compression, and refuses past 200 MB with a message to download the files one by one. The zip is named after when the message was sent on the host's clock (`attachments-20261031-2028.zip`); `OwnerAppOptions.timeZone` and `AppApiOptions.timeZone` carry the host's zone, UTC when absent.
- A bubble with files that is taller than about one screen opens with a paperclip line "N attachments", which scrolls to the block, smoothly unless the person asked for less motion.

### Changed

- A swipe right opens the room drawer from anywhere in the left half of the screen, the left edge included, over the header and empty space as well as over the messages. It was the messages only, and not within 32 px of either edge. The right edge stays the system's Back, and the drawer closes by a swipe left from anywhere but there.
- Host rooms have the drawer too: the swipe, and a tap on the room's picture in the header. The waiting-cards strip of a host room moved to its own file.
- A message of yours sent while a turn runs shows where it stands under it, live and after a reload: "Added to this turn" when the running turn took it, "Queued" while it waits for its own turn (the line goes when the turn starts), and "Cancelled" for one you cancelled, which stays in the room dimmed and never runs. A queued message's long-press or right-click menu offers its author Edit (a sheet with the text; the turn runs on the new text and the message shows as edited) and Cancel. Once the turn has started a notice says it is too late. `RoomMessage.delivery` carries the state (`steered` and `cancelled` are stored, in a new `delivery` column; `queued` is read from the host's queue and so does not outlive a restart); client frames `edit_queued` and `cancel_queued` (`room`, `message` id, `text`) answer with the changed message as an `edited` frame or a `refused` frame (`not_queued` when the turn has started, `forbidden` for another person's message). With a core that has no `ConversationPort.cancelQueued` and `editQueued`, both answer `not_queued`.
- Pressing ↑ in an empty message box opens Edit on your latest message in the room that still waits for its turn (not while an input method composes; Alt+↑ / Alt+↓ still switch rooms), and the `?` shortcut list names it.
- The round table's camera turns to a member by the same rule as the spotlight: only when their words show. A member who only thinks or works no longer takes it when the previous speaker's words finish; the camera stays on whoever spoke last until the next member's words start.

### Fixed

- jsonb columns are stored as JSON values: a room message's `files`, `picture` and `intercom`, an ended card's `frame` and `answer`, a host card, a notice's `open` and a session's actor were stored as JSON strings. Migrations (`web-room-messages-json-values`, `web-room-cards-json-values`, `web-host-cards-json-values`, `web-notices-json-values`, `web-sessions-json-values`) convert the rows stored that way; reads still take either.
- Buttons with a quiet look of their own no longer turn into unreadable text on the accent fill when hovered or, on a phone, after a tap: the "N earlier tools" chip, the character creator's tiles, the files pane's folder twist and image toggle, the host room's cards toggle and seen faces, and a knight's temp knights header now say what hover does to them. A test fails for any new button that sets its own fill or text colour without a hover rule.
- The character creator's styles load with the creator instead of with the page, which leaves room in what the page loads first.
- The room drawer opens on a phone. A swipe right in a room never reached the page in Chrome: the room had the default `touch-action`, so Chrome took a sideways drag for itself a few pixels in and cancelled the touch before the swipe was 24 px long. The room, its message list, the composer and the drawer's own list now allow only up-down panning and pinch zoom, which leaves sideways drags to the page. A swipe that starts in a sideways-scrolling code block or table, a field, a card's option row, a sheet over the page, or a scene that takes every touch is still not the room's.
- Two edits of a waiting message from two sockets reach the room's log in the order the host took them, so the room shows the text the turn runs.

## [0.29.0] - 2026-10-31

### Added

- Skill groups in the app. The Skills page has a "Skill groups" section that lists each group with its skills and creates, edits (name, description, skills picked from the catalog) and deletes a group after a confirmation. The Edit knight sheet's Skills section has a switch per group, the same switch as each skill's: it shows on when the knight carries all of the group, otherwise what it lacks. Switching it on, after a confirmation, switches on the group's skills the knight lacks through the same path as the per-skill switch; switching it off switches off the group's skills the knight carries, built-in ones excepted. Either names what changed. A knight carries skills, not groups. The routes are under `api/skill-groups/` (list, `PUT` to create or replace with `from` to rename, `DELETE`, `POST …/apply` with `on: false` to switch a group off, answering `added` and `removed`) and answer owners only; `AppApiOptions.skills.groups` takes the registry's `groups`, `setGroup` and `deleteGroup`.

### Changed

- A group's council has one view, `CouncilView`, that both the group room and the round table page show: the council chip and sheet, the Animation mode / Chat mode switch, Reset view in the scene, the waiting cards, the room menu, the mode and offline banners, and the scene or the chat with the room's composer (with its @AI/note switch where the room takes notes). The table page gains the waiting cards and the room menu; the room gains the council chip, seat menus in the scene, and a phone keyboard that closes after a send.
- The round table's dialogue box types a knight's words out whole before the scene moves on. A knight who starts thinking meanwhile shows its thinking on its seat while the camera and the box stay on the speaker; once the words stand, the box takes the next knight's words, or the camera turns to the knight still thinking and the box shows its progress under the last words. Lines said while one types wait and come in order, a tap still shows the whole line and moves on, and with reduced motion each line shows whole and the next follows at once. Both the 3D and the 2D table; the chat mode is unchanged.
- The mode is kept per council room (`roundtable-console:council-mode:<room>`) instead of a group room's "Table" toggle and the table page's per-device mode. The first read takes the room's old toggle (`rt-table-mode:<room>`, then removed), else the old device mode (`roundtable-console:table-mode`), else the scene.
- A temp knight made on Discord stays off the room list and the switcher until its room has a message or someone opens it from a link; `GET api/rooms/<key>` answers its view and lists it from then on. A card it waits on still shows. One made in the web app, or before its origin was kept, is listed as before.

### Removed

- The group room's "Table" toggle button and the table page's own header, mode switch and chat wrapper.

### Fixed

- A swipe in a round table close-up steps the way the finger moves: a swipe to the left brings in the podium on the right. It went the other way.
- A room's chat stops following its newest end the moment the person scrolls up, by wheel, finger, key or scrollbar. Scrolling up just a little from the end used to count as still at the end, so rows settling or a reply streaming in pulled the view back down, and it shook.

## [0.28.0] - 2026-10-31

### Added

- Connector management on the Connectors page, behind the optional `connectors.manage` port: a list with each connector's name, purpose, tool count and only the scheme and host of its URL, so a credential in the path or query never shows; an add form whose token is write-only (never returned or shown again); a purpose editor; and removal behind a confirmation. pi-roundtable-mcp's `CONNECTORS` fits the port.
- An "MCP authorizations" section behind the optional `mcpGrants` port: each bundle with its channels, allowed operations and recent audit entries; authorize a channel (an existing or new bundle, a channel from the host's list, the operations), rename and re-purpose, revoke behind a confirmation, and replace a bundle's URL. A new URL is shown once with a copy button. The host supplies the channels and the acting owner's Discord ID; pi-roundtable-mcp's `REMOTE_MCP` provides the rest.
- The routes are under `api/connectors/` and answer owners only. A port's rejection carrying `refusal: true` answers 400 with its message; any other is logged and answered 502 with a fixed message. The config's `connectorParts` names the sections served, and a section whose port is absent is hidden. The `connectors` pane may be served with `mcpGrants` alone.
- The fixture hosts serve in-memory connector and authorization ports.
- Rooms store and draw messages between agents as collapsible intercom cards (`RoomMessage.intercom`, migration `web-room-messages-intercom`).
- The table page switches between the animated scene and a chat view of the council, kept per device, with the draft carried over; a message sent from the table closes a phone's keyboard.
- Waiting cards show as a count in the top bar, the rail and a room's header; a press jumps to the card (or a list of them) and highlights it, and a chip in the room brings back a card scrolled out of view.
- Starting over clears the room on every page; the old messages open read-only as the archived conversation from the start-over line (`?archive=`, migration `web-room-messages-start-over`).
- "Select text" opens the message alone in a sheet where the phone's own partial selection works, with Copy all; a room's interface text is no longer selectable.
- A temp knight's mode banner says whose modes it follows and hides its switches.
- The Skills page deletes an agent-written skill after a confirm naming the knights that carry it (`DELETE api/skill-docs/<name>`, owner-only; built-in, linked and package skills are refused).
- A knight's menus have a Skills entry that opens the Edit knight sheet at its Skills section, whose title shows how many skills it carries.

### Changed

- Rooms no longer post the interim tool-trail line; the progress pane keeps the tools.
- The round table's dialogue box folds to one bar with a labelled collapse / expand button and gives the height back to the scene.
- A round-table seat is lit only while its words show, thinking until then, and a speaking figure's mouth moves in 3D and 2D (still under reduced motion).
- The council hint drops "Pick who sits."

### Fixed

- A link click reaches every `useRoute`, not only the first that listened. The Files page, kept mounted across folders since 0.26.2, no longer ignores taps on its folders when reached from another page (the phone's tab bar).
- The overview's Start over resets an agent's or group's web room, not its Discord channel's sessions.
- A room dragged within Ungrouped no longer makes the other rows move aside as if it could be placed among them; Ungrouped keeps its newest-first order, and a room dragged in from a pinned list or a folder lights it without a placement line.


## [0.27.1] - 2026-10-31

### Fixed

- A lazy style (`installStyle`) is installed once per document instead of once per page load, so a new document gets it again. A test suite that rendered a drop-down in an earlier document no longer leaves a later one without the style.

## [0.27.0] - 2026-10-31

### Added

- Temp knights in the owner app. A knight's temp knights (see the core changelog) hang under it in the room list, in the plain and the arranged list alike, each with a small face, its name and a state: a pulsing dot while it works, the card badge while it waits for you, and a dimmed "Ended" with the time once finished. They follow the knight's pin and folder and have no drag handle; the group of them is unfolded while one is at work and folded when all have ended, per device. `RoomView.helper` (`{ parent, parentName, finished? }`) marks them, on the agent view and the profile too; the round table, the council tick list, the group editor and the switcher leave them out, and their push is held back by default since their answers reach the knight's room (a card still pushes).
- **Clear finished temp knights** in the room list's menu, a folder's menu and a knight's menu, left out when nothing has ended. It archives at once, with no confirmation, through `POST api/rooms/archive-finished-helpers` (`{ rooms? }`, owner only), and the notice's Undo calls `POST api/rooms/restore-helpers` (`{ names }`) with exactly the names that were archived. A temp knight's own menu has **Archive this temp knight** the same way, and its room header reads "Temp knight · Made by <knight>" with a link to the knight. When a knight clears its own with `helper_end`, its room shows a line naming them with an Undo. The archive page lists each temp knight right after its knight.
- The round table is a council. The owners' table shows one agent group with its members (2 to 8) at the podiums and the group's room in the dialogue box, so a message sent there starts a round under the group's rules; there is no second store. A header chip (**Council: <name> ▾**) opens the council sheet: the saved councils (the groups), a tick list of the knights with a counter (**3 of 8 picked**; the ninth tick is refused), **Done** to save the ticks into the council on the table in place, and **Save as a new council** to make another group (which opens its Discord channel like every group). `#/table/<group>` is the council; without an address the table shows the council this device chose last, or the first group. With no group yet the table says *No council yet* and the sheet starts from the knights that were not muted. `FIXTURE_COUNCIL` sizes the fixture's group.
- A seat's menu (long press, right click, Menu key) has **Private chat** and **Remove from the council** (it saves the group without the knight; the last two members cannot be removed, the council is offered for archiving).
- Turn-taking in a group round. A `round` frame (and `RoomView.round` for a page that opens mid-round) tells who speaks, who is next, who has spoken, the reply count out of 8 and how the round ended. An **order strip** on top of the group's dialogue box shows the faces in that order (spoken dimmed with a check, the speaker larger, next numbered) with a chip (*Reply 3 of 8*, *Limit reached*, *Round stopped*), and says when your message waits for the next round; while it runs the seats wear the same check or ① to ⑧ before their names (`TableHandle.setMark`), the seat the round names speaks, and the camera turns to the speaker as its turn starts. The same strip is in a group room's table view.
- A hosted table (a member or an admin) has an **All rooms** button in the header that opens the room list.

### Changed

- The core peer range moves to `>=0.27.0 <0.28.0`.
- Stop in a group room ends the whole round (see the core changelog), and its button reads **Stop the round**.
- A group holds 2 to 8 members (it was 2 to 6), on the web and on Discord. A round still holds at most 8 replies.
- A tap on a seat turns the camera to that knight and no longer opens the knight's room; the address stays as it was. Hold the seat for the private chat.
- Mute only stops push. It no longer takes a knight off the table: who sits is the council's members. Owners who used mute to thin out the table see their first group, or the empty state, after this change.
- The table seats at most 8 and never shows a "+N" podium, on the owners' table and on a hosted one (the hosted table seats the 8 newest rooms; the rest are in the room list).
- The owners' table no longer seats host rooms (a support desk's tickets, say); they are in the room list and the notices. A hosted table is unchanged otherwise.

### Removed

- The **Who's at the table** sheet and the seat menu's **Leave the table**.

### Fixed

- `pi-roundtable-web`: the owner app's small visual faults from the 0.26.2 pass. A popover opened near the window's right edge (the ⋯ menu on a finished thread card) is placed by its own width and keeps the edge's 8px margin, where it used to be measured while squeezed against the edge and sat about 4px from it. A thread card's time moved to its status row, so a long title keeps the whole row above it and no longer truncates beside "1 minute ago" on a phone. A thread named inside a message (the "Started …" line a dispatch posts) is a plain inline link again: it had taken the thread card's block layout, which cut the sentence into fragments in the round table's dialogue box; the box also keeps the newest words of a long line in view while it is typed out, until the person scrolls up. At phone widths every text input, textarea and select is 16px or larger, including the controls inside a label and the full-screen prompt and SKILL.md editor, so iOS no longer zooms in on focus; a test reads the page's styles and fails on any rule that sets a text control smaller.

## [0.26.3] - 2026-10-30

### Added

- **Mark all as read.** The room list's menu and each folder's menu have **Mark all as read**, left out when nothing in its scope is unread (a folder's scope is its rooms and the threads under them). It sets the person's read cursor to the newest message in every room they may read, agent, group, thread and host rooms, in one call: `POST api/rooms/read-all` with `{ "rooms": [...] }` (at most 500; left out, every room the list shows), owners only, with rooms the person may not read passed over. The unread badges, the tab title's count and the tab icon's dot clear at once, the person's other pages and devices hear of it through the `read` frames a single read sends and a `changed` frame, and a notice offers Undo for five seconds: `{ "restore": [...] }` to the same route puts each cursor back unless the person has read on since. Nothing asks first
- **Clear all finished threads.** The same two menus have **Clear all finished threads**, which hides every finished dispatch thread under every room of the list, or under the folder's rooms, in one call: `POST api/rooms/dismiss-finished-threads` with `{ "rooms": [...] }`, owners only, open threads never touched. The answer names the threads cleared by room, and the notice's Undo puts exactly those back through `undismiss-threads`
- Keyboard shortcuts in the owner app. Alt+↑ / Alt+↓ (Option on a Mac) go to the previous or next room in the order the room list shows (folders respected, a folded folder skipped unless it holds the open room, threads after their room, no wrapping), and Alt+Shift+↑ / Alt+Shift+↓ to the previous or next room with unread messages. Switching uses the router as a click does and scrolls the open room's row into view; it works on a page with no list too. In a text field the arrows act only when the field is empty or the caret is at the very start (up) or very end (down) with nothing selected, and nothing acts while an input method composes. Esc closes the topmost menu or sheet and otherwise lets go of the message box without touching its text. `?` outside a text field opens a sheet that lists the keys (a lazy chunk; en and zh-TW wording). Ctrl/⌘ K, which opens the search, now also ignores an input method's composition. The handler is a part that loads after the first paint, about 0.1 KB gzipped more in the first load.
- A message nobody has seen yet wears an unread frame: a soft ring and glow in the accent colour, uniform on every side (no thick or one-sided border), in the modern and camelot looks, light and dark. It marks the messages past the person's read marker as the room opened, and those that arrive while the tab is hidden or the log is scrolled away from its end, in agent, group, thread and host rooms. The person's own messages, lines the server wrote, internal notes and a message that arrives while they are watching the end of the log do not get one. Passing a pointer over a message, focusing it with the keyboard, or tapping it clears its frame, each message on its own; on a touch screen a frame also clears once the message has stood at least half in view (or half of the screen, for a long one) for one and a half seconds, through one IntersectionObserver. It is only a look: what the server counts as read, the read API and the "New messages" divider are unchanged, a cleared frame stays cleared until the page is reloaded, and `prefers-reduced-motion: reduce` removes it without the fade. The code and its styles load with the read marks (the lazy host chunk), not with the first page.

### Changed

- Clearing finished dispatch threads no longer asks first, however many there are: **Clear finished** in a room's list of threads and the new menu items clear at once, and the notice's Undo is the way back

## [0.26.2] - 2026-10-30

### Added

- Opening a room from a seat of the round table is a dive: the view zooms toward the seat that was tapped, creeping at first and then rushing in (`cubic-bezier(0.7, 0, 0.84, 0)`, about 380 ms), and the room settles in already at full size, with no blank frame. A mouse click, a tap and a key press on a seat all do it, and the camera of the 3D table dives into a seat from the whole ring the same way. It uses transform and opacity only, a second tap during the zoom is dropped, Back or leaving the table mid-zoom gives the view back and opens nothing, and `prefers-reduced-motion: reduce` switches at once. The code is part of the round table's lazy chunk, not the first load.
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
