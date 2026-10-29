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
- **Looks.** Agents are drawn as characters; the page has a Modern and a Camelot look, light and dark, and a round table that seats the whole team.

Who may enter is the host's `access` configuration plus an authentication mode you choose: `none`, `password` or `verifier` (see [Authentication](#authentication)), and the plugin refuses to start without one.
Then only a person whose principal holds the owner role gets in.

## Contents

- [Requirements](#requirements) and [Install](#install)
- [The owner app](#the-owner-app): rooms, cards, [modes](#modes-yolo-and-long-running), [dispatch threads](#dispatch-threads), [uploads](#uploads), [characters](#characters-in-the-page), [the Camelot look](#the-camelot-look), [the round table](#the-round-table)
- [Install on a device](#install-on-a-device) and [Notifications](#notifications)
- [Authentication](#authentication) and the [threat model](#threat-model)
- [Options](#options), [the console's panes](#the-consoles-panes) and [host feature ports](#host-feature-ports)
- [App protocol](#app-protocol), [Screenshots](#screenshots) and [Development](#development)

## Requirements

- Bun 1.4.4 or later, and pi-roundtable `>=0.23.0 <0.24.0` as a peer dependency.
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
| **Rooms** | Home first, then agents, groups and dispatch threads, with badges for working, a card waiting, yolo and long-running. |
| **A room** | Each message with its author's picture and name, Markdown (raw HTML is shown as text), files, and a live progress strip with the streamed text and tool chips. A sticky composer with upload and Stop. The header menu holds the mode switches, Profile and Start over. |
| **Cards** | Inline in the room: an approval with the call's details and a copy button; a question with options, an "Other" field and Cancel; a questionnaire; and the card at a turn's time limit. Answered cards show the answer given. |
| **Agent profile** | Display name, prompt, model and thinking level, and the character creator (see [Characters in the page](#characters-in-the-page)). |
| **Schedules** | Every schedule of the team, labelled by room or channel, with a confirmed cancel. |
| **Table** | The round table (see [The round table](#the-round-table)). |
| **Settings** | Color scheme and look, install, notifications for this device, and Log out (password mode). |

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

### Uploads

An owner may send a file of any kind in a room, up to four to a message: the button, a paste (a copied image, say) or a drop. `POST <mount>/api/uploads` takes one file as `multipart/form-data` (field `file`) and answers `{id, name, type, size}`; the message then names it in `uploads`. A long text goes as a file too: the page turns a paste of 4,000 characters or more into a `pasted-text-<n>.txt` chip, and a message over 32,000 characters into `message.txt` with the line "(long text attached)"; the server still refuses a text over 32,000 characters.

- **Streamed, not buffered.** The body is read as a stream and written to disk as it arrives, so a large file costs disk, not memory. Only the first bytes are kept to tell what the file is. A file over `uploadMaxBytes` is refused with `413` (before it is read when the length says so, as it passes the limit otherwise), and nothing is left on disk.
- **Any type.** Images are checked by their first bytes (a file that says it is a PNG but is not one is refused with `415`); a file that is valid UTF-8 without NUL bytes is kept as text (`text/markdown`, `text/csv` or `application/json` by its name, else `text/plain`); a PDF by its first bytes keeps `application/pdf`; everything else is kept as `application/octet-stream` under the name it came with. What the browser said the type was (often empty, or `video/mp2t` for a `.ts` file) does not decide.
- **Bounded.** A person may have 16 files and 400 MiB waiting for a message, counting uploads on their way (`429` beyond that); a waiting file is deleted after a day, a sent one after 30. The page deletes a chip's upload when it is removed or its send fails (`DELETE <mount>/api/uploads/<id>`, the owner's own waiting uploads only), and a body that is cut short leaves no file behind.
- **Served safely.** A stored file is a download, never a page (`content-disposition: attachment`, `content-security-policy: sandbox`, `nosniff`); only the four image types are shown inline.
- **What the agent gets.** The turn's message names each file, and the host saves it for the agent's tools: the app hands the host the stored file's path, so a large file is copied from disk, never held in memory. The agent takes a file up to `uploadMaxBytes` (the surface's `maxAttachmentBytes`), not the 25 MiB a Discord attachment is held to. Images (four at most) are also shown to the model, and a text or PDF file can be read by the agent. A file over 25 MiB is kept as a file for tools: it is not shown to the model and `read_attachment` refuses it, and the turn's attachment list marks it "too large for read_attachment; kept as a file for tools", which a tool that takes files opens as it is.
- **Limits in front of the app.** The upload route asks the host's listener for a request body of `uploadMaxBytes` plus 64 KiB of form framing, so a larger `uploadMaxBytes` raises the listener's limit past its 128 MiB default (a listener the host fixed with its own `maxRequestBodyBytes` decides instead, and refuses a larger body with `413`). A reverse proxy has its own limit; Cloudflare's free plan caps request bodies at 100 MB, so a larger file needs a paid plan or an upload path that skips the proxy.

### Characters in the page

Every agent is drawn as its composed character (`pi-roundtable/characters`). The page draws it from the spec the server sends, after a strict `parseCharacter` check: a spec that does not parse is logged and replaced by the look the agent's name suggests. The drawing is `composeSvg`'s output, the only markup the page injects, and it holds no inline style, so the content security policy is unchanged. The composer is a chunk of its own (about 19 KB gzipped) that starts loading with the page and is cached by the service worker.

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

The `table` pane seats every active agent at a round table, the coordinator first, in every look. Each seat shows the agent's character in the shield frame and takes its accent color; a seat's state comes from the same rules as the room list (`sleepy` sits as `idle`), and the member a group round names as `agent` is lit as `speaking`. A change of state moves the seat at once; a change of face redraws that one picture once it has stood for 300 ms. A click, or Enter on a focused seat, opens the agent's room. The drawing is a WebGL scene where the browser has one and an SVG table otherwise (or after a lost context); the scene is a chunk of its own, fetched when the view first opens and cached by the service worker, never precached. It stops drawing when nothing moves, when the tab is hidden and when it is off screen, and under `prefers-reduced-motion` it is one still frame.

- **Names.** A seat's name is drawn in front of the table and of every badge, never under them, and is cut with an ellipsis only when it is longer than its plate; the seat's full name is its accessible name. A name is at least 11 px on the screen: the plates grow with the canvas' scale, as far as their neighbours leave room, and where even that is not enough (twelve seats on a phone, a narrow panel with many members) the plates carry only their color bar and the seats are listed as buttons under the table. The 2D table draws its names at 11 px or more and keeps its ring inside its box. Plates of nearer seats are drawn over those of farther ones, and the seat across the table stands a little higher so the table's far edge does not cut its head.
- **Phones.** On a phone held upright the canvas is as tall as it is wide plus a tenth; with more than ten seats, or when the names cannot be read at 11 px, the agents are also listed as buttons under it.
- **`?nogl`.** Adding `nogl` to the page address (`/console/?nogl`, or `#/table?nogl`) draws the SVG table on a browser that has WebGL, to try that path; `nogl=0` and `nogl=false` leave the choice to the browser. The camera starts high enough for the ring to fill the canvas and pinch zooms; "Reset view" brings it back.
- **Group rooms.** A group room's header has a "Table" button that opens the table of its members only, in a sheet on a phone and in a panel beside the room elsewhere. Under the Camelot look a compact strip of the members also stands under the header with the speaker lit; under Modern it stays collapsed.

## Install on a device

The app is a progressive web app, installable on a phone, tablet or desktop and opened in its own window.

- `<mount>/manifest.webmanifest` is generated for the mount: its `id`, `start_url` and `scope` are all `<mount>/`, `display` is `standalone`, the name is `title`, and the theme and splash colors follow `appearance.look`. The page links it with `crossorigin="use-credentials"`, so a proxy such as Cloudflare Access that sets a cookie sees it.
- `<mount>/sw.js` is the service worker, served `no-cache` and scoped to the mount. It precaches the page's hashed assets and `index.html`, serves assets cache-first and navigations network-first with the cached shell as the offline fallback. It never touches `api/`, `auth/`, `login`, `files/` or `avatars/`, and returns a redirect (a proxy's login) as it came. It caches the shell only, never data, so a shared device keeps nothing after you log out. The round table's 3D scene is fetched the first time that view opens and is not precached.
- `<mount>/icons/` serves `192.png`, `512.png`, `maskable-512.png`, `apple-180.png` and `badge-96.png`. The package ships a set; `icons.dir` replaces it with a directory that has the same five names.

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

With `push.preview` on (the default) a notification shows the first 120 characters of the message; with `push.preview: false` it says only that something waits and where.
Tapping a notification focuses the app or opens it at the room.

Setup:

- **`push.subject`** is the contact a push service may use about this server (the VAPID `sub`): a `mailto:` address or an `https:` URL. It defaults to `origin` when that is `https`; with an `http` origin, push stays off, the host logs a warning, and a device cannot subscribe, until you set it.
- **Keys.** The server makes a VAPID key pair (P-256, with WebCrypto) at its first start and keeps it in `<dataDir>/web/vapid.json`, readable by its user alone. Subscriptions are bound to the public key, so keep the file across restarts and deploys; a file that cannot be read stops the start, and deleting it means every device must subscribe again.
- **Push services.** A subscription's endpoint must be `https`, with no port or credentials, and on an allowed host: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com` and `*.notify.windows.com`. `push.endpointHosts` adds hosts for another browser's service; a leading `*.` allows every subdomain. Any other endpoint is refused with `400`, so an owner's session cannot make the host post to an address of its choosing.
- **Delivery.** The payload is encrypted for the device (RFC 8291, `aes128gcm`) and signed with a VAPID token (RFC 8292, ES256 with `jose`); there is no push dependency. A `404` or `410` from the service removes the subscription, as do five failures in a row. A person has at most 20 devices.
- **Who gets it.** Only a device of a person who is still an owner, and only while no open page of that owner reports itself visible.

## Authentication

The app never makes an account.
One authenticator checks every request under its path before anything is read, whether it is a page, the API, the event stream or the WebSocket upgrade of the owner app.
You choose how with the `auth` option; the console then looks the person up in the host's `IDENTITY`, reading only, and admits them only when their principal holds the owner role.

| `auth` | Who is the owner | Use it when |
|---|---|---|
| `{ mode: "verifier", verifier }`, or the `verifier` option as shorthand | The person the verifier reports, linked to an owner's principal. | A proxy such as Cloudflare Access authenticates people in front of the listener. This is the one mode whose proof an agent on the host cannot forge. |
| `{ mode: "password" }` | The primary owner, once they give the password. | The console is reachable from the internet with no proxy that signs people in. |
| `{ mode: "none" }` | The primary owner, whoever reaches the listener. | Only the owner can reach the listener: a unix socket, or loopback TCP. |

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
The app serves that to the host's owners and nobody else, and since 0.23 it also acts for them: a signed-in session can run turns, approve held actions, switch yolo mode on, send files and change an agent's prompt and model.
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
| `auth` | none, `auth` or `verifier` required | How requests are authenticated: `{ mode: "none" }`, `{ mode: "password" }` or `{ mode: "verifier", verifier }`; its keys are in the next table, and [Authentication](#authentication) explains the modes. |
| `verifier` | none | Shorthand for `auth: { mode: "verifier", verifier }`: decides whether a request comes from someone your proxy authenticated, and reports who. `cloudflareAccess(...)` is built in; pass your own function to use another proxy. Giving both `auth` and `verifier` throws. |
| `origin` | none, required | The app's own origin as the browser sees it, such as `https://app.example.com`: scheme and host (and port), no path. Requests that change data must carry it as their `Origin`, the dashboard line links to it, and push derives its default contact from it. |
| `ownerId` | the primary owner | Deprecated. The owner's principal id that a request from a verifier reporting no actor stands for. The Notes pane no longer needs it: it shows each owner their own notes. |
| `dataDir` | `./data` | The host's data directory; the console reads `<dataDir>/sessions`, and the app keeps `web/` (the session key, the VAPID keys, uploaded and reply files) under it. Set it to the `dataDir` of your configuration. |
| `mountPath` | `/console` | The path the app is served under: one or more segments of letters, digits, `.`, `_`, `~`, and `-`. |
| `listener` | `public` | The id of the listener whose address serves the app. |
| `routing` | `hash` | `path` retains links such as `/console/skills`, with history navigation and an authenticated page fallback. |
| `panes` | `rooms`, `table`, `overview`, `schedules`, `conversations`, `notes` | Ordered subset of those panes plus `skills` and `connectors`. `schedules` and `table` need `rooms`. Disabled panes answer 404. `skills` and `connectors` require their feature ports at setup. An explicit list is kept as written, so a host that listed its panes before 0.23 adds `rooms`, `table` and `schedules` by hand. |
| `surface` | `app` | The key prefix of the app's rooms, a lower-case word that is not `discord`. Rooms keep their conversations under it, so changing it starts every room over. |
| `cardGraceSeconds` | `120` | How long a turn waits on an approval or question card before it goes on without the answer, above 0 and at most 3600. The card stays open for a day. |
| `uploadMaxBytes` | `104857600` (100 MiB) | The most bytes of one file a person may upload, from 1 to 4 GiB; the agent takes files up to it too. It raises the listener's request body limit. See [Uploads](#uploads). |
| `push` | on, with an `https` origin | Web Push; its keys are in the table below, and [Notifications](#notifications) describes the whole. |
| `icons` | the package's own | `{ dir }`: a directory of the five install icons, see [Install on a device](#install-on-a-device). |
| `appearance` | `{ look: "modern" }` | `{ look }`: `modern` or `camelot`. The page's default look and the manifest's splash colors; the owner can switch it in the app. |
| `title` | `Roundtable` | The page's heading, title and the installed app's name. |
| `presentation` | English | `{ locale, messages }`: locale controls dates and document language, and `zh-TW` also selects the [built-in Traditional Chinese wording](#presentation-and-built-in-zh-tw); English source strings are dictionary keys for labels, descriptions, confirmations, and API errors. |
| `features` | none | Trusted host integrations, or a factory receiving public plugin setup context; see [Host feature ports](#host-feature-ports). |
| `relayNotes` | the remote MCP note | Text that an outside agent's relayed message begins with, taken off before the owner's words are shown. Set it to the same value as the `relayNote` of [pi-roundtable-mcp][mcp] when you changed that one. |
| `exclude` | none | A function from a channel key to `true` for conversations the console must neither list nor read, such as the channels of another plugin that keeps its own sessions in the same directory. |
| `assetDir` | the package's `dist/` | The built page's directory. Set it only in tests. |

The `auth` keys:

| Key | Default | What it does |
|---|---|---|
| `auth.mode` | none, required | `none`, `password` or `verifier`. |
| `auth.trustNetwork` | `false` | `none` only: allows a TCP listener that reaches beyond this machine, when a network in front of it keeps everyone else out. |
| `auth.passwordEnv` | `ROUNDTABLE_WEB_PASSWORD` | `password` only: the environment variable that holds the password, which must be set and at least 12 characters. |
| `auth.sessionDays` | `30` | `password` only: how long a login lasts, 1 to 365 days. |
| `auth.principal` | the primary owner | `none` and `password`: the owner's principal id the session speaks for. |
| `auth.verifier` | none | `verifier` only: the request verifier, as the `verifier` option. |

The `push` keys:

| Key | Default | What it does |
|---|---|---|
| `push.preview` | `true` | Whether a notification shows the first 120 characters of the message. With `false` it says only that something waits, and where. |
| `push.quietHours` | `{ start: "23:00", end: "08:00" }` | The hours when an agent's post and a notice are not pushed, as two different `HH:MM` times on the console's time zone; an `end` before the `start` crosses midnight. Cards are always pushed. `false` turns quiet hours off. |
| `push.endpointHosts` | none | Push services to post to besides the browsers' own (Google, Mozilla, Apple, Microsoft), as host names; a leading `*.` allows every subdomain. Endpoints must still be `https`. |
| `push.subject` | `origin`, when it is `https` | The contact a push service may use about this server (the VAPID `sub`): a `mailto:` or `https:` URL. With an `http` origin push stays off until it is set. |

The bad settings that stop the host at startup are: no `auth` or `verifier`, both of them, an unknown `auth.mode`, a password shorter than 12 characters, `none` on a listener that reaches beyond the machine, an `origin` with a path, a `mountPath` of `/` or with `..` in it, an unknown or repeated pane, `schedules` or `table` without `rooms`, a `surface` that is not a lower-case word or is `discord`, an empty `ownerId`, a `uploadMaxBytes` out of range, and a `push.subject` that is neither a `mailto:` address nor an `https:` URL, and a `push.quietHours` that is neither `false` nor two different `HH:MM` times.

The plugin needs, for the panes you serve: the agent server (`AGENTS`) for Overview and Rooms, the modes service (`MODES`) for Rooms, the schedule store (`SCHEDULES`) for Schedules, and the memory addon for Notes.
The host refuses to start with a message naming the missing service when one of them is absent.

## The console's panes

The page has eight panes; `panes` chooses which ones a host serves.
Rooms and Schedules belong to the [owner app](#the-owner-app), and the Round table to [its own section](#the-round-table); the rest are the console that came first, which reads what the host already stores: the conversation files under the data directory, the memory addon, and the agent team.

| Pane | What it shows |
|---|---|
| Rooms | The owner app: Home, agent and group rooms and dispatch threads (see [The owner app](#the-owner-app)). |
| Schedules | Every schedule of the team, labelled by room or channel, with cancel (needs `rooms`). |
| Overview | Every active agent with its model, thinking level, state (working where, waiting, or idle), context use, schedule count, and last activity; every group with its members, host, and busy count. An agent links to its Discord channel and its transcript, and a group to its Discord channel. |
| Conversations | Every conversation stored on disk, in four sections: owner channels (direct messages and channels where the owner talks to the assistant), agent channels, group conversations (each member's conversation inside a group), and outside-agent conversations opened over MCP. Each row shows the channel's name (when the host has a Discord connection), when it was last active, its size, and how many archives it has. An outside-agent conversation shows its first message, when it appears in the first 256 KB of the file, and when it began. A conversation the host's registry records also shows whose it is, by their display name, and whether it is private to them or shared. Every owner sees every conversation. |
| Notes | A principal's memory in three tabs, core, notes, and events, with search: the signed-in owner's own by default, and any principal's the host knows through a picker that appears when there is more than one. The owner can add a note, edit its text, kind, and date, and delete it after a confirmation, in whichever memory is shown. The memory addon's own validation applies, so a refusal shows its reason and saves nothing. |
| Skills | The full host catalog, source, groups and carriers; each available skill opens its ordered frontmatter and Markdown body. |
| Connectors | Upstream gateway enabled/reachable/tool status, virtual-server tool lists, and the agents or profiles that use them; an optional administration link. |
| Round table | Every active agent seated at one round table, the coordinator first, each in the state its room is in; a seat opens that agent's room (see [The round table](#the-round-table)). Needs `rooms`. |

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

## App protocol

The `rooms` pane's page and any client of your own talk to the host in this protocol. A page opens one WebSocket at `<mount>/api/socket` with the subprotocol `roundtable.app.v1`. The upgrade passes the same authenticator as every request and must come from the console's own origin; the socket closes with `4401` when the credential lapses.

- Page to server: `hello {visible, focus?}`, `visibility`, `focus {room?}`, `send {id, room, text, uploads?}`, `stop {room}`, `approval {prompt, approved}`, `answer {prompt, answer}`, `answers {prompt, answers, note?}`, `cancel {prompt}`.
- Server to page: `ready {protocol, principal, name, uploads: {perMessage, maxBytes}}` (then every open card), `accepted`, `refused {id?, prompt?, code}` (`id` names a refused `send`, `prompt` a refused answer to a card), `message`, `progress` (only for the focused room), `activity {room, typing, stoppable, phase?, agent?, outcome?}` (`phase` is `working` during a tool call and `thinking` otherwise; `agent` names the member speaking in a group round; `outcome` is `done` or `failed` and comes only on the frame where `typing` turns false), `presence {agents: {<name>: {busy}}}` (after `ready` and when it changes; `busy` includes work in Discord channels), `edited` (a stored message changed its text, such as a thread's start line once the thread exists), `prompt`, `prompt_closed {prompt, outcome, note?, by?, answer?, closedAt?}`, `mode`, `auto_approved`, `changed`.
- REST under `<mount>/api/`: `session`, `rooms`, `rooms/<key>/messages?before=&limit=` (`{messages, more, cards}`: the cards of the room that opened within the page's span, from the first message's time on, or from the beginning when `more` is false, and before the first message of the next page), `PUT rooms/<key>/mode`, `POST rooms/<key>/start-over`, `POST uploads`, `DELETE uploads/<id>`, `files/<id>`, `schedules` (`GET`, and `DELETE schedules/<id>`), `agents/<name>` (`GET`, `PATCH`), `PUT agents/<name>/character` (body `{character}`, at most 4 KiB; `400 {error, field}` for a look that is not a character), `models`, and for push `GET push/key`, `GET`, `POST` and `DELETE push/subscriptions` and `DELETE push/subscriptions/<id>`. The agents' pictures are at `<mount>/avatars/<hash>.png`.
- Beside the API: `<mount>/manifest.webmanifest`, `<mount>/sw.js`, `<mount>/icons/<name>.png`, `<mount>/theme-init.js`, and in password mode `<mount>/login`, `POST <mount>/auth/login` and `POST <mount>/auth/logout`.

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
