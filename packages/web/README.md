# pi-roundtable-web

The owner app for a [pi-roundtable][roundtable] host: a mobile-first web page, installable as an app, where the owner talks to the agent team, answers its approval cards, stops a turn, sends files, switches yolo and long-running mode, and gets a notification on the phone when something waits.
It also keeps the console that came first: browse conversations and transcripts, read and edit memory notes, and watch the team, with live updates.

It serves one page on a route of the host's HTTP listener.
The page talks to the host over one WebSocket, so a message, a stream of progress, a card and its answer cross in both directions at once.
The plugin is a chat surface of its own (`app`), so a team of agents can live in the web alone: **a host with no Discord at all works fully**.

- **Rooms.** Each active agent and each group has a room; Home is the coordinator's. A room is its own conversation (its own session, held actions and, for a group, log), apart from the same agent's Discord channel.
- **Cards.** Approvals, questions, questionnaires and the card at a turn's time limit appear in the room, and any owner's device can answer them.
- **Modes.** Yolo mode approves the held actions a rule allows without asking; long-running mode lets a turn go past its time limit. Each is a switch per room, and a banner shows while one is on.
- **An app.** A web app manifest, a service worker and Web Push make it installable and let a card wake the phone.
- **Files.** The owner browses the knights' workspace, reads files with syntax highlighting, and edits, creates, renames and deletes them (to a restorable trash), with a check on every save that a knight did not change the file meanwhile.
- **Looks.** Agents are drawn as characters; the page has a Modern and a Camelot look, light and dark, and a round table that seats the whole team.

Who may enter is the host's `access` configuration plus an authentication mode you choose: `none`, `password` or `verifier` (see [Authentication](#authentication)), and the plugin refuses to start without one.
Then only a person whose principal holds the owner role gets in.

## Contents

- [Requirements](#requirements) and [Install](#install)
- [The owner app](#the-owner-app): rooms, cards, [modes](#modes-yolo-and-long-running), [dispatch threads](#dispatch-threads), [pins and folders](#pins-and-folders), [uploads](#uploads), [characters](#characters-in-the-page), [the Camelot look](#the-camelot-look), [the round table](#the-round-table), [the files pane](#the-files-pane)
- [Members and the gate](#members-and-the-gate): [who is let in](#who-is-let-in), what each tier sees, and the steps owed before the app opens
- [Install on a device](#install-on-a-device) and [Notifications](#notifications)
- [Authentication](#authentication) and the [threat model](#threat-model)
- [Options](#options), [the console's panes](#the-consoles-panes) and [host feature ports](#host-feature-ports)
- [Host rooms, pages and cards](#host-rooms-pages-and-cards): rooms a host plugin owns, with read marks
- [App protocol](#app-protocol), [Screenshots](#screenshots) and [Development](#development)

## Requirements

- Bun 1.4.4 or later, and pi-roundtable `>=0.26.0 <0.27.0` as a peer dependency.
- The host must run on the machine that holds its data directory: the console reads `<dataDir>/sessions` from disk, and the app keeps its files and keys under `<dataDir>/web/`.
- An agent team: `agents` in the configuration, with or without `discord`. Without Discord the host also needs a surface that hosts rooms, and this plugin is one; the start fails otherwise, naming the fix.
- A way to authenticate the owners (see [Authentication](#authentication)): a password, Cloudflare Access or a verifier of your own in front of the listener, or `none` on a listener only the owner reaches.
- An owner in the host's `access` configuration. With `none` and `password` the session speaks for the primary owner (or `auth.principal`) and needs no identity of its own; with a verifier, each person is an owner through the identity the verifier reports for them, listed among their `identities` or linked with `roundtable principal link`.
- HTTPS for installing the app and for notifications: browsers install a web app and allow service workers and push only on a secure origin (`localhost` aside). Put the listener behind a proxy or tunnel that terminates TLS.
- The `memory` addon for the Notes pane (it is on by default; switch the pane off with `panes` when you run without memory).
- A Discord connection is optional: with the Discord entry's `DISCORD` service the console names channels, and without one it shows channel ids.

The package ships its page prebuilt in `dist/`, so installing it needs no build step and no bundler on the host.
A git checkout has no `dist/` until you run `bun run build`, and the plugin stops at startup with that instruction when the page is missing, so a broken install never serves a blank page.

## Install

```sh
bun add pi-roundtable-web
```

A host that lives in the web alone (no Discord), behind Cloudflare Access:

```ts
import type { RoundtableConfig } from "pi-roundtable";
import { cloudflareAccess, webConsole } from "pi-roundtable-web";

export default {
	name: "Studio",
	access: {
		owners: [
			{
				name: "Ada",
				principal: "ada",
				// The identity cloudflareAccess reports; see "Cloudflare Access" below for how to find it.
				identities: ["oidc:<issuer>:<sub>"],
			},
		],
	},
	database: { url: process.env.DATABASE_URL ?? "" },
	dataDir: "./data",
	model: process.env.MODEL ?? "",
	http: { port: 3000, hostname: "127.0.0.1" },
	agents: [
		{ name: "guide", displayName: "Guide", prompt: "You are the owner's main assistant." },
	],
	coordinator: "guide", // Home is the coordinator's room; the default is the first agent
	plugins: [
		webConsole({
			verifier: cloudflareAccess({
				teamDomain: "example.cloudflareaccess.com",
				audience: process.env.CONSOLE_ACCESS_AUD ?? "",
				email: "owner@example.com",
			}),
			origin: "https://app.example.com",
			dataDir: "./data",
		}),
	],
} satisfies RoundtableConfig;
```

A host that keeps Discord adds the plugin to the `plugins` of the configuration `init` wrote; the agents then have a Discord channel and a web room each, and the two are separate conversations.
On a host with a single owner who reaches the listener alone, for instance over a unix socket, `auth: { mode: "none" }` replaces `verifier` and needs no identity; read the [threat model](#threat-model) first.

The plugin adds the route `/console` (a redirect to `/console/`) and `/console/…` to the `public` listener, and a line with the app's address to the dashboard message.
Open `<origin>/console/`; the page is the app.
Sign in with the mode you chose; Home, the coordinator's room, heads the room list.

## The owner app

The `rooms` pane is the app; it is on by default.
It is the same agent team as on Discord, in rooms of its own: `<surface>:agent.<name>` for an agent, `<surface>:group.<name>` for a group (surface `app` unless you change `surface`), and Home, which is the coordinator's room, so the owner keeps one main assistant with one memory.
A room is a conversation apart from the same agent's Discord channel: it has its own session, held actions and, for a group, its own log, so what you say in the app is not said in Discord.
History from before, in Discord, stays readable in the Conversations pane.

The page is built for a phone first: a bottom tab bar under 720 px, a side rail above it, and above 1024 px the room list beside the open room.

| Where | What it does |
|---|---|
| **Rooms** | Home first, then the pinned rooms, the owners' folders and the rest by latest activity, each with its dispatch threads, with badges for working, a card waiting, yolo and long-running (see [Pins and folders](#pins-and-folders)). |
| **A room** | Each message with its author's picture and name, Markdown (raw HTML is shown as text), files, and a live progress strip with the streamed text and tool chips. A sticky composer with upload and Stop. The header menu holds the mode switches, Profile and Start over. |
| **Cards** | Inline in the room: an approval with the call's details and a copy button; a question with options, an "Other" field and Cancel; a questionnaire; and the card at a turn's time limit. Answered cards show the answer given. |
| **Knight sheet** | Display name, prompt (with its History), model and thinking level, the skills it carries, Notifications, the character creator (see [Characters in the page](#characters-in-the-page)) and Archive. See [Making and arranging agents](#making-and-arranging-agents). |
| **Schedules** | Every schedule of the team, labelled by room or channel, with a confirmed cancel. |
| **Table** | The round table (see [The round table](#the-round-table)). |
| **Files** | The agents' workspace: a tree, highlighted files and an editor (see [The files pane](#the-files-pane)). |
| **Main prompts** | The prompt documents of the host (shared, guest, a plugin's own) with their file versions, overrides and history (see [Editing prompts and skills](#editing-prompts-and-skills)). From Settings. |
| **Settings** | Color scheme and look, the link to Main prompts, install, notifications for this device, and Log out (password mode). |

**Sending and stopping.** A message goes to the agent as the owner's. **Stop** ends the turn.
A message that cannot go shows "Not sent" with Try again and Discard; a lost connection shows a banner under the header and the page reconnects with backoff, then fetches what it missed.
A conversation that was started over keeps a divider, and the old turns stay in the Conversations pane's archives.

**Cards.** A turn that needs the owner opens a card in its room and every open page of every owner sees it; any owner can answer, except a card that is the speaker's alone, which only the speaker answers.
The turn waits `cardGraceSeconds` (120 by default, as on Discord).
After that it goes on without the answer, and the card stays open for a day: an answer then starts a new turn in the room that carries it.
`Cancel` on a question answers `declined`, as Discord does.
A card that ended stays in its room's history, as a card stays in a Discord channel with its answer: it is kept in `web_room_cards` with how it ended (`approved`, `declined`, `answered`, `expired`, `cancelled` or `withdrawn`), who answered, what was answered and when, and a reload, a new tab or an automatic reload shows it among the messages where it opened.
It holds only what the card showed, and an owner reads it as they read the messages.
Cards open before a restart are lost from the page, but their held calls persist, and a message that approves them still works.
Whether a card pushes a notification is described under [Notifications](#notifications).

### Modes: yolo and long-running

The header menu of an agent or group room has two switches, kept per room and across restarts (the core's `MODES` service). Only an owner may set them, and only for an app room: a Discord channel's modes cannot be set here, and a thread has none.
While a mode is on, a banner under the header says so with a button to turn it off.

| Mode | What it does | What stays under your control |
|---|---|---|
| **Yolo** | The server approves a held call itself, before a card opens, and writes a line in the room ("Yolo mode approved: …") for each one. | Turning it on asks to confirm. It approves only for an owner's turn (never a webhook or a report), never a call that names its approvers or is the speaker's alone, and never a destructive class: `sudo`, `rm`, disk, power, kill, service, docker, firewall, packages, force push, hard reset, `gh` and `crontab` still ask. `autonomy.yolo.allow` and `autonomy.yolo.card` in the host configuration change the list. A call held without classes always asks. A card opened before the switch stays open. |
| **Long-running** | A turn that reaches its time limit goes on by itself, as the owner's Continue would, up to `autonomy.longRunning.maxSeconds` of work (four hours by default). | At the cap the turn asks on a time-limit card (and, with push on, a notification says "Long-running cap reached"), or aborts when it cannot show one. `ask_user` is never answered automatically. |

**A plain `git push` and a write outside the workspace are approved under yolo**, because they are the non-destructive classes, and a push to `main` may deploy. List `shell.push` in `autonomy.yolo.card` to have it ask.
The turn's own time limits are `turnLimits` in the host configuration.
The classes, the rule behind each and the guardrails are in the core guide: [hold classes and yolo mode](../../docs/plugins.md#hold-classes-and-yolo-mode), [conversation modes](../../docs/plugins.md#conversation-modes-modes) and [long-running conversations](../../docs/plugins.md#long-running-conversations).

### Dispatch threads

The app hosts the core's dispatch threads (`ChatSurface.threads`). A background dispatch started from a room (a coding task, a delegated task, `message_agent` between agents) puts one start line in that room and opens a thread, `<surface>:thread.<uuid>`, whose room holds the dispatch's progress and report. The start line links the thread, and the room list nests each thread under the room that started it, with the finished ones folded away. Only an agent's or group's room can host a thread, never a thread itself.

A thread's room is read only: a `send` to it is refused with `read_only`, and it has no modes. Its cards are the dispatch's own, such as a coding job's approvals, and any owner answers them there as in any room. Agents post in it under their own names. A closed thread stays readable (the list keeps the 30 newest closed ones), and the host closes the threads a restart left open, with a restart notice. `GET api/rooms` lists a thread with `parent` and, once closed, `closed: true`; opening and closing one sends `changed`.

Each thread is a card in that list: its title, its room's knight, a badge (in progress or finished), the time of its last post and its unread count. A going-on thread wears its knight's tint and a finished one rests. An owner clears a finished thread off the list by swiping its card to the right (the card slides out, the list closes the gap, and a notice offers Undo for five seconds), by pressing the menu button on the card, by holding it or right-clicking it (**Clear this thread**, **Clear all finished**), or with Delete on a focused card; **Clear finished** in the header of the finished threads does the same for all of them, after a question with the count when there are more than five. A going-on thread does not swipe: the card gives a little and springs back. Clearing hides a thread and does not delete it: it leaves the list for every owner and every open page at once, and stays readable by its address and through the links in its room. The routes are `POST api/rooms/<thread>/dismiss` (409 while the thread is open), `POST api/rooms/<room>/dismiss-threads` (every finished thread of the room), their undos `POST api/rooms/<thread>/undismiss` and `POST api/rooms/<room>/undismiss-threads` (body `{ "threads": [<keys>] }`, at most 100, those that hang under the room), and `GET api/rooms/<thread>` for the view of a thread the list does not carry. All of them are the owners' like the rest of `api/rooms`.


### Making and arranging agents

An owner changes the team from the app. Everything goes through the agent server's own operations (`AgentTeam`), the ones the `agent_create`, `archive` and `group_*` tools use, so an agent made here is the one an agent would make, and an archived one is the one the `archive` tool leaves.

- **New knight.** The **+** button of the room list and of the drawer opens a menu with New knight, New group and Archived. New knight asks for a name, the permanent name (lowercase letters, digits and dashes, which names the room and cannot be changed; it follows the name until typed by hand), the prompt, a model, an optional opening task and a look. The look is the one its role suggests until the creator picks another. On success the new agent's room opens. A bad or taken name, an unusable model, a bad look and an unknown skill are refused with the bot server's words before anything is made.
- **Archive and restore.** Archive is in the agent sheet and in the ⋯ menu and long-press menu of a room (the coordinator's room has none). It asks first, naming the agent or group. An archived agent stops answering, its schedules are cancelled and it leaves its groups; its history is kept. **Archived** in the **+** menu lists what is archived with Restore and Delete. Restoring an agent does not put it back in its groups; restoring a group needs all its members active, otherwise it is refused and stays archived.
- **Delete.** Only an archived agent or group can be deleted, from the archive, after a question that names it. Deleting frees the name, removes the agent's group cursors and detaches its skills, and clears what this app kept of the room (its messages, its cards, its mute and its modes). A Discord channel, if the agent had one, stays under Archive with its history, since Discord is never asked to delete a channel.
- **Skills.** The agent sheet lists the host's skills (the Skills pane's catalog when the host supplies it, else the skills addon's own) with a switch each, applied as it is flipped and from the agent's next turn. Built-in skills are carried by every agent and stay on. A host without the skills addon shows nothing.
- **Groups.** New group and Edit group (the group's header name, its ⋯ menu and its row menu) take a name, 2 to 6 members in the order they are picked, and the host who answers when nobody else fits; Edit sends only what changed. Archive group asks first.

All of it is for owners: the owner's tier is read again on each call, a change needs the console's `Origin`, and a room or agent that does not exist is a 404. Every change tells the open pages to read the room list again.

### Editing prompts and skills

An owner edits the texts that shape the agents from the app. Both editors are full-screen sheets that load when first opened, and in both nothing is saved before **Review changes** has shown the lines that change.

- **Main prompts.** Settings links to the list (on a host that has prompt documents). Each document is a text the host reads from a file or the configuration, with an override the owner stores in the app: the core's `shared` (the base of every agent's prompt) and `guest` (used when the speaker is not the owner), and any a plugin registers through `PROMPTS`. A document that differs from its file version has a badge with who set it and when. **History** lists each change, newest first, and a version can be read against the one before and taken into the editor. **Revert to the file version** asks first, names the document and drops the override. The override applies from the agent's next turn, with no restart, and the host logs a warning at start for each document that differs from its file. Saving sends the text the sheet was edited from; if someone changed the document meanwhile, the sheet reads the diff again against the new text and keeps the draft.
- **Agent prompts.** An agent's prompt is edited in its sheet as before; **History** there lists the earlier versions and who saved them. There is no override layer for an agent: the saved prompt is the text in force.
- **Skills.** The Skills page has **Edit** on a skill an agent wrote and **New skill**. The sheet holds the whole SKILL.md, frontmatter included, checked by the same rules as the skill tools; a refusal is shown in the server's words. A save is checked against the hash the file was read with (`409` and a new diff when it changed), and each save is kept as a version in **History**. A built-in, package or linked skill shows a lock and where it comes from, and is changed there. Deleting a skill is not offered here.

All of it is for owners: the tier is read again on each call, a change needs the console's `Origin`, and a prompt or skill that does not exist is a 404.
### Pins and folders

The owners arrange the room list together: one layout for the whole app, kept on the server and shown the same on every owner's phone and desktop. The order is **Home** (always first), the **pinned** rooms in the owners' order, the owners' **folders** in theirs, and **Ungrouped**, which holds the rest by latest activity. Until there is a folder, the rest keeps its Agents and Groups headings. A room is in one place: pinning a room takes it out of its folder and putting it in a folder unpins it. Home and dispatch threads (which follow their room) cannot be pinned or filed. The room switcher drawer on a phone lists the rooms in the same order, with a heading for each folder, and the rooms with a card waiting stay on top.

| Where | What it does |
|---|---|
| A room's menu (long press, right click, or the Menu key; the **⋯** beside a row in arrange mode; or the **⋯** in the room's header) | **Pin** or **Unpin**, **Move to folder…** (a sheet with the folders, Ungrouped and **New folder…**), and **Move up** or **Move down** within the pinned list or the folder. |
| A folder's header | A light section header (chevron, name, count, ⋯). Fold or unfold it (kept per device in `localStorage`, `roundtable-console:folders-collapsed`; the folder that holds the open room shows open, and a folded folder still shows a small stack of its rooms' pictures, then how many more, and its rooms' waiting cards and working dots). Its **⋯** (or a long press, right click or the Menu key) offers **Rename**, **Mute the whole folder** or **Unmute the whole folder**, **Move up**, **Move down** and **Delete folder** (after a question; its rooms move to Ungrouped, no room is deleted). A bell-slash shows when every room in it is muted, a fainter one when some are. |
| The list's **⋯** | **Add a folder**, and **Arrange**, which shows a **⋯** beside every row and a bar to add a folder until **Done**. |
| A room row or a folder header, held or dragged | A finger that rests on a row lifts it (a short vibration where the phone has one); dragging then reorders it within its list, moves it into another folder, the pinned list or Ungrouped, and a folded folder opens after the finger rests on it. A held folder header moves the whole folder among the folders. The rows make room as you drag, the list scrolls near its edges, the place it lands is outlined, and Escape or a drop outside every list puts everything back. Letting go without moving opens the row's menu as before. A mouse lifts a row once it moves with the button down. A touch within 32 px of a screen edge never lifts a row (the system keeps that edge), so the menu is the way there. While a row is lifted the lists keep their order, so a message that arrives does not move rows under the finger, and the pinned list and empty folders show as places to drop even when they hold nothing yet. On Android the browser's own long press (its `contextmenu`, at about 400 ms) counts as the hold. Ungrouped is ordered by activity, so a row dragged within it goes back; pin it or put it in a folder to place it. The lift code is a chunk of its own that loads on the first press. |

Folders have 1 to 40 characters (code points) in their name, no control characters, a name that no other folder has (case does not matter), and there are at most 50. The routes are owner-only, as the mute route is: the person's tier is read again, a write needs the console's own `Origin`, and `GET api/rooms` carries the layout with the rooms so the two never disagree. A stored place of a room that is gone (an archived agent) is kept and not shown, so the room returns to it when it comes back. Folder mute is the rooms' own mute (`web_push_muted_rooms`) set for every room in the folder at once, and a room moved into the folder later keeps its own.

Until the owners arrange something, the page is the plain list it always was; the arranged list (folders, the lift, their styles) is a set of chunks that load once there is a pin or a folder, or when the list's **⋯** is used, and the drawer's rows load with the drawer, so the first load costs almost nothing for the feature.

The layout lives in three additive tables created by the plugin's migration `web-room-layout`: `web_room_folders`, `web_room_folder_rooms` and `web_room_pins`. Every write takes one advisory lock and rewrites the positions densely, so two devices editing at once leave no gap and no duplicate.

### Uploads

An owner may send a file of any kind in a room, up to four to a message: the button, a paste (a copied image, say) or a drop. `POST <mount>/api/uploads` takes one file as `multipart/form-data` (field `file`) and answers `{id, name, type, size}`; the message then names it in `uploads`. A long text goes as a file too: the page turns a paste of 4,000 characters or more into a `pasted-text-<n>.txt` chip, and a message over 32,000 characters into `message.txt` with the line "(long text attached)"; the server still refuses a text over 32,000 characters.

- **Streamed, not buffered.** The body is read as a stream and written to disk as it arrives, so a large file costs disk, not memory. Only the first bytes are kept to tell what the file is. A file over `uploadMaxBytes` is refused with `413` (before it is read when the length says so, as it passes the limit otherwise), and nothing is left on disk.
- **Any type.** Images are checked by their first bytes (a file that says it is a PNG but is not one is refused with `415`); a file that is valid UTF-8 without NUL bytes is kept as text (`text/markdown`, `text/csv` or `application/json` by its name, else `text/plain`); a PDF by its first bytes keeps `application/pdf`; everything else is kept as `application/octet-stream` under the name it came with. What the browser said the type was (often empty, or `video/mp2t` for a `.ts` file) does not decide.
- **Bounded.** A person may have 16 files and 400 MiB waiting for a message, counting uploads on their way (`429` beyond that); a waiting file is deleted after a day, a sent one after `uploads.keepDays` (30 by default). The page deletes a chip's upload when it is removed or its send fails (`DELETE <mount>/api/uploads/<id>`, the owner's own waiting uploads only), and a body that is cut short leaves no file behind.
- **Served safely.** A stored file is a download, never a page (`content-disposition: attachment`, `content-security-policy: sandbox`, `nosniff`); only the four image types are shown inline.
- **What the agent gets.** The turn's message names each file, and the host saves it for the agent's tools: the app hands the host the stored file's path, so a large file is copied from disk, never held in memory. The agent takes a file up to `uploadMaxBytes` (the surface's `maxAttachmentBytes`), not the 25 MiB a Discord attachment is held to. Images (four at most) are also shown to the model, and a text or PDF file can be read by the agent. A file over 25 MiB is kept as a file for tools: it is not shown to the model and `read_attachment` refuses it, and the turn's attachment list marks it "too large for read_attachment; kept as a file for tools", which a tool that takes files opens as it is.
- **Limits in front of the app.** The upload route asks the host's listener for a request body of `uploadMaxBytes` plus 64 KiB of form framing, so a larger `uploadMaxBytes` raises the listener's limit past its 128 MiB default (a listener the host fixed with its own `maxRequestBodyBytes` decides instead, and refuses a larger body with `413`). A reverse proxy has its own limit; Cloudflare's free plan caps request bodies at 100 MB, so a larger file needs a paid plan or an upload path that skips the proxy.

### Characters in the page

Every agent is drawn as its composed character (`pi-roundtable/characters`). The page draws it from the spec the server sends, after a strict `parseCharacter` check: a spec that does not parse is logged and replaced by the look the agent's name suggests. The drawing is `composeSvg`'s output, the only markup the page injects, and it holds no inline style, so the content security policy is unchanged. The skin tones come from the host: `GET api/config` carries `characterSkins`, the six `#rrggbb` colors of the host's `characters.skins` (the character kit's own by default, `EAST_ASIAN_SKINS` for light East Asian tones), and every drawing, the creator's skin swatches and the round table use them, so a stored look keeps its skin index and takes the new tones as they are. The composer is a chunk of its own (about 19 KB gzipped) that starts loading with the page and is cached by the service worker.

- **Where.** The room list, the room's header and the agent's profile show the character live, the room list only while its agent is not idle; messages, the room switcher and a group's stack of up to three members stand still. The owner has no picture.
- **State.** `thinking`, `working`, `waiting` (a card is open), `done`, `error` and `sleepy` come from the `activity`, `presence` and prompt frames; `working` elsewhere (Discord, another room) counts, `done` lasts 2.5 s, a failed turn stays `error` until the next turn or the room is opened (at most ten minutes), and an agent quiet for eight hours, or between 01:00 and 06:00 local time with nothing in the last hour, is `sleepy`. Under `prefers-reduced-motion` the characters stand still and the state shows as a badge.
- **Accent.** The character's primary color, shaded to be readable in the scheme, is `--agent-accent` on the room's row, header, progress strip and composer.
- **Creator.** The profile's "Look" section edits a draft of the character: the 24 classes, eight palettes and custom primary, secondary and trim colors, and strips for hat, outfit, prop, hair, beard, accessory, build, skin and hair color, each drawn on the current look. "Suggest from role" and "Randomize" fill the draft, Save sends `PUT api/agents/<name>/character` and shows a refused field under its strip, and leaving with unsaved changes asks first. Every label is a message key, `character.class.<id>`, `character.<kind>.<id>` and `character.palette.<name>`, with the English name as the default.
- **Look.** `ConfigView.look` (the `appearance.look` option) goes on the page as `data-look` on `<html>`; Settings picks Modern or Camelot per device (`localStorage` `rt-look`), and the characters take the shield frame under Camelot.

### The Camelot look

`appearance.look: "camelot"` (or a device's own pick in Settings) dresses the page's details and leaves its skeleton alone. It is CSS and a few small elements: no image, no web font, and nothing new for the content security policy.

- **Colors.** Parchment (`#f4ead5`, surfaces `#fbf5e6`) by day and a night castle (`#0f1726`, surfaces `#16213a`) by night, with gold and a bronze accent that reads on parchment. Every text color meets 4.5:1 and every accent and control edge 3:1 on the surfaces it sits on; an agent's accent is shaded for Camelot's own surfaces (`accentOf(spec, "camelot-light")`). The scheme still follows the system or the person's pick.
- **Type.** Headings use the system serif stack (`Iowan Old Style`, Palatino, `Songti TC`, `Noto Serif TC`, Georgia); nothing is fetched.
- **Details.** Gold rules under page titles and the room header, with corner marks on the header; the shield frame on every character; a wax seal in the agent's accent that is stamped on an approval card when it turns approved while the page shows it, and sits still on a card the room shows already approved (the seal hangs over the card's lower corner, so the card keeps its height); and a candle and a row of runes on the progress strip, the candle flickering and the runes shimmering while the turn works. Each moves with `transform` or `opacity` only and stands still under `prefers-reduced-motion`.
- **Toolbar color.** The `theme-color` tags follow the look and the scheme: parchment or night castle under Camelot, the plain page's colors under Modern. The pre-paint script (`theme-init.js`) also puts `data-look` on the page, so a Camelot host never flashes the Modern look first.

### The round table

The `table` pane is a council hall: a ring of tall dark-wood podiums, one for each active agent whose room is not muted (the coordinator first) and one low lip at the near edge for you, under torches, banners and a stained-glass window, around a glowing rune circle. The hall is drawn in the characters' own flat, outlined style (a stepped tone gradient and a dark line round every shape, no photographic textures). Dark is the hall at night, light the same hall by day; the Modern and Camelot looks change the banners and the trim, not the hall. Each agent stands behind its podium as a waist-up standee: the character without its frame, cut out with a thin light rim, a dark line and a visible board thickness, turning to the camera within limits. A seat's state comes from the same rules as the room list (`sleepy` sits as `idle`): a thinking seat shows a "…" badge and bobs, a seat with a card waiting a gold "!", a speaking seat has a light on its podium and the concept art's three gold emphasis strokes beside its head; a change of face redraws that one picture once it has stood for 300 ms. More than twelve agents show twelve and a "+N" podium that opens the list.

If the host has kinds of room the owner may list (for example a support desk's ticket rooms), the owners' table seats those host rooms too, after the agents and newest first, by the same lists and `access` as the member table below; a tap on such a seat opens the room's own page. A host with no host room kinds seats agents only.

This section describes the owners' table. A member or an admin is served the table only when the host names it for their tier, and theirs seats host rooms instead of agents: see [What each tier is served](#what-each-tier-is-served).

- **Cameras.** The overview stands behind your podium, raised. A drag or swipe turns it round the ring and snaps to a podium; the wheel or a pinch moves in on the podium across the ring and back out. A close-up of a speaker stands low inside the ring, tilted a little, with thin speed lines flashing for 400 ms on a new speaker. A turn follows the ring the shorter way and takes 450 to 650 ms. A swipe never starts within 32 px of the screen's edge. Under `prefers-reduced-motion` the camera cuts, with no speed lines, bob or flicker.
- **Talking in the scene.** A tap on a podium (or on its name, a button over the plate) turns the camera to that agent and slides up a dialogue box on the agent's own room: a nameplate tab in the agent's color with its picture, the line being said (Markdown, typed out while it streams, a tap shows it whole), the cards waiting for an answer, and the room's own message box, with its unsent text kept per room. **Log** opens the room's whole message list as a sheet over the scene. The address is `#/table/<agent>` (the agent's name or the key of its room): Back returns to the whole ring, a link opens the scene at that agent, and an address that names nobody seated goes back to `#/table`.
- **Names.** A seat's name is a button laid over its podium's nameplate, at least 12 px on the screen at any distance, in a font stack that carries Chinese (`system-ui`, PingFang TC, Noto Sans TC, Microsoft JhengHei); the podium's own plate is lettered the same way. The seat's full name and state are its accessible name. Where the names stand over each other (many seats on a phone) the agents are also listed as buttons under the scene.
- **Phones.** Held upright, the scene fills the top 55 % and the dialogue box the rest, and the box collapses to its nameplate line; on its side the scene is whole and the box lies over its bottom third. The seats are also listed as buttons with more than ten seats.
- **Fallback.** Without WebGL (or after a lost context) the same ring is drawn as SVG in the same palette, with the same standees, plates and dialogue box, never a blank pane. `?nogl` in the page address (`/console/?nogl`, or `#/table?nogl`) draws it on a browser that has WebGL, to try that path; `nogl=0` and `nogl=false` leave the choice to the browser.
- **Performance.** The WebGL scene is a chunk of its own, fetched when the view first opens and cached by the service worker, never precached. It stops drawing while the page is hidden or the table is off screen, draws a few frames a second while nothing moves (so a torch flickers without keeping the GPU busy), and caps the pixel ratio at 2 (1.5 on phones).
- **Who sits.** With many agents the table can be thinned out. **Who's at the table** (a button in the page's header) opens a sheet, a bottom sheet on a phone and a dialog elsewhere, that lists every agent with its picture and a switch; an agent switched off leaves the table, and switched on sits down again. Leaving the table *is* muting the agent's room push (the per-room mute, `PUT rooms/<key>/mute`, shared by every owner and device), so there is one switch behind the table, the agent sheet and the room menu: the table seats exactly the agents whose room is not muted, and muting a room anywhere takes its agent off the table. A seat's menu (a long press, a right click or the Menu key) and the ⋯ button of the dialogue box also offer **Leave the table**. An agent off the table stays in the rooms list with its bell-slash, and the table re-seats at once, the camera staying where it was unless it was on the agent who left, when it goes back to the whole ring (`#/table`, in place). With everyone off the table the page says so and offers the sheet. A group room's table is not affected: it seats all its members, muted or not.
- **Leaving and joining.** An agent who leaves goes in a manga-style puff: the standee squashes a little, flat outlined clouds pop up round it and hide it, then drift up and fade with a few sparkles (about 0.7 s). The other seats then glide to their new places with the camera. An agent who sits down is called up out of a small rune circle in the hall's teal that glows on the floor at its new place; the podium rises out of it with a slight bounce, under a column of light (about 0.85 s), once the others have opened the gap. The pictures are drawn on small canvases in the hall's style and given back when the show ends. Under `prefers-reduced-motion` the picture only dips and comes back (0.16 s each way), with no smoke or rise; the 2D fallback fades the seat in over a ring and out inside a puff with CSS.
- **Group rooms.** A group room's header has a "Table" button that switches the room between its list and the scene; the choice is kept per room. In the scene the whole conversation runs in the dialogue box, the camera turns to whoever replies, and it rests on the whole ring while you speak; a member that starts thinking shows its badge wherever the camera is, and a speaker change never takes the focus from your message box. Under the Camelot look a compact strip of the members stands under the header in the list, with the speaker lit.

### The files pane

The `workspace` pane (called Files) shows the directories the agents work in and lets the owner edit what they find there, from a phone or a desktop.
It is for reading a file an agent wrote, fixing a line, and keeping a note beside the work, not for running code.

**What it shows.** Two places are on without being named when the agent server is present, from `AGENTS.workspace`: `agents`, the shared working directory every agent's shell and file tools run in, and `scratch`, the agents' scratch directory when the host sets one.
Both are writable, which adds nothing the agents lack: they write there without a hold.
`workspace.roots` adds more, each `{ id, label, dir, writable? }` with `writable` false unless said, and `workspace.agents: false` or `workspace.scratch: false` leaves one of the two out.
A root is refused at the start when it is, or contains, the host's `dataDir` (sessions, the session key and the VAPID keys live there) or Pi's agent directory in its default place, `<dataDir>/pi` (`auth.json`), once symlinks are resolved.
A root whose directory does not exist yet lists as empty and is never created by the app.
The pane is in the default list only when there is a place to show; a list that names `workspace` without one stops the start and says so.

**On a desktop** (720 px and wider) the tree stands on the left, resizable and remembering which folders were open per place, and the file or folder on the right, under a header with a place picker and breadcrumbs.
**On a phone** the pane drills down one level at a time: the places, then a folder, then a file, with the breadcrumbs as a row of chips that scrolls sideways and a Back button.
A file opens in read mode, so no keyboard rises; Edit switches to the editor, whose bottom bar sits above the keyboard with Save, Undo, Redo, Find and Tab, the font is 16 px so the page does not zoom on focus, and lines wrap.
Cmd/Ctrl+S saves, Cmd/Ctrl+F finds, and Esc leaves the editor (and asks first when there are unsaved edits).
`.git` and `node_modules` are listed but dimmed.

**Highlighting and editing** are CodeMirror 6, one engine for both, so the read view and the editor look the same and switching is instant.
The editor and each language are separate chunks that load the first time they are needed (the editor about 100 KB gzipped, a language 1 to 70 KB), so none of it is in the page's first download. The service worker caches the editor's and each language's chunk when it is fetched and never precaches them; the code they share is left to the browser's own cache, which keeps a hashed file for good.
The editor lives in a shadow root and takes its styles as constructed stylesheets, because the page's Content-Security-Policy (`default-src 'self'`) does not apply a `<style>` element a library adds; the policy is not loosened. A browser without constructed stylesheets (before Safari 16.4) shows the editor in the page, where it is unstyled.
TypeScript and JavaScript, JSON, Markdown, CSS, HTML, Python, YAML, Go, Rust, SQL, XML, shell, TOML and Dockerfile are highlighted; any other file is plain text.
The colors are CSS variables (`--code-*` in `tokens.css`, set again for Camelot), each at least 4.5:1 on the editor's background, so the Modern and Camelot looks and light and dark recolor an open editor with nothing rebuilt.
There is no autocomplete and no auto-closing of brackets, which fight phone keyboards, and Tab inserts indentation.

**Saving.** A file is read with its SHA-256 hash, and a save carries it back as `baseHash`.
The server reads the file again and compares just before it replaces it, and a mismatch answers `409` with the file as it is now and writes nothing; so does a file that was deleted meanwhile.
The page then opens a dialog: Copy my text, Reload (discard my edits), and Save mine anyway, which asks a second time and then writes with the hash the conflict named.
While a file is open the page looks at it again on focus and every 5 seconds; in read mode it reloads silently, and in edit mode a banner says a knight is changing the file.
A save writes a temporary file beside the original, with the original's mode, flushes it, checks again that the directory is still the one inside the root and the file is still a regular file, and renames it over the original.
It keeps the file's line separator (`\r\n` or `\n`), a leading byte order mark and whether the file ends with a newline.
A save gives the file a new inode and the server's user as its owner, so a hard link to the old file keeps the old text.
The checks are made with the paths the host gives and resolve the path again for each call, as Node has no `openat`: a process that can rewrite a directory inside a place while a call runs can steer that call. Agents run as the server's own user, so they gain nothing from this, but the place is not a boundary against a separate hostile user.

**Making and removing.** New file, New folder and Rename never replace something that exists (a clash is `409 exists`).
Delete moves the file or folder into `.rt-trash` at the top of its place, which the tree does not list; Trash lists what is there with Restore, which never overwrites, and Delete for good.
A link is deleted as a link, never as what it points to.

**What it refuses.** Every call, a read too, needs an owner, whose tier is read again, and a change needs the console's own `Origin` like every write.
The client names a place by id and a path relative to it; a NUL byte, a leading `/`, a `.` or `..` or empty segment, or more than 4,096 bytes is `400`.
Each directory on the way is resolved with `realpath` and must be inside the place's real directory, and a place's own real directory is fixed where it is first seen: one that is later replaced by a link elsewhere is refused.
`.git` and the trash are guarded by name without regard to case, as a volume that ignores case takes `.GIT` for `.git`.
A symlink is listed with whether its target is inside; inside it opens as its target, outside it is shown and neither read nor written, and a save never writes through one.
A pipe, socket or device is listed as other and never opened; a file is opened without following a link and its handle compared with what was checked.
`.git` is read-only everywhere, because a hook or a config there runs code the next time an agent uses `git`; a place that is not writable refuses every change.
A file over 2 MiB gives its metadata and a download only, over 1 MiB it is shown and not edited, a download is at most 50 MiB and streamed, a directory lists 2,000 entries and says so, and a saved text is at most 1 MiB (`413`).
A file with a NUL byte in its first 8 KiB, or that is not valid UTF-8, is read-only.
A picture, PDF, sound or video previews only when its extension is on the allowlist and its bytes agree (PNG, JPEG, GIF, WebP, SVG, PDF, MP3, WAV, OGG, MP4, WebM); it is served inline with its own type, `nosniff`, `frame-ancestors 'self'`, a strong ETag, byte ranges and `Cache-Control: no-store`, under a `sandbox` policy that loads nothing (a PDF has none, because a browser's viewer does not draw under one). An SVG is served inline and sandboxed, and the page shows it only through `<img>`; HTML and XML are always downloads. Text is served as `text/plain`.
Each save and each rename, deletion, creation and restore is logged with who, the place, the path and short hashes, never the contents; each refused escape is logged as a warning.

**Holds do not apply.** A hold asks the owner before an agent's tool call; here the owner is the one acting and is already authenticated, and the places are those where the agents may write without a hold.
Under `auth: none` or `password` an agent with a shell can call this API as the owner, as it can for cards and yolo already; within the default places that grants nothing it lacks.
A host that adds a root the agents cannot reach should authenticate with a verifier (`cloudflareAccess`), as the [threat model](#threat-model) advises for anything an agent's shell must not reach.

The REST is `GET api/workspace`, `GET api/workspace/<place>/list?path=`, `file?path=` (the text, `hash`, `editable` and, when not, `reason`), `raw?path=` (bytes, `no-store`, `&download=1` forces a download), `PUT file?path=` (`{ text, baseHash }`), `POST new?path=` (`{ kind: "file" | "dir", text? }`), `POST rename` (`{ from, to }`), `DELETE entry?path=`, `GET trash`, `POST trash/<id>/restore` and `DELETE trash/<id>`.
The service worker never caches `api/workspace`.

## Members and the gate

By default the app lets in only owners, as it always has. With `admission: "access"` it lets in everyone the host's `IDENTITY` admits on the app's surface: owners, admins and members. The app never makes a rule of its own about who that is; it asks `IDENTITY`, whose `access` configuration decides.

### Who is let in

`admission: "access"` needs a credential that names a person: `auth: { mode: "oidc", ... }` (below), or a verifier that reports who signed in. `none` and `password` speak for one shared actor and are refused with it.

- A person whose identity is linked to a principal is looked up with `IDENTITY.peek`, which writes nothing. A person nobody has linked is admitted through `IDENTITY.resolve`, which makes a new principal only where `access.provisioning.app` is `admitted` for the surface; otherwise they are refused.
- The facts the app reports are partial (`partial: true`): signing in here shows less than a person may hold elsewhere, and never lowers a tier recorded somewhere else. An admin in the app is a lasting admin grant, or a role named by the access rules as `app:role:<name>` that the provider's token carries.
- A disabled principal, and a person the rules give no tier, are refused with `403`.
- The tier is read again on every request and on a socket's every frame and once a minute. Losing admission closes the socket with 4403; a change of tier changes what it is sent from then on.

### Deny by default

One table decides every request before any handler sees it (`src/authz.ts`). A route that is not in it answers `404` to everyone, owners included. Each row says who it answers:

| Who | Routes |
|---|---|
| Owner | the owners' agent rooms (`api/rooms*`, a `404` to anyone else), the overview, skills, connectors, folders, agents, groups, the archive, prompts, the files pane, and the event stream |
| Any admitted person | their own conversations, notes and schedules, the host's rooms and pages, uploads, and pictures of agents |
| Anyone admitted, gated or not | the page itself, `config`, `session`, their notices, push, profile, links and onboarding |

A member's socket receives nothing from an agent room, neither as it happens nor when it connects: the owners' cards and the table of who is busy are sent only to sockets whose tier is owner now. A card is answered only by its own audience, the same rule as Discord's: for an approval that names approvers, the named ones who hold its tier now, and the owners; otherwise the turn's speaker and the owners where the scope escalates. A room's readers can never widen that.

### What each tier is served

`panes` takes a list for the owners and, with `admission: "access"`, `{ owner, admin?, member }` to choose per tier. The default gives a member `rooms` (the host's own rooms only), `conversations`, `notes`, `schedules` and `profile`, of those the host serves; an admin's list is the member's unless given. A member is never served `overview`, `workspace`, `skills` or `connectors`, and naming one for them stops the start. `table` is the one pane whose name a host may give a member or an admin (it needs that tier's `rooms` pane, and the owners' list must have it too): the default lists leave it out, so it is served only where the host names it.

- **The round table for members and admins**: the agent rooms are the owners', so a member's or an admin's table seats none of them. It seats the host rooms of every kind they may list (`GET api/host/<kind>`, the same lists and the same kind `access` as their room list, so a room the kind does not give them is no seat), newest first, in the same ring and the same looks. No new route is added: the table asks only for those lists. A seat is lit from its room's own frames, which the page follows by `subscribe` for the seats the scene draws (at most twelve), and a follow is answered only for a room the person may read now: `activity` (thinking, working, a turn already running when they follow) and the cards are addressed to the room's readers, as they are in the room, and a room they may not read sends nothing, however they ask. A room that asks for something in the kind's list (`attention`) sits as waiting. A tap on a seat opens that room's own page, where what the person may write (a note, a turn to the agent, or nothing) and press is decided by the kind's `access` as everywhere else, so the table has no dialogue box, no seat menu and no **Who's at the table** sheet for them (those mute and arrange agent rooms, which are the owners'), and an address `#/table/<seat>` goes back to the whole ring. The "+N" podium opens the room list. The table sends the person nothing of the overview, the files pane, the skills or the presence of the team, and the owners' view is unchanged.
- **Conversations**: a member lists and reads only the private conversations the registry records as theirs, found by the registry; `exclude(key, record)` is asked on every list and every transcript read.
- **Notes**: their own only. Asking for another person's is `403`. The pane is left out, with a warning, when the host keeps no memory (`MEMORY`); naming it with none is an error.
- **Schedules**: their own, whichever of the 0.8 and the current id the schedule names them by; an owner sees every schedule.
- **Profile**: who they are signed in as, and Log out.

### The gate

A required step the person still owes (see `onboarding`) closes the app on it: only their profile, settings and the pages that finish a step answer, the page shows the steps with a link to each, and the socket carries only the gate, their notices and refusals. When the last step is done the page loads again with everything the person may now see.

### Deep links

A link to a page can name where to go after signing in: `?next=profile`, `?next=notices`, `?next=settings`, `?next=room:<key>` for a room of the app's surface, or `?next=p:<page>` for a host page. Anything else, an address of another site included, is dropped.

## Install on a device

The app is a progressive web app, installable on a phone, tablet or desktop and opened in its own window.

- `<mount>/manifest.webmanifest` is generated for the mount: its `id`, `start_url` and `scope` are all `<mount>/`, `display` is `standalone`, the name is `title`, and the theme and splash colors follow `appearance.look`. The page links it with `crossorigin="use-credentials"`, so a proxy such as Cloudflare Access that sets a cookie sees it.
- `<mount>/sw.js` is the service worker, served `no-cache` and scoped to the mount. It precaches the page's hashed assets and `index.html`, serves assets cache-first and navigations network-first with the cached shell as the offline fallback. It never touches `api/`, `auth/`, `login`, `files/` or `avatars/`, and returns a redirect (a proxy's login) as it came. It caches the shell only, never data, so a shared device keeps nothing after you log out. The round table's 3D scene and the files pane's editor and languages are fetched the first time they are needed and are not precached.
- `<mount>/icons/` serves `192.png`, `512.png`, `maskable-512.png`, `apple-180.png` and `badge-96.png`, and `mark.svg`, the round-table mark. The package ships a set; `icons.dir` replaces it with a directory that has the same five PNG names, and `mark.svg` too if it should be the tab icon.
- The tab icon is the round-table mark by default. The page, the sign-in page and the pages of the sign-in flow link `<mount>/icons/mark.svg` (when the icon directory has it) and `<mount>/icons/192.png` as `rel="icon"`, so the browser does not ask the site root for `/favicon.ico`. The page also carries `og:title`, `og:description` and `og:image` (`<origin><mount>/icons/512.png`) for link previews.
- The manifest and the icons answer without a session, in every `auth` mode: they are the same for everyone, and a sign-in page and a link preview need them before anyone has signed in. Nothing else below the mount does.

To install: open the page over HTTPS in Chrome, Edge or Safari and use the browser's Install option, or press **Install the app** in Settings where the browser offers it.
On iPhone and iPad use Share, then Add to Home Screen, and open the app from the home screen: iOS allows notifications only to an installed app.
An installed page that a release has replaced while it was open reloads once by itself; if it still fails it shows a card with Reload.

## Notifications

The app can wake a device with Web Push when something waits and no page of that owner is in view.
Each owner turns it on per device in **Settings**, where every subscribed device is listed (with a name such as "Chrome on macOS") and can be removed; logging out unsubscribes the device.

A push goes out when:

- a card opens in an app room: "Card waiting", or "Long-running cap reached" for a time-limit card in a long-running room;
- an agent posts in an app room, and no message from a page started that turn: a schedule's or a job's report, or a reply that arrived after the card grace. A second reply in the same room within 15 seconds is not pushed;
- a notice reaches the owner: `notify` through the app's direct channel writes a line in Home and pushes it, and a notice that Discord (or another channel) delivered is pushed too, through the core's `mirror` hook.

Discord's own cards are not pushed.

**Quiet hours.** From 23:00 to 08:00 by default, the second and third kinds of push are held back: an agent's post and a notice are not pushed, so a report that arrives at night waits in its room until the owner looks.
A card (one waiting, or the long-running cap) is still pushed, since work stops until someone answers it.
The hours are read on the console's time zone (`env.timeZone` of the host, the zone the page shows times in), and a window that ends before it starts crosses midnight.
`push.quietHours` sets them as `{ start: "22:30", end: "07:00" }` (two different `HH:MM` times on a 24-hour clock), or `false` to push at any hour; anything else stops the start.
**Settings** shows the window and its time zone to every owner, read-only: only the server sets it.

**Muting a room.** An owner turns a room's Notifications off in the agent sheet, the room's ⋯ menu or the long-press menu of its row. The mute belongs to the room: it holds for every owner and every device, and is kept in the database (`web_push_muted_rooms`). A muted room is held back like the quiet hours: an agent's post in it is not pushed, while a waiting card, the long-running cap and a notice still are; a thread under the room follows the room's mute. A bell-slash marks the room in the list, the drawer and the header.

With `push.preview` on (the default) a notification shows the first 120 characters of the message; with `push.preview: false` it says only that something waits and where.
Tapping a notification focuses the app or opens it at the room.

Setup:

- **`push.subject`** is the contact a push service may use about this server (the VAPID `sub`): a `mailto:` address or an `https:` URL. It defaults to `origin` when that is `https`; with an `http` origin, push stays off, the host logs a warning, and a device cannot subscribe, until you set it.
- **Keys.** The server makes a VAPID key pair (P-256, with WebCrypto) at its first start and keeps it in `<dataDir>/web/vapid.json`, readable by its user alone. Subscriptions are bound to the public key, so keep the file across restarts and deploys; a file that cannot be read stops the start, and deleting it means every device must subscribe again.
- **Push services.** A subscription's endpoint must be `https`, with no port or credentials, and on an allowed host: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com` and `*.notify.windows.com`. `push.endpointHosts` adds hosts for another browser's service; a leading `*.` allows every subdomain. Any other endpoint is refused with `400`, so an owner's session cannot make the host post to an address of its choosing.
- **Delivery.** The payload is encrypted for the device (RFC 8291, `aes128gcm`) and signed with a VAPID token (RFC 8292, ES256 with `jose`); there is no push dependency. A `404` or `410` from the service removes the subscription, as do five failures in a row. A person has at most 20 devices.
- **Who gets it.** Only a device of a person who is still an owner, and only while no open page of that owner reports itself visible.

## Notices and the profile

A notice is something that waits on one person, such as a customer's message or a card to approve. A host raises one with `Notices.raise({ tag, people, title, open, urgency?, via? })` and takes it back with `Notices.resolve(tag)`; `renotify` adds people to an open one. `open` names exactly where a tap goes: `{ room, message? }` (the room, scrolled to that message) or `{ page, query? }`. A notice appears in the bell, with a count on the app icon where the device allows it, and is pushed according to its `urgency`: a normal one waits in the bell during the person's quiet hours, an urgent one rings and stays on screen until dealt with. `via` narrows a notice to named transports (see `push.transports`).

The `tag` is the notice's dedupe key, the tag of its push and the key of its acknowledgement, so it is not secret from the people the notice is for: their browser sees it. Do not put an id that those people should not see in it (a customer's or a group's id); use a hash or a counter of your own instead.

Tapping a notification or a bell row opens exactly that room or page, whether the app is open (its window comes forward and goes there) or closed (a new window opens at the address; a signed-out person signs in and lands there). A device reports when a notice arrived and when it was opened, which is how the app knows a test notification reached the device.

The profile page (`profile`) shows the person's name, picture and tier, the accounts they linked and the ones they can link or unlink, **Shown as** (which linked account names them in the app, or Automatic), and their own quiet hours with a test notification. An account that the host's configuration links cannot be unlinked there.

### An external push sender

With `push.sender: { external: { publicKey } }` the app holds no VAPID key: it queues each push as a row in `web_push_outbox` and a separate process empties it. Run that process with `runPushSender` from `pi-roundtable-web/push-sender`:

```ts
import { runPushSender, webPushTransport } from "pi-roundtable-web/push-sender";

runPushSender({
  database,                         // a role that may SELECT the outbox, subscriptions, sessions and principals, UPDATE the outbox, and INSERT deliveries and subscriptions
  transports: [webPushTransport({ /* the VAPID key pair and subject */ }), mySlackTransport],
  render: (row) => ({ title: "Something needs you" }), // with push.content "none" the row carries no text
  subscribe: {                      // omit when the app's own subscription routes are used
    listener: { port: 8788 },
    path: "/push/subscriptions",    // the app's push.sender.external.subscribePath
    origin: "https://app.example.com",
    authenticate: (request) => webSessionPrincipal(database, request),
  },
  logger,
});
```

The sender tries its transports in order for each row until one says it was sent, narrowed by the row's `via`. Its subscription routes answer only with the app's session cookie, and every request other than a GET must carry exactly the console's `Origin`, or it is refused with `403`. `webSessionPrincipal` and `webSessionClaims` read the session cookie, the second giving the claims of a person's newest live session (set `auth.storeClaims` for them to be stored). Nothing in the app process can read the key.

## Authentication

The app never makes an account.
One authenticator checks every request under its path before anything is read, whether it is a page, the API, the event stream or the WebSocket upgrade of the owner app.
You choose how with the `auth` option; the console then looks the person up in the host's `IDENTITY`, reading only, and admits them only when their principal holds the owner role.

| `auth` | Who is the owner | Use it when |
|---|---|---|
| `{ mode: "verifier", verifier }`, or the `verifier` option as shorthand | The person the verifier reports, linked to an owner's principal. | A proxy such as Cloudflare Access authenticates people in front of the listener. This is the one mode whose proof an agent on the host cannot forge. |
| `{ mode: "password" }` | The primary owner, once they give the password. | The console is reachable from the internet with no proxy that signs people in. |
| `{ mode: "none" }` | The primary owner, whoever reaches the listener. | Only the owner can reach the listener: a unix socket, or loopback TCP. |
| `{ mode: "oidc", issuer, clientId }` | The person the provider reports, by the identity `IDENTITY` links to a principal. With `admission: "access"`, members and admins too. | People sign in with a provider of your own, without a proxy in front. See [OpenID Connect](#openid-connect). |

Giving both `auth` and `verifier` throws, and so does giving neither: the plugin never starts without a way to authenticate.
Whatever the mode, a request that changes data must carry the console's own `Origin`.
It answers `403 Forbidden` with no detail when the verifier refuses, throws, or rejects, when the lookup fails, and when the person is no owner.

### Password

```ts
webConsole({
	auth: { mode: "password" }, // reads ROUNDTABLE_WEB_PASSWORD
	origin: "https://console.example.com",
	dataDir: "./data",
});
```

| Setting | Default | What it does |
|---|---|---|
| `passwordEnv` | `ROUNDTABLE_WEB_PASSWORD` | The environment variable that holds the password. It must be set and at least 12 characters, or the host stops at startup, naming the variable and never the value. |
| `sessionDays` | `30` | How long a login lasts, from 1 to 365 days. |
| `principal` | the primary owner | The owner's principal id the session speaks for. |

`<mount>/login` is a server-rendered form that needs no script.
A wrong password answers `401` after one second.
Ten wrong passwords in 15 minutes, counted for all visitors together, make every login answer `429` with `Retry-After` until the window passes, the right password included: behind a proxy the client's address is not trustworthy, so the limit is global.
The right one sets the cookie `rt_session`: signed, `HttpOnly`, `SameSite=Strict`, `Secure` when `origin` is https, and `Path=<mount>/`, and answers `303` to the console.
`POST <mount>/auth/logout` clears it.
Without a session a page navigation answers `303` to the login page and the API answers `401`; only `login`, `auth/login` and `auth/logout` are public.
The login and logout `POST`s need the console's own `Origin`.

The cookie is signed with a key derived from `<dataDir>/web/session.key` (32 random bytes, mode `0600`, made at the first start) and from a hash of the password, so changing the password signs everyone out, and the key file alone signs nothing a host with another password accepts.
A key file of the wrong size stops startup.

### None

```ts
webConsole({
	auth: { mode: "none" }, // the listener must be a unix socket, or TCP on 127.0.0.1, ::1 or localhost
	origin: "https://console.example.com",
});
```

`none` must be written out: it is never the default.
It reads the listener's address from the host (`context.listener`) and refuses to start for TCP on any other hostname, or with no hostname, which binds every interface, unless `trustNetwork: true` says a network in front of it keeps everyone else out.
A unix socket passes, with a warning when its mode lets other users write to it.
The console warns at every start that whoever reaches the listener is the owner.
It speaks for `principal` (default the primary owner) through the plugin identity `token:web-console`, which the plugin declares itself, so no `access.owners` entry is needed.

Read [Threat model](#threat-model) before choosing `none` or `password` on a host whose agents run a shell.

### Verifier

A verifier is a function that receives the `Request` and returns `{ admitted: true, actor, expiresAt? }` or `{ admitted: false, reason }`.
`actor` describes the person as an identity, `{ provider, subject, name }`, written `<provider>:<subject>` in `access.owners[].identities` and by `roundtable principal link`.
The reason goes to the host's log and is never sent to the client, so keep secrets out of it.
`expiresAt` says when the proxy's assertion lapses; `cloudflareAccess` fills it from the token's `exp`, and a connection that outlives requests, such as the owner app's WebSocket, ends then.
`admitAs(actor, expiresAt?)` and `refuse(reason)` build the two answers.

The console decides who the request comes from by what the verifier reported:

| The verifier reports | The console |
|---|---|
| An identity linked to an owner's principal | Admits them as that owner. |
| An identity linked to anyone else, such as a member, or to a disabled principal | Refuses. |
| An identity linked to no one, however many owners the host has | Refuses, and warns once with the full identity, the line to add to its owner's `access.owners[].identities`, and the `roundtable principal link <owner> <identity>` command that links it instead. |
| No actor (`admit()`, a verifier written for 0.8) | Admits the request as the primary owner, the first of `access.owners`, or as `ownerId` when set, and warns once. |

The console never resolves an identity the way a chat surface does: a visitor is never admitted as a new principal and never claims a 0.8 one.
It refuses an identity of the `legacy` provider too, as resolving refuses it: that is the alias 0.9 keeps for a 0.8 id, not anyone's sign-in.
A verifier may vouch for members as well as owners, through a proxy that lets the whole company in or an allowlist that grows, so the console never guesses whose an identity is: only a link says so.

### OpenID Connect

`auth: { mode: "oidc", issuer, clientId }` signs people in with any OpenID Connect provider (Microsoft Entra, Google, Keycloak, Authentik and the like) by the authorization code flow with PKCE. The origin must be `https`: the session cookie is `Secure`.

1. A person with no session is sent to the provider with a state, a nonce and a PKCE challenge, kept in a signed cookie that lives ten minutes and works once. The first visit asks silently (`prompt=none`), so a live single sign-on needs no click; when the provider answers `login_required` the person is asked once, normally.
2. At the callback the code is exchanged, and the `id_token` is checked once: its signature against the provider's published keys, issuer, audience, expiry and nonce. A state that does not match or was used before, a callback with no pending cookie, and a token that fails any check are refused and make no session.
3. `IDENTITY` admits the person (see [Who is let in](#who-is-let-in)); only then is a session made: a random 256-bit id in an `HttpOnly` cookie, of which the database keeps only the SHA-256, in the `web_sessions` table. No token, claim, code or session id is logged.
4. The session slides: it ends after `sessionDays` (30) without a visit, and a visit moves the limit at most once an hour. Nothing the provider said is trusted again; the tier is read from `IDENTITY` on every request. Disabling the principal refuses the next request and closes the socket.
5. Log out deletes the row, so the old cookie is refused afterwards, clears the cookie and, with `endSession`, also signs out at the provider. A person who just logged out is asked, not signed in silently again.

`reauthHours` makes the provider vouch again: past it, the next page load does a silent round trip that refreshes the stored facts and roles, a provider that wants the person sends them through a normal sign-in, and a request to the API on such a session is answered `401` until then. An open socket checks the same limit at its periodic recheck and is closed as signed out, so its page shows sign-in again. `storeClaims` keeps the named `id_token` claims with the session, replaced at each sign-in, for a sender that needs, say, a mailbox address.

`onSessionVerified(principalId)` is called when a request or an open socket proves a live session, at most once per session every five minutes. A session past `reauthHours` is not live for this, on either path. Use it to count who is present: a host that keeps a linked chat account only while its web person is active can note the person there, even when they only have the app open and call nothing of the host's. It is not awaited, and an error it throws is logged and never fails the request.

### Upgrading from 0.8

The core [Migrating to 0.9](../../docs/migration-0.9.md) guide covers backfill, rollback, and the principal isolation boundary.
This console remains an owner administration surface, not a principal-private view: every admitted owner can inspect every conversation and principal's notes.

In 0.8 the console took everyone the verifier admitted as the owner.
It now admits a person only when the identity the verifier reports is linked to an owner, so link yours before you upgrade, or the console answers 403 after it:

1. Find your Access user id, the token's `sub`: sign in once after the upgrade, and copy the identity from the warning in the host's log, which gives it whole.
2. Add `cloudflareAccessIdentity(teamDomain, sub)` to your entry in `access.owners[].identities`, or run `roundtable principal link <your principal id> <identity>` on the host.

A verifier of your own that still answers `admit()` without an actor keeps working as before: its requests are the primary owner's, with a warning.

### Cloudflare Access

`cloudflareAccess(options)` is the built-in verifier.
Cloudflare Access sits in front of your tunnel or proxy, signs in the owner, and adds a signed token to each request it forwards as the `Cf-Access-Jwt-Assertion` header.
The verifier admits a request only when the token is signed by your team's published keys, was issued by your team, is addressed to this application, names a user, and carries an email you allow (compared without regard to case).
It reports the user as an OpenID identity of the team's issuer: `oidc:<base64url of https://<teamDomain>>:<sub>`, where `sub` is the user's Access id in the token, with their email as the name.
It checks the token on every request and fetches the team's signing keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, caching them and following their rotation.
If the keys cannot be fetched and none are cached, requests are refused.

| Option | What it is |
|---|---|
| `teamDomain` | Your Access team domain, `<team-name>.cloudflareaccess.com`, with no scheme or path. |
| `audience` | The Application Audience (AUD) tag of the Access application that protects the console. |
| `email` | The email, or a list of emails, that may use the console. The console still admits only those whose identity is an owner's. |

To set it up:

1. Route a hostname to the host's listener, for example with a Cloudflare Tunnel whose public hostname (`console.example.com`) points at the listener's port or unix socket.
   Use a hostname you do not share with anything that must stay open.
2. In the Cloudflare dashboard, open Zero Trust, then Access controls, then Applications, and add a **Self-hosted** application for that hostname.
   Add the path `console` to the application's public hostname to protect only the console, or leave the path empty to protect the whole hostname.
3. Give the application one **Allow** policy that includes only the owners' emails.
   Do not add a Bypass or an Everyone policy.
4. Open the application's configuration, and under Additional settings copy the **Application Audience (AUD) Tag**.
   Keep it in an environment variable and pass it as `audience`.
5. Take your team name from Zero Trust settings, the `<team-name>` of `<team-name>.cloudflareaccess.com`, and pass the full domain as `teamDomain`.
6. Set the plugin's `origin` to the address you opened in step 1, `https://console.example.com`.
7. Add each owner's identity to their entry in `access.owners`.
   Build it with `cloudflareAccessIdentity(teamDomain, sub)` from the user id shown in Zero Trust, or sign in once: the console refuses you and the host's log names the identity it saw (`oidc:…:<sub>`) with the line to add.
   Until you do, the console refuses that owner, on a single-owner host as well.

A request to the console from a browser that has not signed in is sent by Access to its login page and never reaches the host.
The host still refuses any request that arrives without a valid token, so a listener that becomes reachable without Access, through a wrong route or a second tunnel, does not open the console.

### A verifier of your own

Behind another authenticating proxy, write the verifier for what that proxy sends.
This one trusts a header that a reverse proxy sets after it has authenticated the person, which is safe only when the proxy removes the header from client requests and the listener cannot be reached except through the proxy, for example on a unix socket (`http.socketPath`) that only the proxy's user can open.
It reports the person as the identity `proxy:<email>`, which `access.owners[].identities` then lists for each owner:

```ts
import { admitAs, refuse, webConsole } from "pi-roundtable-web";

export const web = webConsole({
	verifier: (request) => {
		const email = request.headers.get("x-authenticated-email")?.toLowerCase();
		return email
			? admitAs({ provider: "proxy", subject: email, name: email })
			: refuse("no authenticated email");
	},
	origin: "https://console.example.com",
});
```

A verifier can also verify a signed token itself, with `jose` or any other library, which does not depend on the network path and is the stronger choice when the proxy can sign what it sends.
It may be asynchronous; a thrown error or a rejected promise counts as a refusal.

## Threat model

**What the app protects.**
The conversations hold everything the host's people said to the assistant and what the assistant answered, including tool calls and their results, and the memory notes shape every later turn.
The app serves that to the host's owners and nobody else, and since 0.23 it also acts for them: a signed-in session can run turns, approve held actions, switch yolo mode on, send files, change an agent's prompt, model and skills, make, archive and delete agents and groups.
So the authentication guards the owner's power over the agents, not only their reading.
Every write, over REST or the WebSocket, needs an authenticated owner whose tier is read again, and an open socket closes (`4401`, `4403`) when the credential lapses or the person stops being an owner.
Every owner sees every conversation and can read and change every principal's notes; it has no per-user views for members, and no audit trail beyond the host's log, which records only that a request was refused and why.

**Authentication is the `auth` mode; authorization is the owner role.**
Who holds the owner role is the host's `access` configuration or the `roundtable principal` CLI, never something the authentication reports, so one that admits a member admits no one.
With a verifier the console sets no cookie and keeps no session.
The built-in Cloudflare Access verifier checks a signature, so a client that can reach the listener directly still cannot forge a token.
A custom verifier that trusts a plain header is exactly as strong as the guarantee that clients cannot set that header: use a unix socket or a firewall rule so that only the proxy reaches the listener, and have the proxy strip the header from inbound requests.
With a verifier the console does not rate-limit failed requests; do that at the proxy.

**Yolo and long-running work unattended.**
Yolo mode approves held calls on the server, so a mistake is not caught by a person.
Its guardrails: it approves only for a turn whose speaker is an owner and never the host's own principal (a webhook or a report turn), never a call that names approvers or is the speaker's alone, and never a call whose hold classes are not all allowed; destructive shell classes still ask, the classes come from every command in the line (including `bash -c`), and a call held without classes always asks.
A plain `git push` and a write outside the workspace are approved, which can deploy; list `shell.push` in `autonomy.yolo.card` to stop that.
Every approval is logged, shown in the room, and a banner stays up while the mode is on.
Long-running work is capped per turn (`autonomy.longRunning.maxSeconds`, four hours by default) and then asks or aborts; `ask_user` is never answered for you.

**Push posts to an address the browser hands over.**
A subscription names a URL on a push service, so without a check any owner session could make the host fetch any address.
The endpoint must be `https`, with no port or credentials, on an allowed push-service host (`push.endpointHosts` extends the list); everything else is refused with `400`, and only the person who added a device can list or remove it.
The payload is encrypted for the device end to end, and with `push.preview: false` it carries no message text at all.

**Text and files from agents and uploads are untrusted.**
Agent output is Markdown without raw HTML.
A stored file is always served as a download with `content-security-policy: sandbox` and `nosniff`, and only four image types are shown inline.
The page's Content-Security-Policy is unchanged by the service worker, the manifest and the characters (`manifest-src` and `worker-src` fall back to `'self'`), and `frame-ancestors 'none'` stays.
A room key from a page must be one of the app's rooms whose agent or group exists; a Discord key or another surface's key is refused.

**The service worker keeps the shell only.**
It never caches `api/`, `auth/`, `login`, `files/` or `avatars/`, so a shared device keeps no conversation after a logout, and a logout also removes the device's push subscription.

**`none` trusts the listener, and `password` trusts the host's own user.**
The agents' shell runs as the service user and inherits the host's environment, so anything that user can reach, a prompt-injected agent can reach too: the environment variable that holds the password, `<dataDir>/web/session.key` and the listener's socket.
With `none`, an agent on the host can call the console as the owner with `curl --unix-socket`, approve its own held actions, and change modes: `Origin` is only a header to `curl`, and `curl` is not held.
With `password`, an agent can read the password and the session key and sign in.
Both resist the network, and neither resists a compromised agent on the host.
Only a verifier does, because an agent cannot forge a signed token it has no key for.
Choose `none` for a host whose agents have no shell, or whose listener a different user owns, and keep Cloudflare Access (or another signing proxy) for one whose agents run commands; the startup warning of `none` says so.
Password mode adds a login that cannot be brute-forced from the network (a one-second wait per failure, a global limit of ten in 15 minutes, a constant-time comparison, a 12-character minimum), a cookie a script on the page cannot read and another site cannot send (`HttpOnly`, `SameSite=Strict`, `Secure` over https), a logout, and a key that changes with the password.
The limit is global, so someone who guesses wrongly on purpose can keep the owner from signing in for 15 minutes; that is the price of not trusting a client's address.

**Cross-site requests.**
A request that changes data (`POST`, `PUT`, `PATCH`, `DELETE`) is refused unless its `Origin` header is exactly the configured `origin`, after the authentication has admitted it, and the WebSocket upgrade must come from that origin too.
Reads change nothing.
A page on another site that makes the owner's browser send a request therefore cannot write notes, and it cannot read the answers either, because the console sends no CORS headers.

**Cross-site scripting and framing.**
The page is a prebuilt bundle served from the same origin.
Every response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`, and the page carries a Content-Security-Policy of `default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, so it loads only its own script and style and cannot be framed.
Path routing uses `base-uri 'self'` for the package-inserted, validated mount base.
Transcript text, notes, and channel names are rendered as plain text, and no link is taken from a transcript.
Skill documents render Markdown with raw HTML escaped, no fetched images, and only HTTP(S) links; relative links remain non-navigating text.
Links to Discord are built by the page from channel ids, not taken from stored text.

**Errors reveal nothing to the client.**
Every API error is a fixed message.
It never repeats the request URL, a header, or a token, and a refusal answers `403 Forbidden` with that single word (`401 Unauthorized` for a request without a password session).
The console logs a failure with the error that was thrown and nothing from the request: no URL, no headers.
The text of an error that your own code throws, such as a memory store's, is logged as it is.

**Path handling and resource limits.**
A conversation is named by a channel key that must match `discord:<id>`, `agentgroup:<id>.<agent>`, or `mcp:<uuid>` exactly, and an archive is chosen from the folder's own listing, so no request can name a path.
A note request body is limited to 64 KB, a transcript to 8 MB read and 1000 entries, an entry's text to 20 000 characters, and the list of an outside agent's first message to the first 256 KB of its file.
Session directory, file and archive symlinks are not followed by the console.
At most 32 event streams stay open at once, and a stream whose client falls 16 events behind is closed, after which the page reconnects and refetches.

**What the transcript can reveal.**
A transcript shows the arguments of the assistant's tool calls (the first 200 characters) and the first 2000 characters of each result.
If your tools handle secrets, they can appear there.
Serve only the `notes` pane, or use `exclude`, when that is a concern.

**Out of scope.**
Transport security (terminate TLS at the proxy), protecting the data directory on disk, and what members see are not the console's job.
The console is for the owners of one host; members talk to the host through its chat surfaces.

## Options

Every option is checked when the plugin is created, so a bad setting stops the host at startup.

| Option | Default | What it does |
|---|---|---|
| `auth` | none, `auth` or `verifier` required | How requests are authenticated: `{ mode: "none" }`, `{ mode: "password" }`, `{ mode: "verifier", verifier }` or `{ mode: "oidc", ... }`; its keys are in the next table, and [Authentication](#authentication) explains the modes. |
| `verifier` | none | Shorthand for `auth: { mode: "verifier", verifier }`: decides whether a request comes from someone your proxy authenticated, and reports who. `cloudflareAccess(...)` is built in; pass your own function to use another proxy. Giving both `auth` and `verifier` throws. |
| `origin` | none, required | The app's own origin as the browser sees it, such as `https://app.example.com`: scheme and host (and port), no path. Requests that change data must carry it as their `Origin`, the dashboard line links to it, and push derives its default contact from it. |
| `ownerId` | the primary owner | Deprecated. The owner's principal id that a request from a verifier reporting no actor stands for. The Notes pane no longer needs it: it shows each owner their own notes. |
| `dataDir` | `./data` | The host's data directory; the console reads `<dataDir>/sessions`, and the app keeps `web/` (the session key, the VAPID keys, uploaded and reply files) under it. Set it to the `dataDir` of your configuration. |
| `mountPath` | `/console` | The path the app is served under: one or more segments of letters, digits, `.`, `_`, `~`, and `-`. |
| `listener` | `public` | The id of the listener whose address serves the app. |
| `routing` | `hash` | `path` retains links such as `/console/skills`, with history navigation and an authenticated page fallback. |
| `admission` | `owners` | `owners` lets in only people who hold the owner role; `access` lets in everyone `IDENTITY` admits on the surface. See [Members and the gate](#members-and-the-gate). |
| `modes` | on | `false` leaves out the yolo and long-running switches: none is shown or set, and `PUT api/rooms/<key>/mode` answers 404. |
| `panes` | `rooms`, `table`, `workspace`, `overview`, `schedules`, `conversations`, `notes` | Ordered subset of those panes plus `skills` and `connectors`. `schedules`, `table` and `workspace` need `rooms`, and `workspace` needs a place to show (below). With `admission: "access"` the default adds `profile`, and `{ owner, admin?, member }` chooses per tier. Disabled panes answer 404. `skills` and `connectors` require their feature ports at setup. An explicit list is kept as written, so a host that listed its panes before 0.23 adds `rooms`, `table` and `schedules` by hand, and one that listed them before 0.24 adds `workspace`. |
| `workspace` | the agents' directories | What the [files pane](#the-files-pane) shows: `workspace.roots` adds places, each with an `id` (`workspace.roots.id`, a lower-case word other than `agents` and `scratch`), a `label` (`workspace.roots.label`), an absolute `dir` (`workspace.roots.dir`) and `writable` (`workspace.roots.writable`, false unless set), and `workspace.agents` / `workspace.scratch` set to `false` leave the agents' working directory or scratch directory out. A `dir` that is or contains `dataDir` stops the start. |
| `surface` | `app` | The key prefix of the app's rooms, a lower-case word that is not `discord`. Rooms keep their conversations under it, so changing it starts every room over. |
| `cardGraceSeconds` | `120` | How long a turn waits on an approval or question card before it goes on without the answer, above 0 and at most 3600. The card stays open for a day. |
| `uploadMaxBytes` | `104857600` (100 MiB) | The most bytes of one file a person may upload, from 1 to 4 GiB; the agent takes files up to it too. It raises the listener's request body limit. See [Uploads](#uploads). |
| `uploads` | `{ keepDays: 30 }` | `uploads.keepDays`: how many days a stored file of the app's agent rooms is kept, a whole number from 1 to 3650. A host kind's own `retention.fileDays` decides for its rooms. |
| `push` | on, with an `https` origin | Web Push; its keys are in the table below, and [Notifications](#notifications) describes the whole. |
| `icons` | the package's own | `{ dir }`: a directory of the five install icons, see [Install on a device](#install-on-a-device). |
| `appearance` | `{ look: "modern" }` | `{ look }`: `modern` or `camelot`. The page's default look and the manifest's splash colors; the owner can switch it in the app. |
| `title` | `Roundtable` | The page's heading, `<title>` (set in the served HTML, so a tab and a search result have it before the script runs), `og:title` and the installed app's name. |
| `description` | a line derived from `title` | The page's `<meta name="description">` and `og:description`, for search results and link previews. |
| `presentation` | English | `{ locale, messages }`: locale controls dates and document language, and `zh-TW` also selects the [built-in Traditional Chinese wording](#presentation-and-built-in-zh-tw); English source strings are dictionary keys for labels, descriptions, confirmations, and API errors. |
| `features` | none | Trusted host integrations, or a factory receiving public plugin setup context; see [Host feature ports](#host-feature-ports). |
| `relayNotes` | the remote MCP note | Text that an outside agent's relayed message begins with, taken off before the owner's words are shown. Set it to the same value as the `relayNote` of [pi-roundtable-mcp][mcp] when you changed that one. |
| `exclude` | none | A function from a channel key (and the registry's record of the conversation, when there is one) to `true` for conversations the console must neither list nor read, such as the channels of another plugin that keeps its own sessions in the same directory. |
| `assetDir` | the package's `dist/` | The built page's directory. Set it only in tests. |

The `auth` keys:

| Key | Default | What it does |
|---|---|---|
| `auth.mode` | none, required | `none`, `password`, `verifier` or `oidc`. |
| `auth.trustNetwork` | `false` | `none` only: allows a TCP listener that reaches beyond this machine, when a network in front of it keeps everyone else out. |
| `auth.passwordEnv` | `ROUNDTABLE_WEB_PASSWORD` | `password` only: the environment variable that holds the password, which must be set and at least 12 characters. |
| `auth.sessionDays` | `30` | `password` only: how long a login lasts, 1 to 365 days. |
| `auth.principal` | the primary owner | `none` and `password`: the owner's principal id the session speaks for. |
| `auth.verifier` | none | `verifier` only: the request verifier, as the `verifier` option. |
| `auth.issuer` | none, required | `oidc` only: the provider's exact `iss`, an `https` URL. |
| `auth.discoveryUrl` | `<issuer>/.well-known/openid-configuration` | `oidc` only: where the provider's endpoints are read at start; the start fails if they cannot be. |
| `auth.clientId` | none, required | `oidc` only: the client id registered with the provider; the redirect URI is `<origin><mountPath>/auth/callback`. |
| `auth.clientSecretEnv` | none | `oidc` only: the environment variable that holds the client secret; set means a confidential client, left out a public client with PKCE. |
| `auth.scopes` | `openid`, `profile` | `oidc` only. `offline_access` is refused: the app keeps no refresh token. |
| `auth.subjectClaim` | `sub` | `oidc` only: the claim that names the person (Entra: `oid`). |
| `auth.nameClaim` | `name`, then `preferred_username` | `oidc` only: the claim for their name. |
| `auth.rolesClaim` | `roles` | `oidc` only: the claim whose values become `app:role:<name>`; `false` reads none. |
| `auth.check` | none | `oidc` only: a function from the token's claims to whether the token is acceptable at all. |
| `auth.endSession` | `false` | `oidc` only: whether Log out also signs out at the provider. |
| `auth.reauthHours` | never | `oidc` only: ask the provider again after this many hours of one session. |
| `auth.storeClaims` | none | `oidc` only: `id_token` claims kept with the session. |
| `auth.onSessionVerified` | none | `oidc` only: `(principalId) => void`, called when a request or socket proves a live session (once per session per five minutes). |

The `push` keys:

| Key | Default | What it does |
|---|---|---|
| `push.preview` | `true` | Whether a notification shows the first 120 characters of the message. With `false` it says only that something waits, and where. |
| `push.quietHours` | `{ start: "23:00", end: "08:00" }` | The hours when an agent's post and a notice are not pushed, as two different `HH:MM` times on the console's time zone; an `end` before the `start` crosses midnight. Cards are always pushed. `false` turns quiet hours off. |
| `push.endpointHosts` | none | Push services to post to besides the browsers' own (Google, Mozilla, Apple, Microsoft), as host names; a leading `*.` allows every subdomain. Endpoints must still be `https`. |
| `push.tiers` | `["owner"]` | The tiers whose people may subscribe and receive push. |
| `push.subject` | `origin`, when it is `https` | The contact a push service may use about this server (the VAPID `sub`): a `mailto:` or `https:` URL. With an `http` origin push stays off until it is set. |
| `push.sender` | `"internal"` | Who signs and sends a push. `"internal"`: this process, with its own VAPID key. `{ external: { publicKey, subscribePath? } }`: a sender process you run holds the key, and this app never does; `publicKey` (base64url) is what browsers subscribe against, and `subscribePath` (starting with `/`) is where the sender serves the subscription routes, when it does. See [An external push sender](#an-external-push-sender). |
| `push.content` | `"full"` internal, `"none"` external | What leaves the app for a push: `"full"` is a title and a preview, `"none"` is the kind, a tag and a count only (the sender words it). A host room never previews. |
| `push.transports` | none | Names of the transports besides `web-push` that the sender process carries, such as `slack`. A notice's `via` may name only these and `web-push`; any other name is a `ConfigError` when the notice is raised. The app loads no transport itself. |

The `onboarding` keys (what a person owes before the app opens, see [The gate](#the-gate)):

| Key | Default | What it does |
|---|---|---|
| `onboarding.links` | none | Maps a provider name to `"required"` (gates the app until the account is linked) or `"nudge"` (only asks). Each provider needs a `LinkProver` registered through `WEB_APP`; the person links it on their profile page. A prover's `requires` decides the order. |
| `onboarding.push` | `"off"` | `"required"` or `"nudge"` asks the person to turn push on for a device and receive a test notification; `"off"` leaves it out. |
| `onboarding.pushWaiver` | `false` | Lets a person skip a `"required"` push step, which then counts as done and is recorded as waived. |

The bad settings that stop the host at startup are: no `auth` or `verifier`, both of them, an unknown `auth.mode`, a password shorter than 12 characters, `none` on a listener that reaches beyond the machine, an `origin` with a path, a `mountPath` of `/` or with `..` in it, an unknown or repeated pane, `schedules`, `table` or `workspace` without `rooms`, a `workspace` pane with no place to show, a `workspace.roots` entry that is malformed, reuses an id, or is or contains `dataDir`, a `surface` that is not a lower-case word or is `discord`, an empty `ownerId`, a `uploadMaxBytes` out of range, and a `push.subject` that is neither a `mailto:` address nor an `https:` URL, and a `push.quietHours` that is neither `false` nor two different `HH:MM` times.

The plugin needs, for the panes you serve: the agent server (`AGENTS`) for Overview and Rooms (and for the files pane's default places), the modes service (`MODES`) for Rooms, the schedule store (`SCHEDULES`) for Schedules, and the memory addon for Notes.
The host refuses to start with a message naming the missing service when one of them is absent.

## The console's panes

The page has ten panes; `panes` chooses which ones a host serves.
Rooms and Schedules belong to the [owner app](#the-owner-app), and the Round table to [its own section](#the-round-table); the rest are the console that came first, which reads what the host already stores: the conversation files under the data directory, the memory addon, and the agent team.

| Pane | What it shows |
|---|---|
| Rooms | The owner app: Home, agent and group rooms and dispatch threads (see [The owner app](#the-owner-app)). |
| Schedules | Every schedule of the team, labelled by room or channel, with cancel (needs `rooms`). |
| Overview | Every active agent with its model, thinking level, state (working where, waiting, or idle), context use, schedule count, and last activity; every group with its members, host, and busy count. An agent links to its Discord channel and its transcript, and a group to its Discord channel. |
| Conversations | Every conversation stored on disk, in four sections: owner channels (direct messages and channels where the owner talks to the assistant), agent channels, group conversations (each member's conversation inside a group), and outside-agent conversations opened over MCP. Each row shows the channel's name (when the host has a Discord connection), when it was last active, its size, and how many archives it has. An outside-agent conversation shows its first message, when it appears in the first 256 KB of the file, and when it began. A conversation the host's registry records also shows whose it is, by their display name, and whether it is private to them or shared. Every owner sees every conversation. |
| Notes | A principal's memory in three tabs, core, notes, and events, with search: the signed-in owner's own by default, and any principal's the host knows through a picker that appears when there is more than one. The owner can add a note, edit its text, kind, and date, and delete it after a confirmation, in whichever memory is shown. The memory addon's own validation applies, so a refusal shows its reason and saves nothing. |
| Skills | The full host catalog, source, groups and carriers; each available skill opens its ordered frontmatter and Markdown body, and an owner edits an agent-written skill or makes a new one. |
| Connectors | Upstream gateway enabled/reachable/tool status, virtual-server tool lists, and the agents or profiles that use them; an optional administration link. |
| Files | The agents' workspace: a tree, highlighted files, an editor with conflict-checked saves, and a restorable trash (see [The files pane](#the-files-pane)). Needs `rooms` and a place to show. |
| Profile | Who the person is signed in as, their tier, and Log out; it stays open while a step is owed. Part of the [members' app](#members-and-the-gate). |
| Round table | Every active agent at a podium of one council hall, the coordinator first, each in the state its room is in; a seat turns the camera to its agent and opens a dialogue box on the agent's room (see [The round table](#the-round-table)). Needs `rooms`. |

Opening a conversation shows its **transcript**: the user's and the assistant's messages, the tools the assistant called with a short preview of their arguments, and each tool's result (collapsed).
A conversation that was started over keeps its archives, and the page can show any of them.
The system prompt and the model's private reasoning are never shown.
A transcript reads at most 8 MB of the newest files and returns at most the last 1000 entries, and it says when it cut the beginning.

The page follows changes without a reload.
A turn starting or ending, a queued message, a change in the agent team, or a note written through the console reaches an open page through a server-sent event stream within about a quarter of a second, and a burst of changes arrives as one event.
Relative times refresh every 30 seconds.
Times and event dates use the host's time zone (`env.timeZone`).

Conversation cleanup is opt-in through `features.cleanup`.
Overview includes stored owner workspaces and outside conversations, and can include separately stored party channels through `features.party`.
Start-over archives a conversation through the host's hook; deletion is restricted to stored owner/outside conversations and a busy refusal becomes HTTP 409.
Confirmation dialogs explain that memory and schedules remain.
Without the cleanup hook, conversations remain read-only.
`GET api/dashboard` is a compatibility view of Overview with channel keys and `agentGuildId`, `channelId`, and `sessionId` aliases for existing clients.

## Host feature ports

`features` may be an object or a synchronous/asynchronous factory `(context) => features`.
Use the setup context to bind existing services; no database tables or session paths are renamed.
The host wrapper must declare any additional required service keys in its plugin's `requires`.

| Port | Contract |
|---|---|
| `party` | `contains(key)` separates party channels from owner transcripts; `list()` returns `PartyView[]` with channel, profile, enabler, enabled time, container state, busy count and optional last activity. |
| `schedules` | `count(key)` returns the workspace schedule count. |
| `cleanup` | `startFresh(key)` archives/waits for active turns and returns its kind; `deleteConversation(key)` returns `deleted` or `busy`. The package validates key shape, ownership, existence and exclusions before calling either hook. |
| `skills` | `catalog()` supplies public `SkillView[]`; `read(name)` reads only that catalog entry and returns `{ frontmatter, body }`. The host bounds disk reads and the API shows what `read` returns, flattening metadata in source order. A skill that cannot be read answers with a fixed message; set `errorDetail: true` to append the catalog's `missing` text or the read error's message (cut at 300 characters) when the host's reasons are safe to show. |
| `connectors` | `gateways()`, `servers()`, `usedBy(server)` provide status/tools/usage. Optional `adminUrl` accepts HTTP(S) or an absolute local path, never script URLs. |

`sessionSummary(directory)` is a public helper for a trusted host to summarize separately stored party session files.
It reports live bytes, archive count and last activity without revealing message contents.
Generic source and defaults are English; keep application names and localized wording in the host's presentation dictionary.
Authenticated HTML carries inert, escaped presentation metadata so the first API failure is localized too, without inline scripts.
The page ships prebuilt, so application adapters do not need their own React build or a second server implementation.

### Presentation and built-in zh-TW

Every string the page shows is an English key, and `presentation.messages` maps a key to the host's wording.
The package also ships a complete Traditional Chinese (Taiwan) catalog: when `presentation.locale` is `zh-TW`, `zh-Hant-TW` or `zh-Hant` (any case, and `zh_TW`), the console, the owner app, the sign-in page and the server's fixed refusals use it, so a host needs no dictionary of its own.
A key the host words in `messages` wins over the catalog, key by key, and an empty string counts as the host's wording; every other locale stays in English until the host words it.
Character names go through the same dictionary: `character.class.<id>`, `character.jobs.<id>` (what a class suits), `character.palette.<name>` and `character.<outfit|hat|prop|hair|beard|accessory>.<id>`, so a host can reword a class such as `character.class.wizard`.
The catalog is a chunk of its own that the page fetches only for that locale, and the service worker caches it with the rest.
A test fails when a string in the page's code has no catalog entry, so a new string cannot ship untranslated.
Wording that comes from the core (an agent's validation errors, a character's field errors) is not part of the catalog and shows as the core wrote it.

```ts
webConsole({
  // ...
  presentation: { locale: "zh-TW", messages: { "Round table": "My own name" } },
});
```

```ts
webConsole({
  // ...verifier, origin, ownerId...
  mountPath: "/console",
  routing: "path",
  panes: ["overview", "notes"],
  presentation: { locale: "fr", messages: { "Start over": "Recommencer" } },
  features: (context) => ({
    cleanup: {
      startFresh: (key) => context.conversations.startFresh(key),
      deleteConversation: (key) => context.conversations.deleteConversation(key),
    },
  }),
});
```

When serving Skills and Connectors, provide those hooks as well; a missing port fails startup rather than silently dropping a pane.

## Host rooms, pages and cards

A host plugin that is not an agent can have rooms of its own in the app: a support inbox with one room per email thread, say. It lists `WEB_APP` in its `requires` and registers from `setup`:

```ts
const app = context.service(WEB_APP);
app.registerRoomKind({ kind: "inbox", label: "Support inbox", list, access, header, send, act, buttons, retention });
app.registerPage({ id: "mailboxes", label: "Mailboxes", place: "settings", visible, view, act });
```

The host-facing types are exported from the package entry: `WEB_APP`, `WebApp`, `HostRoomKind`, `HostPage`, `HostCard`, `Viewer`, `OpenTarget`, `ActionResult`, `LinkProver`, `OnboardingStep` and `Notices`. Keep the `WebApp` object and read `app.rooms`, `.notices`, `.pages`, `.onboarding` and `.push` when you use them: they throw until the web plugin has started, so copying one in `setup` crashes the boot (`registerRoomKind` and `registerPage` work in `setup`). `notices.onAck` can be attached only after start.

A room's key is `<surface>:<kind>.<id>`, with an id of 8 to 64 letters, digits, `-` or `_`. The kind name is lower case and none of `agent`, `group`, `thread` or `home`. Everything is checked when the web service starts.

- **Access is the host's, asked every time.** `access(viewer, id)` answers `{ read, send, act }` for each read, frame, send, card answer, upload and file; `undefined` makes the room, its messages and its files a `404` for that person. `send` is `note` (a message for the room's people), `turn` (a message the room's agent answers), both, or neither; `act` lets them press buttons and run actions. `list(viewer, { filter, cursor })` returns the rooms the person may open, and `undefined` hides the kind. `changed(room)` and `accessChanged(principalId)` on `app.rooms` tell the app a header, a list or a person's access may differ.
- **Who wrote what.** A host posts with `app.rooms.post(room, { author: { kind, name, label?, principalId?, picture? }, text, files?, reference? })`. The author kinds are `external` (someone outside, shown with the host's label such as "Customer"; plain text with links), `member`, `assistant` (an agent partner; Markdown, raw HTML shown as text) and `notice` (a line of the room's own, such as "Assigned to Mel"; Markdown). `reference` is the host's own id, unique per room, and `byReference` finds it again; `edit` and `remove` change a message. An import may give an earlier `at`, kept within retention.
- **Recent messages.** `app.rooms.context(room, { limit?, messageChars? })` gives the room's recent messages as the same block `CHANNEL_CONTEXT.read` gives a turn (`{ messages, text }`): what was said since the assistant last posted, the newest `limit` of it (default 15, at most 100), an outsider's words marked `external`, notices left out; `undefined` when there is nothing, and a room that is not one of a registered kind throws. Use it when a turn starts from a room's `send` hook, where no message addressed the assistant. It marks nothing handed over, so a retry of the turn reads the same messages.
- **Cards.** `app.rooms.card(room, { title, body, tone?, state?, links?, buttons? })` puts a card in the room; `updateCard` replaces it by id. A button calls the kind's `act(viewer, id, { action, card }, input)`; a button may carry a `form` (text, textarea, url, select with `initial` and `search`, multiselect), and its input is checked against the form on the server before `act` runs. `act` answers `{ ok: true, notice?, open?, url? }` or `{ ok: false, error, field? }`; `open` is a room (with a message) or a page (with a query). Buttons show only while the card's `state` is `open`, and `buttons(viewer, id, card)` (sync or async, so it can ask the host's own rights source) may narrow which ones a person sees. A card's `links` are `https` or a path of this origin. Approval and question cards of the room's agent follow the agent's own prompt scope, never `access` or `buttons`.
- **Writing.** Where a viewer may send both a `note` and a `turn`, the room shows one `@AI` toggle over the composer's bar: off sends a note (for the room's people only), on sends a turn (the agent answers). The box's hint follows the toggle, "Write an internal note…" or "Ask AI…" (the box never names the room as a recipient), and a room remembers the way the person last wrote in. A viewer who may send one way only has no toggle and the hint of that way. A kind words it with `sendWording: { note?: { placeholder }, turn?: { label, placeholder } }`; `turn.label` replaces `@AI` on the toggle. Only text is taken: a label is cut to 40 characters and a placeholder to 100, and a value that is not text is dropped. Typing `@AI` as the first word of the box (any case, followed by a space, a colon, a comma or the end of the text) does the same as turning the toggle on: the toggle shows on, and locked, while the box starts with it and returns to the person's own setting when the token is deleted, and the page sends the message as an explicit `mode: "turn"` with that leading token (and the space, colon or comma after it) cut from the text. Only typing counts: `@AI` later in the text, inside an address such as `a@ai.com` or a longer word, in pasted or dropped text, in a restored draft or in a quote is plain text and the message stays as the toggle says. The same holds in an agent or group room that offers the switch for notes. It is the page's shorthand only: the server never reads a message's text for it, so a `note` frame whose text starts with `@AI` stays a note, and only a frame with an explicit `mode: "turn"` from a viewer who may send turns starts one. A room without the toggle takes `@AI` as plain text.
- **Icons.** A page or a kind may give `icon`, one of `HOST_ICONS` (type `HostIconName`, both exported by the package): `chat`, `link`, `activity`, `users`, `megaphone`, `qr`, `settings`, `bell`, `file`, `list`, `shield`, `lock` and `sparkle`. A page's icon shows in the navigation (without one, a list); a kind's shows beside its section in the room list (without one, none). A name outside the list shows the default. The glyphs the first page does not draw load only when a page names one, so the first load does not grow.
- **Links and pictures.** `app.rooms.link(room, messageId?)` gives the same-origin address that opens a room and highlights a message (`<mount>/room/<key>?message=<id>` with `routing: "path"`, `<mount>/#/room/<key>?message=<id>` with hash routing). `![alt](file:<id>)` in a card, a page or an assistant or notice message shows an image the host saved with `saveFile` (rooms) or `app.pages.saveAsset` (pages): PNG, JPEG or WebP whose bytes prove it, served only to those who may see the room or page. Anything else is shown as text.
- **Pages.** A page is at `<mount>/p/<id>` and is built from sections: Markdown, a list of rows (each may open a link and carry buttons), a form with an action, and a card. `place` is `main` (the navigation), `settings` (the Settings pane) or `hidden`. `visible(viewer)` is asked on every fetch and action; a page that is not visible is a `404`. `app.pages.changed(id?)` sends the viewers who may see it a `page_changed` frame and their page fetches the view again.
- **Retention.** A kind's `retention: { textDays, fileDays }` deletes its messages, author names, host cards and files that old, counted from each message's `at` (a card's from when it was first posted). Without it nothing is deleted. A card the host still wants, such as a ticket's pinned card while the ticket is open, carries `keep: true` in `card` and `updateCard`: the sweep skips it for as long as the host passes `keep: true`, and `updateCard` without it makes the card an ordinary one again.
- **Read marks.** The page tells the app how far a person has read (the newest message in view, at most once a second, never while the page is hidden). The app keeps one cursor per person and room, for host rooms and agent rooms alike (among owners), and computes each room's `unread` from it; the list and the drawer show the count, an attention dot where the host sets `attention`, and the room opens with a "new messages" divider where the person stopped. Under each message the people who have read up to it are named: "Seen by 2", with their pictures; a person's own mark is not shown to them.
- **The page is lazy.** The room, the lists and the pages load as separate chunks when first opened, so the app's first load is the same size as before.

## App protocol

The `rooms` pane's page and any client of your own talk to the host in this protocol. A page opens one WebSocket at `<mount>/api/socket` with the subprotocol `roundtable.app.v1`. The upgrade passes the same authenticator as every request and must come from the console's own origin; the socket closes with `4401` when the credential lapses.

- Page to server: `hello {visible, focus?}`, `visibility`, `focus {room?}`, `send {id, room, text, uploads?}`, `stop {room}`, `approval {prompt, approved}`, `answer {prompt, answer}`, `answers {prompt, answers, note?}`, `cancel {prompt}`; for a host room also `subscribe {room}`, `unsubscribe {room}`, `act {id, room, action, card?, input?}` and `read {room, upTo}`.
- Server to page: `ready {protocol, principal, name, uploads: {perMessage, maxBytes}}` (then every open card), `accepted`, `refused {id?, prompt?, code}` (`id` names a refused `send`, `prompt` a refused answer to a card), `message`, `progress` (only for the focused room), `activity {room, typing, stoppable, phase?, agent?, outcome?}` (`phase` is `working` during a tool call and `thinking` otherwise; `agent` names the member speaking in a group round; `outcome` is `done` or `failed` and comes only on the frame where `typing` turns false), `presence {agents: {<name>: {busy}}}` (after `ready` and when it changes; `busy` includes work in Discord channels), `edited` (a stored message changed its text, such as a thread's start line once the thread exists), `prompt`, `prompt_closed {prompt, outcome, note?, by?, answer?, closedAt?}`, `mode`, `auto_approved`, `changed`.
- REST under `<mount>/api/`: `session`, `rooms`, `rooms/<key>/messages?before=&limit=` (`{messages, more, cards}`: the cards of the room that opened within the page's span, from the first message's time on, or from the beginning when `more` is false, and before the first message of the next page), `PUT rooms/<key>/mode`, `PUT rooms/<key>/mute` (body `{muted: boolean}`; the room's push is off for every owner while true; a waiting card still pushes), `PUT rooms/<key>/pin` (body `{pinned: boolean, before?: key | null}`) and `PUT rooms/<key>/folder` (body `{folder: id | null, before?: key | null}`; `before` is the room it goes before, none or an unknown room for the end; `400` for Home and a dispatch thread, `404` for an unknown room or folder), `POST folders` (body `{name}`, `201`), `PATCH folders/<id>` (body `{name?, before?: id | null}`), `DELETE folders/<id>`, `PUT folders/<id>/mute` (body `{muted: boolean}`; answers `{muted, rooms}`), all of which answer with the whole layout `{pins, folders}` (except the mute), and `GET rooms` answering `{rooms, pins, folders}`, `POST rooms/<key>/start-over`, `POST uploads`, `DELETE uploads/<id>`, `files/<id>`, `schedules` (`GET`, and `DELETE schedules/<id>`), `agents/<name>` (`GET`, `PATCH`), `GET agents/<name>/prompt-history` (`{versions}`, newest first), `GET prompts` (`{documents}`), `GET` and `PUT prompts/<id>` (body `{text, base}`; `409 {error, conflict, current}` when `base` is not the text in force), `POST prompts/<id>/revert` (body `{base}`; the same `409`), `GET prompts/<id>/history`, `GET` and `PUT skill-docs/<name>` (body `{text, baseHash}`; `409` with `current`), `POST skill-docs` (body `{text}`; `201`), `GET skill-docs/<name>/history`, `PUT agents/<name>/character` (body `{character}`, at most 4 KiB; `400 {error, field}` for a look that is not a character), `POST agents` (body `{name, displayName, prompt, model?, thinking?, task?, character?, skills?}`; `201` with the profile; `400` for what the agent server refuses, `{error, field}` for a look), `POST agents/<name>/archive`, `POST agents/<name>/restore` (the profile), `DELETE agents/<name>` (an archived agent only; `400` for an active one), `GET` and `PUT agents/<name>/skills` (`{skills: [{name, description?, source, builtin, carried, missing?}]}`; the body of `PUT` is `{add?, remove?}`, one change that an unknown or built-in name refuses whole; `404` when the host has no skills), `POST groups` (body `{name, displayName, members, host?}`; `201`), `GET`, `PATCH` (`{displayName?, members?, host?}`) and `DELETE groups/<name>`, `POST groups/<name>/archive` and `POST groups/<name>/restore`, `GET archive` (`{entries}`: the archived agents and groups), `models`, `workspace` (the [files pane](#the-files-pane)'s calls), and for push `GET push/key`, `GET`, `POST` and `DELETE push/subscriptions` and `DELETE push/subscriptions/<id>`. The agents' pictures are at `<mount>/avatars/<hash>.png`.
- Beside the API: `<mount>/manifest.webmanifest`, `<mount>/sw.js`, `<mount>/icons/<name>.png` (and `mark.svg`), `<mount>/theme-init.js`, and in password mode `<mount>/login`, `POST <mount>/auth/login` and `POST <mount>/auth/logout`.

A room key from a page must be one of the app's rooms whose agent or group exists; every other key, Discord's included, is refused. Every write needs an owner, whose tier is read again, and REST writes also need the console's `Origin`. A card can be answered by any owner, except a card that is the speaker's alone, which only the speaker's principal answers. After `cardGraceSeconds` (default 120) a turn goes on without the answer and the card stays open for a day; an answer then starts a new turn in the room. The types are in `src/api-types.ts`.

## Screenshots

The images of the app are not in the repository yet; they come from the visual check of a release.
Each slot is a PNG in `docs/images/web/`, named `<look>-<scheme>-<device>.png`, taken on the fixture host (`bun run fixture:app`) at 390 × 844 for a phone and 1280 × 800 for a desktop:

| File | Look | Scheme | Device |
|---|---|---|---|
| `docs/images/web/modern-light-phone.png` | Modern | light | phone |
| `docs/images/web/modern-light-desktop.png` | Modern | light | desktop |
| `docs/images/web/modern-dark-phone.png` | Modern | dark | phone |
| `docs/images/web/modern-dark-desktop.png` | Modern | dark | desktop |
| `docs/images/web/camelot-light-phone.png` | Camelot | light | phone |
| `docs/images/web/camelot-light-desktop.png` | Camelot | light | desktop |
| `docs/images/web/camelot-dark-phone.png` | Camelot | dark | phone |
| `docs/images/web/camelot-dark-desktop.png` | Camelot | dark | desktop |

Each shows a room with an approval card open and a character at work, with the round table beside it on the desktop shots.
Until the files exist, this list is the only reference to them: nothing embeds an image.

## Development

This package lives in `packages/web` in the pi-roundtable workspace.
Install at the repository root, then run the package scripts:

```sh
bun install --frozen-lockfile
bun run --cwd packages/web build       # builds the page into dist/
bun run --cwd packages/web typecheck   # the server and the page
bun run --cwd packages/web lint
bun run --cwd packages/web test
bun run --cwd packages/web fixture     # a local host with fixture data (the console panes)
bun run --cwd packages/web fixture:app # a host with scripted agents, to try the owner app
```

`bun run fixture` starts the plugin on pi-roundtable's test harness over fixture conversations on port 4173, behind a stand-in for the authenticating proxy that signs a test Access token, and the same listener without it on port 4174, which must answer 403. `FIXTURE_AUTH=cloudflare|none|password` picks the mode it runs in, and it serves the Overview, Conversations and Notes panes only.
`/fixture/message` appends a message to the owner's conversation and `/fixture/work` toggles the agent between working and idle, so the live updates can be watched.
The fixture host has two owners, so the Notes pane shows its principal picker.

`bun run fixture:app` starts the owner app over a scratch PostgreSQL database (`ROUNDTABLE_TEST_DATABASE_URL`, whose server may create a database; the fixture makes one and drops it when it stops) with two scripted agents and a group, no Discord, and no authentication on a loopback port (4180).
Start a message with a keyword and the agent acts it out: `approve` (a held action with details), `ask`, `quiz` (a questionnaire), `timeout` (the time-limit card), `late` (a card the turn stops waiting on), `stream` (streamed text and tool chips), `dispatch` (a coding job in a thread) or `exchange` (the agent asks the scout in a thread).
`LOOK=camelot` starts the host in the Camelot look, and `FIXTURE_AGENTS` seats up to twelve agents at the round table.
The header of `scripts/fixture-app.ts` lists the control port that sends a message as the owner and sets a room's modes.

The page is React, bundled with Bun's bundler into relative URLs, so it works under any `mountPath`.
Pages use URL fragments by default (`#/notes`, `#/conversations/<key>`); `routing: "path"` uses mount-relative page paths instead.

The package shares the core's version and single `v*` release tag.
The shared `publish.yml` checks every workspace, then publishes each separately with provenance; this package's `prepack` builds the page.

[roundtable]: https://www.npmjs.com/package/pi-roundtable
[mcp]: https://www.npmjs.com/package/pi-roundtable-mcp
