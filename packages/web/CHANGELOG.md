# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Characters in the page (`rooms` pane). Agents are drawn as their composed characters on the room list, in the room's header, in messages, in the room switcher and on the profile, in place of the drawn pictures. Each character moves with its state (`thinking`, `working`, `waiting` while a card is open, `done`, `error`, `sleepy`), which the page works out from `activity`, `presence` and the cards, and stands still under reduced motion; an agent's accent color (`--agent-accent`) colors its row, header, progress strip and composer focus ring. The profile gains a creator: a live preview that cycles the states, the 24 classes, eight palettes and custom colors, strips for the parts, "Suggest from role", "Randomize", and Save through `PUT api/agents/<name>/character` with a refused field shown under its strip. Settings picks the Modern or Camelot look per device, and `ConfigView.look` goes on the page as `data-look`. The page checks every spec with `parseCharacter` before it draws one and injects only `composeSvg`'s output. The character kit loads as a chunk of its own, so the first load grows by under 4 KB gzipped. `RoomState` gains `phase`, `agent`, `outcome` and `presence`, and the labels are the message keys `character.class.<id>`, `character.<kind>.<id>` and `character.palette.<name>`. See the README's "Characters in the page".
- The Camelot look (`rooms` pane). Under `appearance.look: "camelot"`, or a device's pick in Settings, the page takes parchment and night-castle colors with gold, serif headings from the system fonts, gold rules and header corners, the shield frame on characters, a wax seal in the agent's accent on an approved approval card (stamped in 450 ms, kept on the closed card), and a candle and rune strip on the progress strip. The `theme-color` tags and the pre-paint `theme-init.js` follow the look and the scheme, and the script puts `data-look` on the page before the first paint. Settings shows each look as a swatch with a line about it. Everything is CSS and transform or opacity animation, static under reduced motion, with no new font or image. `PAGE_COLORS` (`src/page-colors.ts`) holds the toolbar colors, `themeInitScript(look)` and `presentPage`'s fourth argument carry the look, and `bun run fixture:app` takes `LOOK=camelot`. See the README's "The Camelot look".
- Characters on the server (`rooms` pane). An agent room's `RoomView.character` and `AgentProfileView.character` carry its composed character, and `PUT api/agents/<name>/character` changes it (owner only, at most 4 KiB; `400 {error, field}` for a look that is not a character). `activity` frames gain `phase`, `agent` and `outcome`, a `presence` frame says which agents are busy, even in Discord, and `appearance: { look: "modern" | "camelot" }` sets the default look and the manifest colors (`ConfigView.look`).

- Web Push for the owner app (`rooms` pane). An owner turns it on per device in Settings, where every device is listed and can be removed; logging out unsubscribes the device. The server pushes only when no page of that owner is in view: when a card opens in an app room ("Card waiting", or "Long-running cap reached" for a time-limit card in a long-running room), when an agent posts in a room that no message from a page started (a schedule's or report's reply, or a late one), and for a `notify` notice, through a new `DirectChannelProvider` named `web:<surface>` (`deliver` writes the notice in the Home room and pushes it, `mirror` only pushes when another channel such as Discord delivered). The payload is sealed for the device with RFC 8291 `aes128gcm` and posted with an RFC 8292 VAPID token, using WebCrypto and the existing `jose`, with no new dependency; it carries a title, the room key and, unless `push.preview` is `false`, the first 120 characters. The VAPID key is made on first start in `<dataDir>/web/vapid.json` (0600) and a file that cannot be read stops startup. A subscription's endpoint must be `https` on a known push service (Google, Mozilla, Apple, Microsoft, or `push.endpointHosts`), or the request answers 400; a 404 or 410, or five failures in a row, drops the device. New routes `GET api/push/key`, `GET/POST/DELETE api/push/subscriptions` and `DELETE api/push/subscriptions/<id>`, table `web_push_subscriptions`, option `push`, and the service worker's `push` and `notificationclick` handlers. `SessionView.push`, `PushKeyView`, `PushDevicesView` and `PushDeviceView` are new.
- The `auth` option: `{ mode: "none" }`, `{ mode: "password" }` or `{ mode: "verifier", verifier }`. The `verifier` option stays as shorthand for the last, giving both throws, and giving neither still refuses to start. One authenticator now checks every request, page, API and event stream, in place of the server's own admission step, and the owner app's WebSocket upgrade will use it too.
  - `none` must be written out. It serves only on a unix socket or TCP on `127.0.0.1`, `::1` or `localhost`, unless `trustNetwork: true`; it warns at every start, and speaks for the primary owner (or `principal`) through the plugin identity `token:web-console`.
  - `password` reads a secret of at least 12 characters from the environment (`ROUNDTABLE_WEB_PASSWORD` by default), serves a login page with no script, and sets a signed `HttpOnly`, `SameSite=Strict` cookie (`Secure` over https) keyed from `<dataDir>/web/session.key` and the password, so a new password signs everyone out. A failed login waits one second, ten failures in 15 minutes lock every login with `429` and `Retry-After`, and `POST <mount>/auth/logout` clears the session.
- `Verdict.admitted.expiresAt`: when a verifier's assertion lapses. `cloudflareAccess` fills it from the token's `exp`, and `admitAs(actor, expiresAt?)` takes it.
- The README's Authentication section describes the modes, and its threat model says what `none` and `password` do not resist: an agent whose shell runs as the same user.
- The owner app's server (`rooms` pane, on by default): the same agent team as on Discord, in rooms of its own, one per active agent and group, with Home the coordinator's. `surface` (default `app`) is the rooms' key prefix and `cardGraceSeconds` (default 120) how long a turn waits on a card. A WebSocket at `<mount>/api/socket` (subprotocol `roundtable.app.v1`) carries messages, Stop, cards (approval, question, questionnaire, time limit), progress, typing, modes and yolo approvals to every open page of every owner; its upgrade passes the console's authenticator and the console's origin, closes with 4401 when the credential lapses, and every frame that changes something reads the owner's tier again. REST under `api/`: `session`, `rooms`, `rooms/<key>/messages`, `rooms/<key>/mode`, `rooms/<key>/start-over`, `uploads`, `files/<id>`, `schedules`, `agents/<name>`, `agents/<name>/avatar`, `models`, and `avatars/<hash>.png`. Messages are kept in `web_room_messages`, uploads (png, jpeg, webp, gif, json, txt, pdf; 10 MiB; four a message) and reply files under `<dataDir>/web/`, and files are served as downloads with `content-security-policy: sandbox` and `nosniff`. A room key a client names must be one of the app's rooms whose agent or group exists. `PANES` gains `rooms` and `schedules`; `ConfigView.app` tells the page the surface. See the README's "App protocol".
- The owner app's page (`rooms` pane), mobile first: a bottom tab bar under 720 px and a side rail above, with the older panes under "More" on a phone. **Rooms** lists Home (the coordinator's room) first, then agents, groups and dispatch threads, with badges for working, cards waiting, yolo and long-running. A **room** shows each message with its author's picture and name, Markdown with raw HTML left as text, files, a live progress strip (streamed text, tool chips, Stop), and inline cards: approvals with their details and a copy button, questions with options, Other and Cancel, questionnaires, a turn's time-limit card in its own `wording`, and late cards. The composer sticks above the keyboard, takes files (button, paste or drop) and shows Stop while a turn runs. The room's menu turns yolo mode on (after a confirmation that says what it approves) and off, turns long-running mode on and off, starts over (after a confirmation) and opens the agent's **profile** (name, prompt, model, thinking, redraw the picture); a banner stays at the top of a room while a mode is on, and yolo approvals appear in the conversation. **Schedules** lists and cancels; **Settings** has the color scheme, an install hint or button, and Log out under `password` auth (`SessionView.auth` tells the page the mode). Ctrl or ⌘ + K switches rooms. Every string is an English key for `presentation.messages`.
- Dispatch threads on the owner app: the app's surface implements the core's `SurfaceThreads`. A coding or background dispatch, or a `message_agent` between rooms, started in a room opens its thread there: one start line in the room, edited to link the thread once it exists (the new `edited` frame), then the dispatch's posts, its cards and its report in the thread's room, where agents speak under their own names and a coding worker's progress is edited in place. A thread's room is read only (`send` is refused with `read_only`) but its cards are answered there. Closing marks the thread closed and keeps it readable; after a restart the host closes the threads the last run left open, with a restart notice. The room list nests each thread under its room with the finished ones folded away (`RoomView.closed`; the list keeps the 30 newest), the start line links the thread's room, and a room list that does not know a thread yet is fetched again before the page says the room is missing. `RoomLog.edit` and `WebThreads.list` are new; `WebThreads.listOpen` is gone.
- Light and dark color schemes, from one token file (`web/tokens.css`): the page follows the system until the person picks one in Settings or with the header button, which is kept in `localStorage` and applied before the first paint; the switch grows as a circle from the button where the browser has view transitions. Motion is limited to `transform` and `opacity` and stops under `prefers-reduced-motion`.
- `bun run fixture:app`: a host over a scratch PostgreSQL database with scripted agents (`approve`, `ask`, `quiz`, `timeout`, `late`, `stream`, `dispatch`, `exchange`) for trying the app in a browser.

- Above 1024 px the room list stands beside the open room, with the open one marked. A failed update of the page (code that a release replaced while it was open) reloads once by itself and otherwise shows a card with Reload; any other failure shows the same card instead of a blank page. A message that cannot go says "Not sent" with Try again and Discard, a lost connection shows a banner under the room's header, and answered cards show the answer given.
- `ServerFrame` `refused` carries `prompt` when the refused frame answered a card, and `PromptFrame` carries `at` (when the card opened), which places a card sent again after a reload among the messages by time.

- Files of any kind, 100 MiB each (the `uploadMaxBytes` option), streamed to disk as they arrive instead of held whole. An image is checked by its first bytes, a UTF-8 text is kept as text (`text/markdown`, `text/csv`, `application/json` or `text/plain`), and anything else as `application/octet-stream` with its own name; the type the browser reported no longer decides, and `ready.uploads.types` is gone. A person may have 16 files and 400 MiB waiting, and a file over the limit is refused with 413 before it is read when its length says so. Stored files are streamed back, not read whole. See the README's "Uploads".
- A paste of 4,000 characters or more becomes a `pasted-text-<n>.txt` chip (with its size and first line; a click puts it back in the box when it fits), and a message over 32,000 characters is sent as `message.txt` with the line "(long text attached)". A full set of file slots says so instead of dropping the file.

### Changed

- The agent reads an upload up to `uploadMaxBytes`, not 25 MiB: the app's surface declares `maxAttachmentBytes` as that limit, and `readAttachment` answers `{ path }` of the stored file instead of its bytes, so the host copies a large file from disk without holding it. A file over 25 MiB reaches the turn as a file for tools (not shown to the model, not read by `read_attachment`). The upload route asks the listener for `uploadMaxBytes` plus the form's framing (`maxRequestBodyBytes`), so `uploadMaxBytes` is no longer capped at 120 MiB; any whole number of bytes the listener can be asked for is accepted. `ConsoleServer.routes` takes that limit as its second argument, and `Uploads.read` answers an `AttachmentFile`.
- The theme colour follows the page's scheme (a `<meta name="theme-color">` for each, and `<script src="theme-init.js">` in the head applies a stored scheme before the first paint, as a file because the page's policy allows scripts from itself only); the manifest's colours are the light page's. Buttons, inputs and switches are at least 44 px high on a phone or with a coarse pointer, and control borders and the off switch meet 3:1 contrast. The progress strip has no Stop of its own (the composer's replaces Send while a turn runs), and a time-limit card without its own wording says "Stop turn".
- The default `panes` are `rooms`, `overview`, `schedules`, `conversations`, `notes`. An explicit list is kept as written; `schedules` needs `rooms`.
- The fixture host (`bun run fixture`) takes `FIXTURE_AUTH=cloudflare|none|password`, and serves the `overview`, `conversations` and `notes` panes only.

### Fixed

- Opening or reloading a room in place (a link, a notification, an installed page restoring its route) showed a blank page: the page's connection opened after the first render that asked for it.
- Enter that committed an input method's text sent the message in Safari (the room's composer and the room switcher): both ignore key code 229 as well as `isComposing`.
- A socket's `hello`, `visibility` and `focus` frames could be applied out of order, because each waited on the owner lookup; they apply as they arrive, then the owner is checked.
- A late card answered by a visitor with no actor closed the card for nothing: the answer is refused up front, with the card named, so it stays open and its buttons come back. Card buttons also stayed disabled after an answer that was not sent or was refused.
- A room's messages grew without bound in a page left open: a room the page does not show keeps its latest page, and a message newer than the last is added without a sort.
- A form cut short after its file part finished left the file on disk, uncounted; bytes after a form's closing boundary were gathered in memory; removing a chip or a failed send left its upload counting against the person's waiting files for a day (`DELETE api/uploads/<id>` now removes it); a send cleared text and chips added while it uploaded, and a failed chip counted as a slot; a failed page's error card stayed when the route changed; a download name's `'`, `(`, `)` and `*` were not percent-encoded and bidirectional override characters were kept.
- An open owner-app socket outlived a logout or a new password under `password` auth: it now closes with 4401 after an hour at most, and its reconnect carries the cookie again.
- A demoted or disabled owner kept receiving the owners' frames on an open socket: every frame from the socket, and a check every 30 seconds, read the person's tier again, and a socket whose person is no owner is closed with 4403.
- A visitor a verifier admitted without an actor could send messages that reached the host as nobody's: they are refused with `forbidden`.
- A JSON body sent without a length was read whole before the 64 KiB limit applied: the owner app's writes now count it as it streams.
- The Discord link and Cleanup were offered for an agent group that has no channel: `GroupView.channelId` is optional and the overview card shows neither without it.

### Removed

- `POST api/agents/<name>/avatar` and the page's Redraw picture button; drawn avatars are replaced by composed characters. `AgentProfileView.canDraw` and `AvatarRequest` are gone.

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
