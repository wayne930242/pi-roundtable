# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.45.0] - 2026-11-10

- Release in lockstep with pi-roundtable 0.45.0 (Places reads, chat-first home, other-comments note); no package-specific behavior changes.

## [0.44.1] - 2026-11-09

- Release in lockstep with pi-roundtable 0.44.1 (SVG attachments shown inline, sandboxed); no package-specific behavior changes.

## [0.44.0] - 2026-11-09

- Release in lockstep with pi-roundtable 0.44.0 (agent places storage, every oversized file split, worker worktree race fixed); no package-specific behavior changes.

## [0.43.0] - 2026-11-09

### Added

- `ConnectorRegistry.resync(name)` and `resyncAll()`, on `CONNECTORS` as `resync(name)` and `resyncAll()` and on Discord as `/<root> connector resync [name]`. A resync has the gateway read the connector's upstream server again, then sets its virtual server's tools to the gateway's current ones (names longer than `maxToolName` are skipped and reported as at add) and reads their hints, so an upstream that renamed tools is picked up, each renamed tool with the hints its upstream gives it, without removing the connector and entering its token again. A tool that keeps its name keeps the hints the gateway first stored for it, because the gateway's refresh does not update them: for hints that changed upstream under the same name, remove and add the connector again, or set the hints on the gateway. The gateway, the virtual server, the token, the purpose and the stored row stay; `version` changes when the tools or their hints did. Resyncs run one at a time.
- A failure before the gateway reads the upstream leaves the connector as it was. The gateway's own refresh drops the tools the upstream no longer offers from the virtual server, so a failure after it (the upstream offers no usable tool, or a later request fails) may leave the virtual server with fewer tools until the next resync; it is logged as such. Until the new tools are read back, the connector lists both the old and the new tool names with their hints, so the `mcp-hints` rule holds a renamed destructive tool even when the read-back fails.
- A resync makes five admin requests per connector and spaces them by `resyncIntervalMs` (default 1200, 50 a minute, half of the gateway's limit of 100 a minute, which locks the admin account for 15 minutes when exceeded; 0 turns pacing off). When the gateway answers 429, or 401, 403 or 423 (the account refused or locked), `resyncAll` stops there without retrying: the connector that met it and the ones after it are reported as not resynced, a single `resync` fails with `ConnectorRateLimited`, and every resync is refused without a request for `resyncLockoutMs` (default 15 minutes).
- The gateway's admin client gains `refreshGateway` and `setServerTools`, its tool type optional `gatewayId` and `hints`, its error type an optional `status`, and `ConnectorMessages` the keys `resyncDescription`, `resyncNameOption`, `resyncedTitle`, `resyncedAllTitle`, `resyncedFooter`, `resyncChanges`, `resyncUnchanged`, `resyncFailed`, `resyncNotAttempted` and the gateway's refresh-failure message. `ConnectorRateLimited` is exported.
- **Breaking for hosts that implement `Connectors`:** the type gains `resync` and `resyncAll`, which such a host needs to provide.
- `mcpConnectors` resyncs every stored connector in its preflight, after loading them, at that pace. A failure is logged. The `listFooter` text mentions `resync`.

## [0.42.0] - 2026-11-08

### Added

- `mcpConnectors` holds a call to a connector's tool whose server marks it `destructiveHint: true` or `readOnlyHint: false` (rule `mcp-hints`; its card names the tool, the server, and the call's `kind` and `id` when it has them). A tool that declares neither hint, or no hints at all, runs unasked, and yolo mode never approves a held call (`HoldRule.yolo`). `resolveVirtualServer` keeps each tool's boolean hints from ContextForge's `annotations`; ContextForge writes them when a tool is created, so a connector added before its upstream declared hints has to be added again. `ConnectorMessages.toolHintHold` words the card.

### Fixed

- `mcpConnectors` and `remoteMcp` start on a host without Discord: neither requires `DISCORD` any more, both read it with `services.find`. Without Discord the connectors add no slash commands and keep `CONNECTORS` and its management; remote MCP adds no `/<root> mcp` commands and no `/mcp/discord/<token>` route, serves `/mcp/personal`, keeps channel grants stored but unused, and with no agent server runs its default turns on the core's runtime. With Discord nothing changes.

## [0.41.0] - 2026-11-08

- Release in lockstep with pi-roundtable 0.41.0 (an agent team that lives in the app on a Discord host without an agent guild); no package-specific behavior changes.

## [0.40.0] - 2026-11-08

- Release in lockstep with pi-roundtable 0.40.0 (interactive blocks answered in the app, and chats that cannot show them say so); no package-specific behavior changes.

## [0.39.1] - 2026-11-08

- Release in lockstep with pi-roundtable 0.39.1 (the coding plugin reads its stored worker limit at start, so `Roundtable.check()` passes with `settingsInDatabase`); no package-specific behavior changes.

## [0.39.0] - 2026-11-08

- Release in lockstep with pi-roundtable 0.39.0 (incoming webhooks for the knights' app rooms; agent tools place rooms in the app's room groups; the owner sets the coding worker limit in Settings); no package-specific behavior changes.

## [0.38.1] - 2026-11-08

- Release in lockstep with pi-roundtable 0.38.1 (a quote in one's own app bubble is readable in every look; a list a model sends as JSON text reaches a tool as the list, so `helper_end` by name works); no package-specific behavior changes.

## [0.38.0] - 2026-11-08

- Release in lockstep with pi-roundtable 0.38.0 (display blocks: the web app draws cards, tables, steps, stats, mind maps, Mermaid diagrams, diffs and alerts in a message, and every other surface gets them as text); peer range `>=0.38.0 <0.39.0`, no package-specific behavior changes.

## [0.37.1] - 2026-11-07

- Release in lockstep with pi-roundtable 0.37.1 (an archived temp knight's or a dismissed thread's unread count leaves the tab title and dot without a reload); no package-specific behavior changes.

## [0.37.0] - 2026-11-06

- Release in lockstep with pi-roundtable 0.37.0 (a Presets page with recruits and transfer; the Edit knight sheet as tabs; a searchable skill picker; a lifted row that wiggles and resists its first pixels); peer range `>=0.37.0 <0.38.0`, no package-specific behavior changes.

## [0.36.0] - 2026-11-06

- Release in lockstep with pi-roundtable 0.36.0 (temp-knight presets managed from the knight sheet, shared between knights, and recruited by name); peer range `>=0.36.0 <0.37.0`, no package-specific behavior changes.

## [0.35.0] - 2026-11-06

- Release in lockstep with pi-roundtable 0.35.0 (temp-knight presets; the room drawer shows threads, swipes read and the rooms page swipes modes); peer range `>=0.35.0 <0.36.0`, no package-specific behavior changes.

## [0.34.0] - 2026-11-04

- Release in lockstep with pi-roundtable 0.34.0 (an agent's shell gets no host secret by default, GH_TOKEN included); peer range `>=0.34.0 <0.35.0`, no package-specific behavior changes.

## [0.33.0] - 2026-11-04

- Release in lockstep with pi-roundtable 0.33.0 (the agents' shell gets a whitelisted environment, secret reads and docker run/exec are held even in yolo, and tool output masks secrets); peer range `>=0.33.0 <0.34.0`, no package-specific behavior changes.

## [0.32.1] - 2026-11-04

- Release in lockstep with pi-roundtable 0.32.1 (optimistic mark-as-read, a Home button at the foot of the room drawer, Discord's -# subtext and line breaks in messages, the shared prompt's description in zh-TW, and the push device list centred); no package-specific behavior changes.

## [0.32.0] - 2026-11-03

- Release in lockstep with pi-roundtable 0.32.0 (plugins hear member joins and manage member roles on Discord); no package-specific behavior changes.

## [0.31.8] - 2026-11-03

- Release in lockstep with pi-roundtable 0.31.8 (the room drawer slides on from where the finger lets it go, without a frame shut); no package-specific behavior changes.

## [0.31.7] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.7 (menu rows hover in the quiet fill with 12 px padding wherever they are used; the message box draws no scrollbar below its tallest; a room row swiped right marks the room read); no package-specific behavior changes.

## [0.31.6] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.6 (channel context reads a peer bot's message up to `peerMessageChars`, default 4000); no package-specific behavior changes.

## [0.31.5] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.5; no package-specific behavior changes.

## [0.31.4] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.4; no package-specific behavior changes.

## [0.31.3] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.3; no package-specific behavior changes.

## [0.31.2] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.2; no package-specific behavior changes.

## [0.31.1] - 2026-11-01

- Release in lockstep with pi-roundtable 0.31.1; no package-specific behavior changes.

## [0.31.0] - 2026-11-01

- Release in lockstep with pi-roundtable 0.31.0; no package-specific behavior changes.

## [0.30.4] - 2026-11-01

- Release in lockstep with pi-roundtable 0.30.4; no package-specific behavior changes.

## [0.30.3] - 2026-11-01

- Release in lockstep with pi-roundtable 0.30.3; no package-specific behavior changes.

## [0.30.2] - 2026-11-01

- Release in lockstep with pi-roundtable 0.30.2; no package-specific behavior changes.

## [0.30.1] - 2026-11-01

- Release in lockstep with pi-roundtable 0.30.1; no package-specific behavior changes.

## [0.30.0] - 2026-11-01

- Release in lockstep with pi-roundtable 0.30.0; the peer range moves to `>=0.30.0 <0.31.0`. No package-specific behavior changes.

## [0.29.2] - 2026-10-31

- Release in lockstep with pi-roundtable 0.29.2; no package-specific behavior changes.

## [0.29.1] - 2026-10-31

- Release in lockstep with pi-roundtable 0.29.1; no package-specific behavior changes.

## [0.29.0] - 2026-10-31

- Release in lockstep with pi-roundtable 0.29.0; no package-specific behavior changes. The core peer range moves to `>=0.29.0 <0.30.0`.

## [0.28.0] - 2026-10-31

### Added

- `CONNECTORS` adds, re-describes and removes connectors (`add`, `describe`, `remove`) with the rules of `/<root> connector add`: no token is no authentication, a token alone is a bearer token, a header name sends the token in that header. Refusals are `ConnectorError`s in the configured wording, now marked `refusal: true`. `ConnectorInput`, `ConnectorError` and `displayUrl` are exported.
- `REMOTE_MCP` manages channel grants as `/<root> mcp` does: `operations`, `bundles(client)` with each channel's names, operations and recent audit, `revoke`, `describe`, `rotate` (the new URL returned once) and `authorize(client, input)` under the same channel checks: a server text or announcement channel the acting owner may manage, with the permissions behind each operation held by them and the bot. Refusals are `RemoteMcpError`s (`refusal: true`) in the configured wording; the new `operationsRequired` message refuses an empty or unknown operation choice.
- The Discord commands and the services share one implementation of these operations.

## [0.27.1] - 2026-10-31

- Release in lockstep with pi-roundtable 0.27.1; no package-specific behavior changes. The core peer range stays `>=0.27.0 <0.28.0`.

## [0.27.0] - 2026-10-31

- Release in lockstep with pi-roundtable 0.27.0; no package-specific behavior changes. The core peer range moves to `>=0.27.0 <0.28.0`.

## [0.26.3] - 2026-10-30

- Release in lockstep with pi-roundtable 0.26.3; no package-specific behavior changes. The core peer range stays `>=0.26.0 <0.27.0`.

## [0.26.2] - 2026-10-30

- Release in lockstep with pi-roundtable 0.26.2. The core peer range stays `>=0.26.0 <0.27.0`.

## [0.26.1] - 2026-10-30

- Release in lockstep with pi-roundtable 0.26.1; no package-specific behavior changes. The core peer range stays `>=0.26.0 <0.27.0`.

## [0.26.0] - 2026-10-30

The core peer range is now `>=0.26.0 <0.27.0`.

## [0.25.0] - 2026-10-29

- Release in lockstep with pi-roundtable 0.25.0; no package-specific behavior changes. The core peer range is now `>=0.25.0 <0.26.0`.

## [0.24.2] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.2; no package-specific behavior changes. The core peer range stays `>=0.24.0 <0.25.0`.

## [0.24.1] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.1; no package-specific behavior changes. The core peer range stays `>=0.24.0 <0.25.0`.

## [0.24.0] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.0; no package-specific behavior changes. The core peer range is now `>=0.24.0 <0.25.0`.

## [0.23.2] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.2; no package-specific behavior changes. The core peer range stays `>=0.23.0 <0.24.0`.

## [0.23.1] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.1; no package-specific behavior changes. The core peer range stays `>=0.23.0 <0.24.0`.

## [0.23.0] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.0; no package-specific behavior changes. The core peer range is now `>=0.23.0 <0.24.0`.

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

- Release in lockstep with pi-roundtable 0.22.0. The core peer range moves to `>=0.22.0 <0.23.0`.

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

### Changed

- **Breaking for plugins that read `CONNECTORS` while they set up:** `CONNECTORS.list()`, `servers()` and `profileSources()` are empty during `setup` (and `version` is 0), because `mcpConnectors` no longer reads the database or reaches the gateway there. It reads them in its `preflight`, which the host runs after every plugin is set up and before any service starts or any listener opens, and `version` changes when it has. Read the list from a service's `start`, or later (a turn, a command, a request); a host that cached tool sets by `version` before the host started rebuilds them once. `ConnectorRegistry.attach` is synchronous, and a new `load()` does the reading. The runtime's startup tool probe runs before this preflight, so it does not see the connectors' servers: a `requiredTools` entry that only a connector's server provides fails the start; the first real session connects to them instead.
- `mcpConnectors` and `remoteMcp` no longer query the database, or reach the gateway, during `setup`, so `Roundtable.check()` passes with them and needs neither. `remoteMcp` reads the principal the dispatch token stands for, and adopts the sessions and conversations of earlier versions, in its `preflight` too; a persona and the relay note read the principal when a conversation opens. Because both run before any service starts, no command or turn sees an empty connector list, and a failure there still stops the start before a surface connects. Which error stops the start where: a principal that does not exist, and a token linked to someone else by the configuration or the CLI, are refused by the identity plugin's setup as before; only a token linked to no one, which needs an `IDENTITY` that replaces the built-in plugin, is now refused in `remoteMcp`'s `preflight`, with the same message and without the `setup failed` prefix. A database error while adopting earlier sessions is now raised there too.
- Release in lockstep with pi-roundtable 0.17.0. The core peer range moves to `>=0.17.0 <0.18.0`.

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

## [0.9.1] - 2026-10-10

### Fixed

- A remote run asked for while the host shuts down fails instead of starting a turn (`defaultConversation().answer` resolves a failed result rather than rejecting). Needs pi-roundtable 0.9.1.

## [0.9.0] - 2026-10-09

### Added

- `remoteMcp({ principal })`: the id of the principal the dispatch token stands for, the primary owner by default, as in 0.8. The plugin declares the token as the identity `token:<toolNames.dispatch, or remote-mcp>` in its `identities`, which the host links to that principal at every start; a principal that does not exist, or the identity linked to someone else, stops the start.
- `RemoteMcpMessages.memberRelayNote`: the note opening each relayed message when the token stands for someone who is not an owner; it falls back to a `relayNote` you give.

### Changed

- The connector form of `/<root> connector add` is accepted from every owner, as pi-roundtable's `CommandGuard.allows` sees them, not only the primary owner.
- A default remote turn is the bound principal's, from `IDENTITY.speakerFor`, at their tier, and its conversation is recorded as private to them. Bound to the primary owner, as by default, the speaker is the owner's principal at the owner tier, so the prompt, memory, and tools are 0.8's; bound to a member, the turn reads their memory and offers only their tier's tools, and the persona and relay note name no owner. The host's own `answer` receives that speaker as a third argument.
- `remoteMcp` requires `IDENTITY` (provided by the built-in `identity` plugin of pi-roundtable 0.9); a `testPlugin` test of it gives one with `principalOf`, `tierOf`, `speakerFor`, and `owners`.
- Each remote session belongs to the principal it was opened for (`remote_agent_sessions.principal_id`, migration `remote-sessions-principal`); after the token moves to another principal, continuing a session of the earlier one answers `SESSION_NOT_FOUND`. Sessions 0.8 opened are handed to the primary owner at the start, and their conversations, which 0.8 recorded as shared, are adopted as private to them with `CONVERSATIONS.adopt`, so a single-owner host's remote turns stay 0.8's. Every start adopts each session's conversation for its principal again, so one a failed hand-over left shared becomes theirs at the next start; adopt never changes a conversation that is already someone's. `remoteMcp` therefore requires `CONVERSATIONS` too, and a `testPlugin` test of it gives one with `adopt`.
- The buttons and menu of `/<root> mcp authorize` and `/<root> mcp token` check again, at each press, that whoever presses is an owner, so an owner revoked while the flow is open completes nothing.

### Deprecated

- `REMOTE_SPEAKER` in `default-conversation.ts`: remote turns are for the bound principal. It goes away in 1.0.

### Fixed

- The default remote turn finds the actions a restart left held: it reads them with `heldActions`, which restores them from the store, instead of `pendingConfirmation`, which knows only the conversations that ran a turn since startup, so an approval relayed as the first message after a restart confirms them again, as in 0.8. Needs pi-roundtable with the same fix.

## [0.8.0] - 2026-10-07

- Release in lockstep with pi-roundtable 0.8.0; no package-specific behavior changes.

## [0.7.18] - 2026-10-05

### Fixed

- Reserve a remote session atomically so simultaneous dispatches cannot overlap.
- Keep a timed-out session busy until its underlying answer settles, and release it after synchronous or asynchronous answer failures.

### Changed

- Track active executions by session instead of scanning historical runs to decide whether a session is busy.

## [0.7.2] - 2026-10-02

The first release from pi-roundtable; 0.7.0 and 0.7.1 were not published for this package.

### Changed

- Move into the pi-roundtable monorepo at `packages/mcp`, preserving Git history and the public API.
- Jump from 0.4.1 to lockstep 0.7.0, peer on `>=0.7.0 <0.8.0`, and test against core 0.7.0.
- Use the shared PostgreSQL CI and single-tag publication workflow.

## [0.4.1] - 2026-10-01

### Changed

- The peer dependency on `pi-roundtable` is `>=0.4.0 <0.6.0`, so a host on 0.5 does not get a peer warning. The tests now run against pi-roundtable 0.5.0.

## [0.4.0] - 2026-10-01

### Added

- `ChannelGrantStore` is exported, with its `migration`, `attach(sql)`, `ensureBundle`, `save` and the rest, for host-side imports and tools. The plugin still owns the tables.
- `ConnectorMessages`: the ContextForge errors are messages now (`upstreamUrlUnreadable`, `contextForgeNoGatewayId`, `contextForgeNoServerId`, `contextForgeRefused`, `contextForgeNotJson`, `virtualServerRequestFailed`, `virtualServerMissing`, `virtualServerNoTools`), and so are the description of a new connector's virtual server (`serverDescription`) and the separator after a connector's name in the list (`labelSeparator`). The values they receive are masked as before.
- `RemoteMcpMessages`: the human part of a granted tool's error (`operationFailed`, `outcomeUnrecorded`, and `codeDetail`, which joins it to the fixed code), the label and list separators of the grants list (`labelSeparator`, `listSeparator`), and the wording of an audit entry's status (`auditStatus`).
- `RemoteMcpMessages.describeAgentNameOption` and `revokeNotInBundle`: the `name` option of `describe` and the refusal of `revoke` have their own wording. They default to the text of `agentNameOption` and `notInBundle`.

### Changed

- `agentNameOption` now words only the `name` option of `authorize`, and `notInBundle` only what `describe` says when the channel is not in the bundle. The English defaults are unchanged, so a host that overrides `messages` keeps working; it sets the new keys where it wants a different wording.
- `runGrantedTool` takes the messages as its last argument. It is internal and not exported from the package.

## [0.3.0] - 2026-10-01

### Added

- `Connectors.resolve(serverName)` reads a virtual server by name, and `Connectors.admin` (`gateways()`, `servers()`) shows what ContextForge holds, for a host that manages some servers itself or shows their state.
- The `REMOTE_MCP` service of `remoteMcp`: the owner's bundles and grants, read only, and `describeGrant(client, grant)`, so a host can show them in its own status view.
- The types `GatewayState`, `ChannelBundle`, `ChannelGrant`, and `RemoteMcpService`.

## [0.2.0] - 2026-10-01

### Added

- `remoteMcp({ toolNames })`: the names of the two tools at `/mcp/personal`, for agents that are already set up with other names. The default descriptions name each other with the chosen names. A name that is not letters, digits, `_` or `-` (up to 64), or two equal names, is refused when the plugin is created.

### Changed

- `RemoteMcpMessages.dispatchDescription` and `resultDescription` are now functions that receive the tool names, so a description can refer to the other tool by its real name. A host that set either as a string gives `() => "..."` instead.

## [0.1.0] - 2026-10-01

First release: two plugins for pi-roundtable 0.4, extracted from a private host.

### Added

- `mcpConnectors(options)`: the owner's MCP connectors through ContextForge. `/<root> connector add | list | describe | remove` manage them from Discord, with a private form for the token. It provides the `CONNECTORS` service (`version`, `list()`, `servers()`, `profileSources()`, and the ContextForge `token`), so a host builds its per-agent MCP profiles itself. Options: `contextForge` (`url`, `jwtSecret`, `user`), `serverPrefix` (default `roundtable-conn-`), `maxToolName` (default 45), and `messages`.
- `remoteMcp(options)`: an MCP server over HTTP on the host's `public` listener for agents outside Discord. `/mcp/personal` relays turns to the owner's agent (`agent_dispatch`, `agent_result`); `/mcp/discord/<token>` offers the Discord channel tools granted to one bundle. `/<root> mcp authorize | grants | revoke | describe | token` grant channels on Discord. Idle remote sessions are deleted after 14 days.
- Without `answer` and `claim`, `remoteMcp` runs a relayed turn on the core: `context.turns.run` of kind `remote` for an owner-tier speaker, with a `remote` persona (`persona` option, a short neutral prompt by default). A host that runs the owner's conversations itself gives `answer` and `claim` together.
- A `messages` option on both plugins; the English text is the default. pi-roundtable's message catalog is closed to plugins, so these plugins carry their own.
- The types `Connector`, `ConnectorProfileSource`, `Connectors`, `ConnectorMessages`, `RemoteMcpMessages`, `RemoteClaimHooks`, and the option types.
