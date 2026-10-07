# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

A Discord project from 0.7 upgrades without changing its configuration; [Migrating to 0.8](docs/migrating-0.8.md) covers what to check and how to start a host without Discord.
The behavior changes are who may approve a held call (Fixed), two built-in plugins before `agent-server` and `context.turns` on `RUNTIME` (Changed), and the start of a project `roundtable init` creates (Fixed).

### Added

- [Migrating to 0.8](docs/migrating-0.8.md), the upgrade guide. The README describes pi-roundtable as an agent server reached through Discord or the web chat, built for one owner, with a threat model; running it for several people is at the operator's risk.

- The `adapters` configuration key and `discord()` from `pi-roundtable/discord`: `adapters: [discord({ token, guild, entryChannel, ... })]` takes the same settings as the top-level `discord` and assembles the same plugins in the same order; `roundtable doctor` reads it the same way. The top-level `discord` stays the default form and what `roundtable init` writes. Configuring Discord in both places, a second Discord adapter, an unknown adapter, or an entry that is not an adapter is a configuration error naming `adapters[<n>]`; a chat network that comes as a plugin, such as `webChat()`, stays in `plugins`. Types: `AdapterConfig` and `DiscordConfig` from `pi-roundtable`, `DiscordAdapterConfig` from `pi-roundtable/discord`; value: `discord`.
- `roundtable init --adapter web` creates a project without Discord around the new pi-roundtable-webchat package: an OpenID Connect verifier, an access map from the token's roles, a persona in `persona/assistant.md` whose `selection` names its tools (the hello plugin's, and no `schedule_*`, `delegate_task`, or web tools), and a `.env.example` without Discord; `--adapter discord` is the default and unchanged.
- pi-roundtable-webchat, a new package: a WebSocket chat adapter for people an OpenID Connect provider signs in, with private conversations, live progress, approval cards, and a REST API; see its changelog.
- The chat surface contract in `pi-roundtable/testing`: `describeSurfaceContract(name, make)` registers one test per check on a `SurfaceContractSubject` (a surface, a channel, and one person who writes, sees `SurfaceObservation`s, and answers approvals), and `checkSurfaceContract(make)` returns the checks a surface broke as `SurfaceContractFailure`s. It checks the prefix and channel, delivery, every chunk of a reply, and, where offered, files, idempotent typing and stop controls, progress, and approvals that resolve as answered or `cancelled` when the turn stops. Names: `describeSurfaceContract`, `checkSurfaceContract`, `SurfaceContractSubject`, `SurfaceObservation`, `SurfaceContractFailure`.
- A host without Discord: leave `discord` out of the configuration and the host runs no Discord plugin, no agent server, no agents, and no skills, while the runtime plugin still runs every turn of `context.turns` over the plugins' own surfaces. `http` becomes optional (`http.publicUrl` stays required with Discord), and without it no listener opens. `agents`, `skills`, and `ops.agent` without Discord are configuration errors; `notify_owner` is not registered; `schedule_*` and `delegate_task` are not registered, since their runs are turns of the `owner` background target the agent server contributes; a plugin that contributes it brings them back, working in a conversation a chat surface carries and refusing elsewhere. `roundtable doctor` skips the Discord checks, and `testHost({ discord: false })` boots such a host. See [a host without Discord](docs/plugins.md#a-host-without-discord) and `examples/headless.ts`.
- `ops: { conversation: "<surface>:<id>" }` reports the process's own errors to a conversation instead of an agent. The host does not start when no chat surface serves the key or no plugin's claim owns it. The web chat takes no error reports in 0.8: a `web:` conversation is only its signed-in person's, and its claim takes no background turns.
- `ConversationPort.owns(channel)`: whether a plugin's claim owns a channel. A test double that implements the whole port, rather than a `Pick` of it, adds the method; `testPlugin`'s stand-in has it.
- The conversation registry, `CONVERSATIONS`, provided by the new built-in `conversations` plugin (table `conversations`, ledger id `conversations/conversations`). `context.turns.run` records each conversation before its turn runs: at the first turn its key, surface, kind, visibility, principal and title, and later only that it was active; a turn whose conversation cannot be recorded does not run. `ConversationTurnInput.conversation: { visibility: "private" | "shared", title? }` records a conversation as the speaker's own (default `shared`). The registry offers `register`, `get`, `list({ principal }?)` and `setTitle`; no session file moves. Types: `ConversationRegistry`, `ConversationRecord`, `ConversationRegistration`, `ConversationVisibility`.
- Live turn progress for a turn run through `context.turns`: the `turnProgress(event)` handler and the optional `ChatSurface.progress(channel, event)` hear a `TurnProgress` as the turn goes, `{ type: "text", delta }` (text joined over 250 ms, sent before any tool event, never the thinking), `{ type: "tool_start", id, tool, preview? }` (a one-line preview of the arguments of at most 80 characters, never their full text), and `{ type: "tool_end", id, tool, ok }`. The Pi runtime reports it through the new `TurnRequest.progress`; `SurfacePort.progress` and the optional `EventSink.turnProgress` carry it. Types: `TurnProgress`, `TurnProgressEvent`.
- `RUNTIME`, the runtime every conversation turn runs on, provided by the new built-in `runtime` plugin that every host registers just before the agent server. It is the `runtime` slot's runtime when a plugin fills the slot, and Pi's otherwise; `AGENTS.runtime` is the same instance, and `context.turns` now reads `RUNTIME`, so turns no longer need the agent server. `testPlugin` takes `servicePair(RUNTIME, runtime)`, given whole; `servicePair(AGENTS, { runtime })` keeps working.
- WebSocket routes: an `HttpRoute` may declare `websocket` (`WebSocketRoute`) to take WebSocket upgrades on its path, while every other request still reaches `handle`. An upgrade is a `GET` with `Upgrade: websocket`, a `Sec-WebSocket-Key`, and `Sec-WebSocket-Version: 13`; a `GET` missing the key or version gets `400` and other methods reach `handle`, all without calling `accept`. It then passes the route's `origins` allowlist (a missing or other Origin gets `403`; `"any"` skips the check; an entry that is not exactly a `scheme://host[:port]` origin, special such as `https://…` or non-special such as `chrome-extension://<id>` or `tauri://localhost`, is refused at startup, as is `"null"`) and `maxConnections` (256 by default; one more gets `503`), and then `accept(request)`, which authenticates before any socket opens and returns `{ data, headers? }` or a refusing `Response` (`WebSocketAccept`). Handlers get a `RouteSocket` (`data`, `send`, `close`); `send` answers a `WebSocketSendResult`: `"sent"`, `"queued"` behind a slow reader, or `"dropped"`. `maxBufferedBytes` (1 MiB by default) is checked before each `send`: once that many bytes wait for a client that stopped reading, `send` answers `"dropped"` and the socket is cut without a close frame, so the client and the route's `close` see 1006; nothing is dropped silently. A `send` that finds fewer waiting goes out whole, so one message larger than the limit still reaches a reading client and the bytes waiting can reach the limit plus one message; an empty message is `"sent"`. Every limit (`maxMessageBytes`, `maxBufferedBytes`, `maxConnections`, `rate.messages`, `rate.perMs`) must be a positive integer, or startup fails naming the route and field. Handlers may return any value, which is ignored; a promise is awaited. A message over `maxMessageBytes` (64 KiB by default) closes the socket with 1009, one over `rate` (120 a minute by default) with 1008, and a throwing handler closes only its socket with 1011 and logs the route and listener, never the URL. A throwing `accept` answers 500 with the fixed body. On shutdown every socket is closed with 1001 and the host waits up to five seconds for the routes' `close` handlers before stopping services. A route with `websocket` whose `methods` leave out `GET` is refused at startup. `pi-roundtable/kit`'s `serveUnix` takes an optional `websocket` handler and passes the server to `fetch`, which may answer nothing only when `websocket` is given. The guide's example spends each ticket once, and the guide warns against combining `origins: "any"` with cookie authentication.

### Changed

- Two built-in plugins join every host, just before `agent-server`: `conversations`, which provides `CONVERSATIONS`, and `runtime`, which provides `RUNTIME`. The order of the other plugins and of their migrations is unchanged; a plugin that matches built-in plugins by name, or reads `serviceStarted` events, sees the two new names.
- `context.turns` runs every turn on `RUNTIME` instead of the agent server's runtime, so it works on a host without the agent server. `AGENTS.runtime` is the same instance, and a plugin that fills the `runtime` provider slot keeps replacing it.
- `PendingConfirmation` gains `speakerId`, the speaker whose turn held the calls. A runtime with its own `HeldActionStore` keeps it across a restart; a restored held call without one is the owner's to approve.
- `HttpRoute` gains the optional `websocket`, and `pi-roundtable/kit`'s `serveUnix` passes the server to `fetch` as its second argument, with an overload that takes a `websocket` handler; see WebSocket routes under Added.
- The official packages release in lockstep at this version: pi-roundtable-webchat is new; pi-roundtable-web lists the conversations the registry records; pi-roundtable-sandbox's `apiKey` and `oauthToken` receive the turn's `{ channel, speaker }`. See their changelogs.
- The Pi runtime and the held actions' table move from the agent server to the `runtime` plugin. The `held-actions` migration is recorded once more under `runtime/held-actions`; it creates the table only when it is missing, so an existing database is unchanged.
- `RoundtableConfig.discord` and `RoundtableConfig.http` (and `http.publicUrl`) are optional in the type; code that reads them from a config object now checks for them.
- `RuntimeDeps.agents` is optional and read when a turn runs: the runtime is built before the agent server sets up, and it is `undefined` on a host without the agent server.

### Fixed

- A project `roundtable init` creates now starts. Pi's runtime requires the `compact_session` tool in every session, which comes from the Pi package pi-self-compact, and neither template loaded it, so `roundtable start` stopped at the preflight with `required tools are not registered: compact_session`. Both templates (`--adapter discord` and `--adapter web`) now pin `pi-self-compact` 0.2.0 and list a `plugins/self-compact.ts` that loads it with `piPackages`; the preflight's message names the package and the fix. An existing project adds the same: `bun add pi-self-compact`, then a plugin with `piPackages: ["pi-self-compact"]`.
- An approval card now gets the lowest tier that may approve its call (`OwnerPrompts.confirm`'s `minTier`, the higher of the tool's tier and the hold rule's `approvalTier`). The runtime dropped it on the way to the surface, so every card was the owner's alone. On Discord, a held call of a member- or admin-tier tool may now be approved by the speaker whose turn held it, when their tier is at least `minTier` (checked again when they press), and by the owner; nobody else in the channel may approve it, whatever their tier, and in the owner's own turn the card stays the owner's. A speaker below `minTier` leaves the card to the owner. The chat surface contract gains a check that another person cannot answer the person's approval, through the optional `SurfaceContractSubject.stranger`, and its approvals now ask for exactly the speaker's tier.
- Behavior change: a held call in an agent's channel or a group room is approved by text only by the speaker whose turn held it, at a tier that holds its tools (read again from their message), or by the owner. Before, any speaker of that tier in the channel could approve another person's held call with a message such as "yes", and in a group room that also woke the seat. `PendingConfirmation.speakerId` records the speaker, and the held actions' table gains the column `speaker_id` (migration `runtime/held-actions-speaker`, a nullable column; rows held before it are the owner's to approve).

## [0.7.19] - 2026-10-07

### Fixed

- Behavior change: in a conversation outside the agent server, such as a plugin's persona conversation run through `context.turns`, a member or admin speaker now reads and changes their own memory. Before, every such turn carried the owner's core facts and upcoming events in its system prompt, whoever spoke, and `memory_add`, `memory_search`, and `memory_remove` (member-tier tools, when a turn's selection offered them) read and changed the owner's memory. The prompt section of such a turn is headed `Memory of <name>` and lists only that speaker's facts. A speaker of the owner tier, the owner or remote MCP's speaker, keeps the owner's memory, and the owner's own conversations, agent conversations, and every tool description read as before. No data moves: facts a member stored before this release sit in the owner's memory, and the owner may remove them with `memory_remove`.

## [0.7.18] - 2026-10-05

### Fixed

- Stop reading attachments as soon as they exceed the 25 MiB limit and cancel HTTP error bodies instead of leaving them open.
- Stop claiming or starting schedules when shutdown occurs during a database query or claim; already running turns still finish normally.
- Isolate keyless Jev tests from the developer's home, XDG configuration and environment.

### Changed

- Extract schedule precheck resolution, execution and cleanup tracking from the scheduler without changing its public contract.
- Release all five official packages in lockstep; MCP and sandbox include lifecycle fixes described in their changelogs.

## [0.7.17] - 2026-10-04

### Added

- A turn posts the text it writes before its final answer as it goes, so a proposal written before `ask_user` shows above its card instead of never reaching the channel. Primary text (400 characters or more, or with a Markdown heading, list, table or code fence) of a tool-calling assistant message is posted as ordinary messages when the message ends; shorter narration and the tools called (`-# bash ×3 · read`, names only) share one small-text progress message per run of tool calls, edited at most every 1.5 s, bounded to 2000 characters by dropping its oldest lines. Before any card the pending text is posted first. The final reply, its thinking line, and steered runs are unchanged; a failed interim post is logged and never fails the turn. See [interim text](docs/plugins.md#interim-text-what-a-turn-writes-before-its-final-answer).
  - Config `interimText: "on" | "off"` (default `"on"`) and `interimPrimaryChars` (default 400), also on `PiAgentRuntimeOptions` and the agent server's options.
  - `TurnRequest.interim`, `ChatSurface.interim(channel)` and `SurfacePort.interim(channel)` (Discord's surface implements it), optional `AgentChannels.interim(channelId, as)` (the agents' webhooks), and `PromptSlot.bind`'s optional `beforeCard`.
  - Types: `InterimMessage`, `InterimPosts`, `InterimTextMode`.

### Changed

- `ask_user`'s description asks for a question that reads on its own, with the context it needs.

## [0.7.16] - 2026-10-04

### Added

- `pi-roundtable/kit` owns a Jev compaction engine on pi-jev-compaction 1.0.0 (now a dependency, pinned exactly): `jevCompact(input, options)` and two adapters, `jevCompactionExtension({ logger })` for the `compaction` session tool (placed through `session.compaction.wrap`, engine `JEV_COMPACTION_ENGINE`, `pi-jev-compaction`) and `jevCompactor({ logger })` for pi-roundtable-sandbox's `compaction` option. Both log each fallback to Pi's summary with its reason and `tokensBefore`, except a missing API key, which they log once (`Jev is not configured, so compaction uses Pi's summary`) and then compact through Pi's summary quietly: the key is optional.
  - Values: `jevCompact`, `jevCompactionExtension`, `jevCompactor`, `isRuleLoad`, `JEV_COMPACTION_ENGINE`, `JEV_GOAL`, `JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS`; types: `JevCompactInput`, `JevCompactOptions`, `JevCompactOutcome`, `JevCompactor`, `JevCompactRequest`, `JevExtensionOptions`, `JevSkipReason`.
  - Unlike pi-jev-compaction's own `compactPiSession`, a summary carries the previous summary once, not twice, so a chain of compactions no longer doubles (one session's grew from 8k to 303k characters over five compactions).
  - A previous summary over 60,000 tokens (`previousSummaryLimitTokens`) skips Jev, so Pi's summary condenses the chain.
  - Jev judges with a goal (`JEV_GOAL`, option `goal`) that keeps the tool results that set rules still in force, which it dropped without one, and the summary ends with the rule loads it summarized (skills, notebook system prompts, reads of SKILL.md, AGENTS.md and `.agents/skills/`; option `ruleLoad`, default `isRuleLoad`) for the agent to load again.

### Changed

- The shell hold rule lets more of the agents' own work run.
  - The agents get a scratch dir, the config's new `scratchDir` (default `<os temp dir>/<discord.rootCommand>-scratch`, created with mode 0700 at startup; a symlink or another user's dir is refused), and their `bash` runs with `TMPDIR` pointing to it. Redirects, `tee`, and `write` and `edit` inside it run as inside the workspace; the rest of `/tmp` stays held. `AgentSessions.scratchDir` and `HoldContext.scratchDir` carry it, and the agents' prompt names it.
  - `rm` is no longer always held: it runs when every operand resolves, after the line's literal variable assignments, `cd`, `..` and symlinks, inside the workspace or the scratch dir without being one of them. A command substitution, an unknown variable, a root itself, `/`, or no operand keeps it held.
  - `git push` stays held by `shellHoldRule`; the new `shellHoldRuleFor({ ownPushOwners, heldPushRepos })` (type `PushPolicy`) lets a plain push to a GitHub repository of a listed owner run, unless it forces, deletes, pushes tags or a mirror, or the repository is in `heldPushRepos` or its remote cannot be read.
  - A relative write target or `rm` operand resolves from the line's last `cd`, not always from the workspace.
  - Value: `shellHoldRuleFor`; type: `PushPolicy`.

### Fixed

- pi-roundtable-coding frees a finished job's repository before delivering its report, so the turn that receives the report can ship it or start the next worker there instead of being refused with "still using".

## [0.7.15] - 2026-10-03

### Changed

- pi-roundtable-sandbox: the model broker forwards Claude Code's mid-conversation system messages, rebuilt and with their effort capped, instead of refusing them; see its changelog.

## [0.7.14] - 2026-10-03

### Fixed

- pi-roundtable-sandbox: a model request the broker refuses is a 400, worded so Claude Code resends it without its mid-conversation system messages, instead of a 502 it retried for minutes; see its changelog.

## [0.7.13] - 2026-10-03

### Changed

- Behavior change: a precheck script's MCP calls follow the hold rules. Saving a script reads its `mcp.call` and `mcp.json` calls (server and tool written as strings, `mcp` used for nothing else, or the script is refused) and judges each with the host's hold rules; if any is held, the `schedule_create` or `schedule_update` call is itself held for the owner through the confirmation gate, once, and the scheduled runs do not ask again. The schedule keeps the tools its script may call (`Schedule.precheckTools`, `NewSchedule.precheckTools`, `ScheduleChange.precheckTools`, the type `PrecheckTool`) in a nullable `precheck_tools` column (the new `schedules-precheck-tools` migration); the runner gets them as `PrecheckScriptContext.tools` and must refuse every other call; `schedule_list` shows them, marking those the owner approved. A script saved before has no recorded tools: its first run reads them, runs it if none is held, and otherwise wakes the agent to save it again.
- Behavior change: `PrecheckScriptRunner` needs `toolName(server, tool)`, the name the hold rules know a script's call by.
- `HoldRule` takes an optional `mayHold(tool)`, for a rule whose verdict depends on the input, and an optional `approvalTier(tool, input, context)`, the lowest tier that may approve a call it holds when higher than the tool's own; `HoldCheck` (and `holdChain`'s) gains `mayHold` and `approvalTier`. A held call keeps that tier (`HeldCall.minTier`), and both its approval card and a confirming message require it, so saving a script whose runs send mail needs whoever may approve sending mail, not only whoever may schedule. `ScheduleToolContext` takes `holds`.

## [0.7.12] - 2026-10-03

### Fixed

- pi-roundtable-sandbox: a host compactor's time shrinks with the turn's, and an error event in the middle of a successful model stream is logged; see its changelog.

## [0.7.11] - 2026-10-03

### Added

- Precheck scripts: agents may write a schedule's precheck themselves. `schedule_create` and `schedule_update` take `precheck_script`, a JavaScript module of at most `PRECHECK_SCRIPT_CHARS` (8,000) characters with a default export, parsed but never run when it is set; a schedule has a `precheck` or a `precheck_script`, and setting one removes the other. The core never runs a script: a `PrecheckScriptRunner` registered with `PRECHECKS.useScriptRunner` (`scriptRunner` reads it) runs it with a `PrecheckScriptContext` (the schedule, `firedAt`, `signal`, the host's `timeZone`, and `today`), and its `describe` (given a `PrecheckScope`) tells the model what a script may call; `schedule_list` shows it and a schedule's script. Without a runner, the tools neither take nor mention scripts, and a stored script wakes the turn with `### Precheck failed: script`. `Schedule`, `NewSchedule`, and `ScheduleChange` gain `precheckScript`; the `schedules` table gains a nullable `precheck_script` column through the new `schedules-precheck-script` migration. `scheduleToolSpecs` takes `precheckScripts`.
- `pi-roundtable/testing`: `fakeScriptRunner` (`fakeScriptRunner(answer, options?)`), with the types `FakeScriptAnswer` and `FakeScriptRunner`.
- `PrecheckScope` carries `tier`: the script's creator's tier when it runs, the asker's when `schedule_list` describes it, so a runner may grant lower tiers less. A script may export its default as `export { check as default }`. The store itself keeps a schedule's `precheck` and `precheckScript` apart. `schedule_list` waits at most 10 seconds for the runner's `describe`.

### Changed

- Stopping the scheduler aborts running prechecks (their `signal` fires) and waits up to 15 seconds for them to settle, so a sandboxed script's container is removed before the host exits; a precheck that ends after the stop starts no turn and records `skipped: the host stopped during its precheck`.
- Behavior change: `PrecheckRegistry` gains `useScriptRunner` and `scriptRunner`, so a host that provides `PRECHECKS` with a registry of its own must add them.
- pi-roundtable-sandbox: `precheckScriptRunner` runs each script in a sealed container; see its changelog.

## [0.7.10] - 2026-10-03

### Added

- Kit: the core's compaction tiers for a host that builds its own Pi session, such as a sandbox worker: `CompactionTiers`, `compactionEngine`, `SOFT_COMPACT_TOKENS`, `HARD_COMPACT_TOKENS`, `COMPACT_HEADROOM_TOKENS`, and the types `CompactionEngine`, `CompactionHistory` and `LatestCompaction`.
- Sandbox: Pi worker sessions compact with those tiers, through an optional host compactor (`compaction` on `PiSandboxRuntime`) at 300,000 tokens and Pi's summary past 500,000, and the host logs each compaction and fallback per channel.

### Changed

- Sandbox: a failed Pi turn keeps its cause and is logged, the broker logs upstream failures, a timed-out worker's last log lines are logged before its container is removed, and Pi containers log to journald tagged `sandbox/<channel>` by default instead of local files (the Docker daemon must have journald).

## [0.7.9] - 2026-10-03

### Added

- Schedule prechecks: host code registers a named check with `PRECHECKS` (`register`, as `register({ name, description, timeoutMs?, run })`, provided by the new built-in `prechecks` plugin), and a schedule may name one in the new `precheck` parameter of `schedule_create` and `schedule_update` (`null` removes it). When the schedule falls due, the scheduler takes it as before and then runs the check: `{ wake: false, note? }` skips the turn and posts the note as the bot's own small message, `{ wake: true, context }` runs the turn with the context under a "Precheck found" heading, and a throw or a timeout (`PRECHECK_TIMEOUT_MS`, 60 seconds by default) runs it with the error. `schedule_list` and `/<root> schedule list` show a schedule's precheck and the last outcome, and `schedule_list` names the registered prechecks with their descriptions. New types: `Precheck`, `PrecheckContext`, `PrecheckResult`, `PrecheckRegistry`, `PrecheckFinding`. `Schedule`, `NewSchedule`, and `ScheduleChange` gain an optional `precheck`; `BackgroundTurns.runScheduled` takes the `PrecheckFinding` as an optional third argument. The `schedules` table gains a nullable `precheck` column through the new `schedules-precheck` migration.
- `pi-roundtable/testing`: `fakePrecheck` (`fakePrecheck(name, answer, options?)`, a precheck that answers as the test says and records its calls) and `fakePrechecks` (a real in-memory registry with the given prechecks registered), with the types `FakePrecheck` and `FakePrecheckAnswer`.

## [0.7.8] - 2026-10-03

### Fixed

- `scrubDiagnostic` masks a value to its end when an earlier rule had masked only its head (`password=sk-…!tail`, `GITHUB_TOKEN=ghp_…!tail`, a quoted value that continues after a token shape). A `[redacted]` an earlier rule wrote is read as part of an unquoted value, so `password=https://user:pw@host/x` ends as `password=[redacted]` with no `]]`.

## [0.7.7] - 2026-10-03

### Changed

- `scrubDiagnostic` takes linear time on a long run of `eyJ-` too: the JWT pattern now starts at the beginning of a run (a JWT glued directly after `-` is no longer masked by that pattern, only as the value of a secret-named field).
- `scrubDiagnostic` reads a quoted value up to its closing quote, so a secret holding `}`, `]`, blanks, `&`, `,` or `;` is masked whole; `}` and `]` end only an unquoted value. A value an earlier rule already masked is not masked again (no `[redacted]]`).

## [0.7.6] - 2026-10-03

### Changed

- `scrubDiagnostic` takes time linear in the text at any bound (`diagnosticChars: Infinity` included): every pattern starts at the beginning of a run through a lookbehind, and a value is read only for a secret-named field.
- `scrubDiagnostic` no longer masks what is not a secret: plural `tokens` counters (`max_tokens`, `input_tokens`), a numeric value of a token name, setting names such as `password_policy` or `token_limit`, and the word after `Basic`, `Bearer` or `token` unless it has a credential shape. A value ends at `}` and `]`.
- Drawing: `permissive` also accepts an empty relationship-map node id (the argument schema allows it), draws a sigil whose intention has no letters or is blank, and ignores a sacred-geometry color canvas cannot parse.

## [0.7.5] - 2026-10-03

### Added

- Coding: `workerBlockText` (what the worker reads for a declined or held call), `limits` (`reportChars`, `heldEntries`, `heldChars`) and `diagnosticChars`.
- Drawing: `permissive` accepts what a looser host's callers send (unknown card exclusions, shared spread cells, repeated or empty node ids, self-edges), and `mapLimits` values are checked.
- Sandbox: `ScopedSandboxDelegator` accepts `maxTitleChars`, `maxReportChars` and `diagnosticChars`.
- Web: `skills.errorDetail` shows why a skill could not be read.

### Changed

- `scrubDiagnostic` also masks token, secret, password and API-key assignments in any case (query strings and JSON fields included), Cookie and API-key headers and JWTs, and works on a bounded prefix so hostile input stays fast.
- Sandbox: `ScopedSandboxDelegator` limits a title to 200 characters again by default.
- Web: the skill detail no longer refuses a body over 1 MiB or frontmatter over 64 KiB.

## [0.7.4] - 2026-10-03

### Added

- Export `scrubDiagnostic` from the kit: mask credentials in subprocess or worker text (URL userinfo, bearer values, well-known token shapes, secret-named assignments), drop control characters and bound the length, so a host can show a failure's reason without its secrets.
- Coding: `toolText` for the repository tools' descriptions and argument descriptions, `presentation.list` for the `repo_list` result, and `repo_push` takes a 7–40 character sha prefix of the reported commit.
- Sandbox: `SandboxResearchWorker` accepts the host's own `tools` (extension packages and factories, active tool names, prompt), a `scope` around the session and the `aborted` wording.
- Drawing: `cardPresentation.result` words the card draw result, and `mapLimits` lets a host accept longer relationship-map text.
- Web: a channel Discord cannot name shows the `channel name unavailable` text.

### Changed

- Coding: git and gh failures name their scrubbed stderr again, a worker's own error reaches the report (scrubbed and bounded), the timeout and stop texts read as before ("the worker ran out of time (N minutes)", "the worker was stopped"), the refusals for a busy repository, a missing or over-long task and a full channel say what is wrong, a declined call is no longer listed as held, and the service reports the channels it works for so a shutdown can name them.
- Sandbox: `ScopedSandboxDelegator` refuses with the reasons the core delegator gave ("title and task are required", the task length, the channel's running count), no longer limits the title, and reports a failed job's scrubbed error message or "the worker ran out of time" instead of "Sandbox task failed".

## [0.7.3] - 2026-10-03

### Fixed

- The sandbox's rich broker streams model responses instead of buffering them and no longer cuts calls at 60 or 120 seconds; the turn deadline is the bound. The worker can no longer raise effort or thinking budget above the host-judged level. `startFresh` and start replace guest-planted symlinks instead of following them, and only the two reserved blocks of the 192.0 range are refused, not all of it.

### Added

- Sandbox `assertPublicUrl`, `safeFetch` options `followRedirects` and `headers`, and a research-worker `fetchContent` hook, so a host can keep a library's own extractors while its fetches of a model-supplied URL stay pinned and vetted per hop. Broker upstream errors keep their status, body and back-off headers.
- Coding accepts `pushHoldText` for trusted wording of the held `repo_push` approval card.
- Export `withReplyFiles` for standalone workers to collect reply attachments with the same turn-wide limits, success/failure semantics, and asynchronous scope as host conversation turns.
- Export `prepareImageBytes` and `ImagePreparationError` from the kit for raster bytes without reopening guest-writable paths; reject encoded images over 25 MiB or headers/aggregate frames over 64 MP before native decode, while preserving ordinary 48 MP images and 9000×1 downscaling. File-based preparation is byte-bounded too and decodes once instead of twice.
- Drawing accepts `CardPresentation` through `DrawingOptions.cardPresentation` for trusted operator headings and reversal suffixes without changing tool arguments or default captions.

## [0.7.2] - 2026-10-02

### Fixed

- The release preflight reads npm 12's `npm pack --json` report (an object keyed by package name) and `npm view --json` name (a one-element array) as well as npm 11's, so the `v0.7.1` tag stopped before publishing anything.

## [0.7.1] - 2026-10-02

Tagged but not published: the release preflight failed under npm 12 before any package was published. Its changes ship in 0.7.2.

### Docs

- Document five official packages on the site and link their guides from `docs/plugins.md`, including installation, configuration, platform requirements, and security models.
  Add a Traditional Chinese `release-notice` guide and reply-attachment guide.

### Changed

- Official drawing, coding, web, sandbox, and MCP plugins now live under `packages/` as Bun workspaces with their original Git history.
  They remain separate npm packages, checked alongside the core in CI and released in lockstep from one `v*` tag through `publish.yml`.
  The core's npm file list and release tags are unchanged.
- `pi-roundtable-mcp` moves from its standalone repository to `packages/mcp` and jumps from 0.4.1 to lockstep 0.7.0, retaining its public API.
  Both MCP and sandbox now peer on `>=0.7.0 <0.8.0` and test against the live core 0.7.0.
  Shared CI runs MCP's PostgreSQL tests and explicitly opts into sandbox's native Linux Docker integration.

## [0.7.0] - 2026-10-02

### Added

- Turn reply attachments: `ToolTurn.attachFile(file)` queues raw bytes with the agent's reply instead of posting as the bot ahead of it.
  The main entry exports `ReplyFile` (`{ name, data: Uint8Array }`), `attachReplyFile` (`(file): void`) for raw session and Pi package tools, `ReplyFileError`, and frozen `REPLY_FILE_LIMITS` (10 files, 10 MiB each, 50 MiB total per turn).
  Successful `TurnResult` may carry `files`; a successful textless Pi answer with files is posted, while stopped or failed turns discard them.
  Discord sends files through the same agent webhook identity as the text.
  Transient tasks and calls outside a conversation turn refuse attachments.
- `testPlugin` records files attached by `runTool` as `files: { channel, file }[]`; inject a file-capable surface for attachment tests.
  The guide includes the tested `examples/reply-files.ts` plugin.
- `roundtable add plugin release-notice` copies a third official plugin. After the agent server is up it posts once in the coordinator's channel when the running release differs from the one last announced, with the commits the release added since the release last announced, read from a `release.json` that the deploy writes (`{ "sha": "...", "commits": ["subject", ...] }`); it also names the channels whose work the previous shutdown cut short, recorded from the `shutdown` event. It remembers the announced `sha` only after the post succeeds. `createReleaseNotice` takes `releaseFile`, `dataDir`, and `announce` to change where the release is read, where the state is kept, and where the post goes.

### Changed

- Chat surfaces explicitly opt in with `ChatSurface.supportsFiles: true` and must deliver every reply file or reject.
  Existing custom surfaces that handle files must add this flag; absent or false refuses attachment calls and direct `SurfacePort.sendReply` file sends instead of silently losing them.
  Replacement-runtime result files pass the same capability and size checks; custom turn reply callbacks receive the files and own delivery.
- `release-notice` joins `codex-images` and `dice` as a reserved name for `add plugin`, and the usage text lists all three.

## [0.6.1] - 2026-10-02

### Fixed

- `add plugin` and `add package` kept a one-line `plugins` list on one line however long it grew, so a project's `biome check` failed once the line passed 80 columns. A list that would pass 80 columns is now put one element a line, as the formatter writes it; a list already over several lines keeps its layout, and one holding a comment stays as it was.

## [0.6.0] - 2026-10-02

### Added

- `roundtable add package <spec>` installs a Pi package with `bun add`, loads its extensions to find the tools they register, and writes `plugins/<name>.ts` and its test: the plugin lists the package in `piPackages`, selects its tools for every agent turn with `agentSelection`, and requires them with `requiredTools`. It gives no tool a tier, so a tool no other plugin tiers stays the owner's until the operator's `toolTiers` lowers it. It refuses before installing when the plugin file exists or the config cannot take the plugin, and after installing when the package declares no Pi extensions or they fail to load, naming the `bun remove` command.

### Changed

- The `piPackages` guide and its example now say that loading a package only registers its tools: a turn uses the tools it selects, so a plugin also lists them in `agentSelection`. The example used to list `piPackages` alone, which loaded `pi-web-access` without any turn being able to call its tools.

## [0.5.2] - 2026-10-02

### Changed

- `pi-mcp-adapter` is 5.0.0 (was 4.0.0). The core supplies its servers through `createMcpAdapter()`, which 5.0.0 keeps isolated: it reads no `mcp.json` and leaves the host's Pi settings alone. Checked on pi 0.99.2 and 1.0.0 by connecting a session built the way the core builds one to a local MCP server that requires a bearer token: the tool registered, a call returned its result, and the agent directory got no `settings.json`. 5.0.0 declares pi-ai peer support up to 0.99; the checks above ran it on 1.0.0.

## [0.5.1] - 2026-10-02

### Changed

- `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` take `>=0.99.2 <2`, so hosts can run pi 1.0. The typecheck, lint and full test suite pass on pi 1.0.0, and a session built the way the core builds one still connects `pi-mcp-adapter` 4.0.0 to a bearer-protected MCP server and calls its tool. The lockfile stays on 0.99.2, the lowest tested version, and the daily canary now runs the newest 1.x.

## [0.5.0] - 2026-10-01

### Changed

- `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are no longer pinned to one version: they take `>=0.99.2 <1`, so a host picks up a newer model table with `bun update @earendil-works/pi-ai @earendil-works/pi-coding-agent`, or its own direct dependency, without waiting for a pi-roundtable release. Pinned to 0.87.1 before, the host's model list stopped at the models that version knew. 0.99.2 is the lowest version the tests run against, and the lockfile keeps CI on it, so a host that updates further runs on versions this package was not tested with.
- `pi-mcp-adapter` is 4.0.0 (was 2.37.0). Version 2.37.0 declared support for pi-ai up to 0.87 only; 4.0.0 declares 0.99. It stays pinned. Checked by connecting a session built the way the core builds one to a local MCP server that requires a bearer token: the tool registered and a call returned its result.
- A judge or agent model that the newer table lists but the host has no login for fails with the provider's "Provider is not configured" error, where an unlisted model fails with "is not available".

### Fixed

- Agents had no `skill_list` tool, although the `agent_create` description, the built-in `writing-skills` skill and the skill errors all tell them to call it. The `skills` addon now mounts it for agent sessions, at the member tier like its entry in the tool tiers. A host that mounted `skillListExtension` itself for agents (the kit still exports it) now offers the tool twice and should drop its own copy.

## [0.4.0] - 2026-10-01

### Added

- `PluginContext.apiKey(provider)`: the credential the host's model login holds for a provider, such as `openai-codex`, or `undefined` when it holds none. It resolves through the same login the agents use, so a plugin that calls a provider's API needs no login of its own. The value is a secret; keep it out of logs and error messages.
- `testPlugin` and `testHost` take `apiKeys`, the credentials `context.apiKey` returns by provider. Without it every provider reads as having none, whatever login the machine holds.
- `roundtable add plugin codex-images` and `roundtable add plugin dice` copy an official plugin into the project and list it in `roundtable.config.ts`, the way `add plugin` copies the `hello` template. `codex-images` fills the `images` slot through the owner's ChatGPT login and the Codex backend, which OpenAI does not document for this use, so it can stop working without notice. `dice` adds a `roll_dice` tool for dice expressions such as `4d6k3`.
- A documentation site at pi-roundtable.wayneh.tw, in English and Traditional Chinese.

### Changed

- `codex-images` and `dice` are reserved names for `add plugin`: it copies the official plugin for them and keeps the `hello` template for every other name.
- The project `init` writes seeds Guide into the entry channel, so Guide is the coordinator on the first start. Agents that are already stored keep the channel they have.
- `PluginContext` has a new member, `apiKey`; a hand-written `PluginContext` (only the core's own and tests') needs it.
- The READMEs no longer say `/roundtable help` opens a control panel. The core registers `/roundtable schedule list` and `/roundtable schedule cancel` only.

## [0.3.0] - 2026-10-01

Found by running the first consuming host on the published 0.2.1; each item answers one finding of its friction log.

### Added

- `RoundtablePlugin.requires`: the services a plugin reads with `get` in its setup. The host checks the list before any migration or setup and refuses a key no registered plugin provides, one a plugin registered after it provides, and one the plugin provides itself, naming the plugins and the fix.
- `Services.lazy(KEY)`: a function that returns the service once every plugin is set up, for a plugin that needs a service of one registered after it. Calling it during setup throws a `NotLinkedError`; the host refuses to boot, naming the plugin, when no registered plugin provides the key. A plugin no longer has to keep a shared object that the later plugin fills in. `testPlugin` checks `requires` against the `services` option and answers `lazy` readers after setup.
- `pi-roundtable/kit`: `packageDir`, the installed package's folder as Pi's `additionalExtensionPaths` takes it (`packageDir(name, import.meta.url)`; the second argument is the file the package is looked up from, so a host finds its own dependencies even when `pi-roundtable` is linked apart from them), and `serveUnix`, an HTTP server on a unix socket without Bun's idle timeout (`serveUnix(socketPath, fetch, { error? })`). They are the core's own, so a worker process of a host no longer copies them.
- `pi-roundtable/testing`: `partial`, a typed stand-in (`partial<Port>({ ... })`) with only the members the test gives, which names any other member it is asked for; `recordingLogger` with `RecordingLogger` and `RecordedLog`, a logger whose `lines` keep each call's level, fields, and message. Neither needs an `as unknown as` cast.
- A guide section on developing the core and a host together with `bun link`.

### Changed

- `pi-web-access` is a peer dependency (`>=0.35.0 <0.36.0`) instead of a dependency, and a development dependency at 0.35.0. `bun add pi-roundtable` still installs it; a host that depends on its own build of it now has one copy, with no `overrides` entry. A project without it fails at the `modules` plugin's setup with a `PluginError` that names the command to run.
- `pi-roundtable/kit` and `pi-roundtable/discord` are versioned like the main entry: before 1.0, a breaking change to an exported name comes in a minor release and is listed in the changelog. The signature report already guarded every name; the "unstable, not covered by semver" label is gone.
- `Services` has a new member, `lazy`; a hand-written `Services` (only the core's own and tests') needs it.
- The guide's mention of the first consumer by name is gone.

## [0.2.1] - 2026-10-01

### Added

- A Traditional Chinese README, `README.zh-TW.md`, linked from the English one.

### Changed

- `bin` is `src/cli/roundtable.mjs`, without the leading `./`: the npm that publishes from CI warned that it removed the `./` path, though 0.2.0's registry entry kept the `roundtable` command. An export test refuses a `bin` path that starts with a dot.

## [0.2.0] - 2026-10-01

### Added

- Main entry contracts and operational errors: `Admission`, `AgentTurnScope`, `AttachmentRef`, `BackgroundTurn`, `ChannelKey`, `ConversationPort`, `DefineOverrides`, `DrainOptions`, `EventSink`, `HoldCheck`, `HoldContext`, `HttpRoute`, `ImageDrawer`, `InboundMessage`, `Judge`, `JudgeError`, `JudgeModel`, `LinkedSessions`, `ListenerAddress`, `ListenerConfig`, `Locale`, `LogEntry`, `LogFn`, `Logger`, `MigrationError`, `Pronouns`, `ProviderError`, `Providers`, `QueuePort`, `ReferenceImage`, `ResolvedProviders`, `ScheduledOutcome`, `SessionContext`, `SessionPlan`, `SessionToolSnapshot`, `ThinkingLevel`, `TierConfig`, `ToolSelection`, `ToolTierTable`, `ToolTiers`, `TransientTask`.
- Testing fixtures: `OWNER_SPEAKER`, `TEST_GUILD`, `TestStore`, `describeDb`, `fakeThreads`, `openTestStore`, `silentLogger`, `testDatabaseUrl`, `useTestLocale`.
- The unstable-before-1.0 `pi-roundtable/kit` entry for owner commands, claims, and naming existing core services.
  Its helpers and their supporting data types are `AUTO_THINKING`, `AgentCategory`, `AgentChannelLookup`, `AgentChannels`, `AgentError`, `AgentModels`, `AgentOps`, `AgentPost`, `AgentTurnRunner`, `Approval`, `AskOption`, `AssistantLike`, `Backlog`, `CategoryLayout`, `ChannelMessage`, `ChannelQueue`, `ChatSurface`, `ChoiceAnswer`, `ChoiceQuestion`, `DashboardBoard`, `DelegationWorker`, `DispatchThread`, `DispatchThreads`, `DispatchThreadsOptions`, `GroupMessage`, `ModelRef`, `OutboundReply`, `OwnerAnswer`, `OwnerIdentity`, `OwnerNotifier`, `OwnerPrompts`, `OwnerQuestion`, `ScoreQuestion`, `SpeakerFacts`, `SpeakerPolicy`, `THINKING_LEVELS`, `ThinkingPicker`, `ThreadHost`, `YesNoQuestion`, `attachmentsOf`, `channelSegment`, `discordKey`, `formatModelRef`, `headline`, `lastAssistant`, `outcome`, `ownerAttachmentDir`, `parseModelRef`, `quietLinks`, `settleTurn`, `splitReply`, `textOf`, `thinkingLabel`, `toolError`, `toolText`, `withAttachmentsBlock`, `withReference`.
- The migration ledger: a migration's `runs` is `"once"` (the default) or `"every-boot"`, and the host records each `once` migration in the table `roundtable_migrations` under the id `<plugin>/<name>`, created by the host itself. A `once` migration runs in its own transaction under an advisory lock with its ledger row written in that transaction, so a failed migration records nothing and two hosts starting together apply it once; an `every-boot` migration runs each start, unrecorded, and must be idempotent, as every migration had to be. A start logs one `migrations` line (ids applied now, number skipped, number every-boot), a migration that fails is named by its id, and `roundtable doctor` runs the same runner in a rolled-back transaction. `migrateDatabase(url, plugins)` and `MigrationReport` are in the main entry: they run plugins' migrations over a URL with the ledger and close their connection, for a test or a script.
- `Logger` is core's own structural interface (`debug`, `info`, `warn`, `error`, `fatal` as `LogFn`, and `child(fields)`), which a pino logger satisfies as it is, and `LogEntry` (one line as pino writes it) is in the main entry. Every plugin's `context.logger` is a child that adds `plugin: <name>` to its lines, and the error report head shows the plugin next to `app` and `module`; the fingerprint of an error is unchanged.
- `DefineOverrides.errorSink(entry)`: a plain function that also receives every `error` and `fatal` line of the logger `defineRoundtable` builds, after the ops agent's report (`config.ops`). It must not throw. A logger passed as `DefineOverrides.logger` is the caller's own, and forwards its error lines itself.
- The `requiredTools` contribution: the tool names startup refuses to run without, besides those each session tool requires, merged over plugins with each name once (`LinkedSessions.requiredTools`). A plugin that owns the owner's conversations contributes it with the `"owner"` persona.
- Test fidelity: `testHost` with `TestHost` and `TestHostOptions` boots the built-in plugins and yours over the test database with Discord and the runtime standing in, and returns the probe's `context`, the `conversations`, the slash commands `added` and `composed()`, the session tools of an owner or agent scope, a real `sessionContext`, and `stop()`; `sessionTools` lists the tools of any session extension, including one that also registers commands or event handlers. `testPlugin` gains the `holds` result (the plugin's hold rules chained as the host links them), the `owner` and `forwardJoinMs` options, the real `BACKGROUND_TURNS` by default, the real confirmation judge as `AGENTS.approvals` once `AGENTS` is given and a judge provider is, and the agent server's own claim when `AGENTS` is given a `team`. `holdChain` is in `pi-roundtable/kit`, and `useEagerCatalog` and `eagerText` are in `pi-roundtable/testing`: the probe that proves a value was not built from the catalog before the host applied its environment.
- Socket permissions: a unix-socket `ListenerConfig` takes `mode` (the socket file's permission bits), and the configuration's `http.socketMode` sets it for the `public` listener. The default is `0o660`, so only the socket's owner and group connect; a proxy that runs as a user outside that group needs `0o666` set explicitly.
- Route errors: a route whose handler throws or rejects answers `500 Internal Server Error` with that fixed body and the listener keeps serving. The host logs one error line with the route's `name` and `listener`, never the request URL, since paths may hold tokens. The listeners' servers also answer errors raised outside a route with the same 500.
- Declaration-signature and type-leak baseline checks, alongside parser-based runtime/type export snapshots.
- A guide entry index, context service types, database/locale fixture notes, and tested consumer compiler requirements.
- `PluginContext.env` (`HostEnv`: `locale`, `timeZone`, `now()`) and the `environment` host option (`HostEnvironment`: locale, time zone, assistant name, root command, Pi agent directory), so a plugin reads its own host's time zone and locale.

- Neutral hooks and keys, replacing the built-in-shaped ones (see Removed): `Service.startInBackground`, the `serviceStarted` event with `ServiceStartedEvent` and `ServiceStartOutcome`, `ChannelClaim.stop`, the agent server's names `AGENT_SERVER_PLUGIN`, `AGENT_TEAM_SERVICE` and `AGENT_SERVER_PRIORITY`, `parseChannelKey` and `channelKey` (`channelKey(surface, id)`) for `<surface>:<id>` channel keys, and `ConversationKind`, which is any string.

- The chat-surface slot: a plugin contributes `surfaces`, each a `ChatSurface` for the channel keys of one prefix (`surface`, `start(deliver)`, `sendReply`, and optionally `stop`, `startTyping`, `showStop`, `react`, `unreact`, `prompts`), and calls them through `PluginContext.surfaces`, a `SurfacePort` that picks the surface by a key's prefix (`of`, `sendReply`, `startTyping`, `showStop`, `react`, `unreact`, `prompts`; calls during setup throw `NotLinkedError`).
  The host starts each surface as a service named `surface:<prefix>` before its plugin's own services, refuses two surfaces with one prefix, and logs and drops a message delivered under another prefix.
  The main entry now also names `OutboundReply`, `OwnerPrompts`, `Approval`, `AskOption`, `OwnerAnswer`, and `OwnerQuestion`, which a surface's methods use; they moved there from `pi-roundtable/kit`, together with `ChatSurface`.
  `examples/fake-surface.ts` is an in-memory surface for tests and a model for a real one.
- The agent server asks the owner for approvals and `ask_user` answers through `context.surfaces.prompts`, so they work in a channel of any surface that has `prompts`; before, only Discord's channels had them.
- The runtime slot: `Providers.runtime` takes a `RuntimeFactory` (`(deps: RuntimeDeps) => AgentRuntime`), and a plugin that fills it replaces the whole conversation runtime (agent turns, the owner's conversations, steering, held actions, transcripts) in place of Pi. The agent server builds the Pi runtime only when no plugin fills the slot, so a host that fills none is unchanged. `RuntimeDeps` hands the factory `logger`, `env`, `owner`, `sessions()`, `toolTiers`, `prompts`, `agents` (`AgentSessions`), `confirmations` (`HeldActionStore`), and `judge`.
  `AgentRuntime` (the main entry's now, with `ContextUse`) has the methods the agent team calls besides the turn: `heldActions`, and the optional `contextUsage`, `preflight`, and `dispose`; the agent server's preflight and its `runtime` service call the optional ones. The unknown-slot refusal names `runtime` among the valid slots.
  `AgentRunError` is exported, `TurnResult.error` is an `Error`, and the turn types a runtime author needs moved to the main entry from the kit: `AgentRuntime`, `AgentSessions`, `AttachmentFailure`, `ContextUse`, `HeldCall`, `LoadedSkill`, `ModelImage`, `PendingConfirmation`, `StoredAttachment`, `TranscriptEntry`, `TurnAttachments`, `TurnRequest`, `TurnResult`, and `TurnSelection`.
- Personas: a plugin contributes `personas` (`Persona`: `{ kind, prompt() }`), the system prompt of every non-agent conversation of one kind, and `LinkedSessions.persona(kind)` looks one up. `TurnRequest.kind` names the conversation's kind (`"owner"` when absent), and the Pi runtime picks the persona when it makes the session. Two personas of one kind, and the reserved kind `"agent"`, are refused when the host starts, naming the plugins; a turn of a kind with no persona is refused naming `personas` instead of running with the owner's prompt; `"owner"` keeps the host's `ownerSessions.persona`, and a contributed `"owner"` persona is refused on a host that sets one.
- `context.turns` (`ConversationTurns`, with `ConversationTurnInput`): `run({ channel, kind, text, speaker, attachments?, selection?, steerable?, interactive?, confirmed?, reply? })` runs one turn of a conversation a claim owns, over the runtime and the surfaces: it shows typing and the stop control, emits `turnStarted` and `turnEnded`, settles a thrown runtime into a failed result, and posts the answer or a failure or stopped notice through the surface unless `reply` is given. Calls during `setup` reject with `NotLinkedError`.
- `testPlugin` options `surfaces` (injected chat surfaces), `core` (`TestCore`: the parts of `context.core` the plugin reads; an ungiven member throws naming the option), `conversations` (overrides), and `turns`, and the result fields `conversations`, `turns`, `surfaces`, and `runtime` (the runtime the plugin's `runtime` provider built from stand-in dependencies). `runTool(name, args, { speaker, channel })` runs in the given channel. `conversations` now routes to the claims of the plugin under test, so a message a surface delivers reaches them.
- `examples/echo-runtime.ts` (a plugin that fills the `runtime` slot) and `examples/study-room.ts` (a conversation kind with its own persona, run through `context.turns`), each with a test that uses only the public entries.
- `activeToolsExtension` in `pi-roundtable/kit`, taking a function that returns the tool names: the extension that pins a session's active tools before every run, the one the core places last in each session, for a runtime or worker of your own.
- Background targets: a plugin contributes `backgroundTargets` (`BackgroundTarget`: `name`, `label(locale)`, and optional `schedules` and `delegation` limits), which say whose turn a schedule or a delegated task is and how much may be scheduled or delegated for it. `ConversationPort.target(name)` reads one when it is used, the router skips a turn whose target no plugin contributes (`no plugin contributes the background target "<name>"`, recorded as the schedule's last status, never falling back to another target), and two targets of one name are refused at start, naming both plugins. The agent server contributes `OWNER_TARGET` (name `"owner"`, exported from the main entry), and its claim answers only that target. `examples/support-desk.ts` is a plugin with a target of its own, with a test.
- Keyed services: a plugin provides a service other plugins read, and a plugin replaces a built-in one.
  `serviceKey` (`serviceKey(id)`) makes a typed name, `ServiceKey`, and `PluginContext.services` (`Services`) has `get(KEY)`, `find(KEY)` and `provide(KEY, value)`; `RoundtablePlugin` has `provides` (the keys its setup provides, which the host checks are provided once setup returns) and `replaces` (the built-in services it takes over: the host drops the plugin that provides them and sets the replacement up where it stood).
  `get` of a key not provided yet names the key and the plugin to register first, `find` is `undefined` when no registered plugin declares it and throws when one declares it but has not set up yet, `provide` is refused for a key the plugin does not declare, after setup, and twice, and the host refuses two plugins that declare one key, a replaced key nobody else provides, two replacements of one key, a replacement that does not list the key in `provides`, and a partial replacement, where the dropped plugin also provides a key the replacement does not replace.
  The built-in plugins provide `AGENTS` (`AgentServer`: `team`, `directory`, `runtime`, `approvals`, `avatars`), `SKILLS` (`SkillRegistry`), `SCHEDULES` (`ScheduleStore`), `MEMORY` (`MemoryStore`), `BACKGROUND_TURNS` (`BackgroundTurns`) and `DELEGATION` (`Delegator`), each a port interface that an object with the same methods satisfies, so a stranger can provide or fake one without a class.
  The main entry also names the ports' parts and data types: `AgentChange`, `AgentDirectory`, `AgentServer`, `AgentTeam`, `AvatarMode`, `AvatarStudio`, `DelegationRequest`, `Memory`, `MemoryKind`, `MEMORY_KINDS`, `PromptMemory`, `SpeakerMemory`, and, moved from the kit, `Agent`, `AgentGroup`, `AgentStatus`, `GroupStatus`, `NewSchedule`, `Recurrence`, `ResolvedSkill`, `Schedule`, `ScheduleChange`, `SkillCatalogEntry`, `SkillSet`, `SkillSource`, `TeamAgentStatus`, `TeamStatus`, `ThinkingSetting`, `Weekday`; `TIERS` is exported (frozen), so `Tier` names a public value.
  The Discord connection's key is in the Discord entry: `DISCORD` and `DiscordServices` (`connection`, `commands`, `guard`, `threads`) are in `pi-roundtable/discord`.
  `examples/shared-services.ts` provides, reads and replaces a service, with a test.
- `testPlugin` option `services` (a list of `servicePair(KEY, { ... })`, replacing `core`; an ungiven member throws naming the option, a service not given reads as absent to `find` and `get` says to give it), and the testing entry exports `servicePair`, `ServicePair` and `FakeThreadHost`.
- `DelegationJob` and `DelegationOutcome` (in the main entry), the job a `Delegator` runs and how it ended.

- The unstable-before-1.0 `pi-roundtable/discord` entry, the one built on discord.js types (a test checks that the main and kit declarations reach none; `pi-roundtable/testing` names a few, through `testHost`'s composed commands: `ComposedCommands`, `CommandGuard`, `InteractionModule` and `RootOption`): `DISCORD` (`DiscordServices`: `connection`, `commands`, `guard`, `threads`), `DiscordConnection`, `CommandRegistrar`, `CommandGuard`, `CommandGuardOptions`, `commandGuard`, `composeCommands`, `ComposedCommands`, `InteractionContribution`, `InteractionModule`, `RootOption`, `CommandRoot`, `ownerRootCommand`, `ownerCommandModule`, `OwnerCommandHandlers`, `groupOption`, the panel helpers `OwnerFacingError`, `PanelContent`, `ephemeralPanel`, `ownerPanel`, `ownerPanels`, `plain`, `replyWithPanels`, the agent panel `agentPanel`, `AgentPanel`, `AgentPanelMessage`, `AgentPanelOptions`, and the channel-operation tables `CHANNEL_OPERATIONS`, `CHANNEL_TOOLS`, `ChannelExecutor`, `ChannelInfo`, `ChannelOperation`, `ChannelTool`, `ChannelToolError`, `DISCORD_ADMIN_TOOLS`, `ManagedChannel`, `OPERATION_PERMISSIONS`, `OwnerOperations`, `fetchManagedChannel`, `isChannelOperation`, `operationLabel`, `parseChannelTool`.
  A plugin adds slash commands from `setup` with `context.services.get(DISCORD).commands.add({ module, rootOptions })`. The Discord plugin collects them and composes them under the root command in its preflight, so a duplicate command name, a module that registers the root, or a subcommand added twice stops the start before any service starts; `commands.add` after that preflight throws a `PluginError`. `CommandGuard.isOwner` takes anything with `user.id`, so a test needs no cast.
  A plugin that only reads a service in `setup` and returns `{}` (such as one that only adds commands) is no longer refused as adding nothing.
- `agentPanel({ guard, agents, skills? })`: the agent's profile panel with its buttons and form, owning its custom-id prefixes (`roundtable:agent:` and `roundtable:agent-modal:`, unchanged, so panels already posted keep working), the owner check, and the deferred reply of the form.
- `discord.refusalHint` in the configuration (`DiscordOptions.refusalHint`): text appended as it is to the refusal a non-owner gets from the root command. The core's Chinese refusal no longer carries a sentence about one host's dice commands; a host that wants such a sentence passes it.
- The agent server publishes the avatar studio as `AgentServer.avatars` and builds it itself (from `config.http.publicUrl` and `config.avatar`).
- Testing: `fakeDiscord` and `FakeDiscord`, the `DISCORD` service for a plugin that adds slash commands (records `commands.add`, gives a guard, composes the tree).

- **The internal sweep (the last of the unreleased public-surface work):** what the host repository's own code imported from its local `pi-roundtable/internal` mapping has a public home or left the core, so the core's public entries are what a stranger uses to build the same things.
  The main entry names `ConfigError`, `DelegationError`, `MemoryError` and `ScheduleError`, the errors the public ports throw, `NO_ATTACHMENTS` beside `TurnAttachments`, and `THE_SPEAKER` beside `Speaker`; the testing entry names `TestLocale`.
  The kit gains the helpers for running a Pi session of your own: `mcpExtension` and `VirtualServer`, `mcpAdapterExtension` and `McpEndpoint`, `readAttachmentExtension`, `promptSlot` and `PromptSlot`, `workTimeout`, `approvalCard`, `canonicalJson`, `runWorkerTask`, `archiveSessions`, the host-shell `SHELL_TOOLS` and `shellHoldRule`, the tool helpers `textToolsExtension`, `requiredString`, `stringList`, `TextToolDef` and `ToolInput`, and `channelQueue` (a queue of your own, apart from the host's).
  It also has the pieces for mirroring a built-in tool in a worker that cannot reach the host: `DELEGATE_TOOL`, `DELEGATE_TOOL_SPEC`, `SCHEDULE_TOOLS`, `isScheduleTool`, `callScheduleTool`, `scheduleToolSpecs`, and the types `ScheduleToolContext`, `ScheduleToolName`, `ScheduleToolSpec` and `ScheduleToolWording`.
  The effort policy is a public knob: `effortJudge` (with `EffortBrief`, `EffortJudgeOptions`, `EffortLevel`, `EffortPicker`, `PreviousTurn` and `JUDGE_WORK`), which picks a turn's thinking level from a message.
  Also in the kit: `thinkingLine` and `zonedStamp` (presentation), `checkRepoName`, `SKILL_LIST_TOOL` and `skillListExtension` (skills), and `searchTerms` (memory).

### Removed

**Breaking for 0.1.0, so this is 0.2.0.**
A plugin that still has one of these fields is refused when it is defined or when the host starts, with an error that names the replacement.

- `RoundtablePlugin.useCommands(composed)`: the composed slash commands go to the Discord plugin's surface, not to a plugin. Add commands from `setup` with `context.services.get(DISCORD).commands.add(...)` (see the slash-command entry below).
- `RoundtablePlugin.agentServer()` and the `agentServer(outcome)` event handler, with `AgentServerOutcome`: give a service `startInBackground` and hear how it ended in `serviceStarted`, which names the plugin and service (`AGENT_SERVER_PLUGIN`, `AGENT_TEAM_SERVICE`).
  The host runs every service's background start after all `start`s and the HTTP listeners, without holding up the boot; a failure is logged and heard as `failed`, and does not stop the other services.
- `RoundtablePlugin.stopTurn(channel)`: put `stop(channel)` on the `ChannelClaim` that owns the channel. The router asks only the owning claim, and a claim without `stop` means `false`.
- `PluginContext.core` and its types `CoreAccess`, `CoreServices`, `CoreStores`, `CoreDiscord` and `CoreAgents`: read a service with `context.services.get(KEY)` (`AGENTS`, `SKILLS`, `SCHEDULES`, `MEMORY`, `BACKGROUND_TURNS`, `DELEGATION`, and the Discord entry's `DISCORD`) and provide one with `services.provide`.
  Reading `context.core` throws a `PluginError` that names `context.services`, at the plugin's first read, instead of returning `undefined`.
  The stores bag is gone: each store belongs to the plugin that owns its table, and the held-action, skill and agent stores are not published (the agent server reads them; `AGENTS.directory` is the read-only half of the agents store).
- The `testPlugin` option `core` and its type `TestCore`: use `services` with `servicePair`.
- Kit: the class types of the built-in services (`AgentStore`, `AgentTeam`, `AvatarStudio`, `BackgroundTurns`, `ConfirmationJudge`, `Delegator`, `OwnerMemoryStore`, `PendingConfirmationStore`, `PiAgentRuntime`, `ScheduleStore`, `SkillRegistry`, `SkillStore`), replaced by the main entry's port interfaces where a plugin needs them, and the `*Options` types of those classes (`AgentTeamOptions`, `AvatarStudioOptions`, `BackgroundTurnsOptions`, `ConfirmationJudgeOptions`, `DelegatorOptions`, `PiAgentRuntimeOptions`, `SkillRegistryOptions`, `TeamTurnsOptions`), with `Detached`, `SkillEntry` and `SkillGroup`.
- **Renamed, for the unreleased types:** `OwnerMemoryStore`, `OwnerMemory`, `OwnerMemoryKind`, `OwnerPromptMemory` and `OWNER_MEMORY_KINDS` are `MemoryStore` (with `forSpeaker`, returning `SpeakerMemory`), `Memory`, `MemoryKind`, `PromptMemory` and `MEMORY_KINDS`; the tables and the tools' names do not change.
- Kit: `conversationKind()` and its closed `ConversationKind` (`"owner" | "party" | "agent"`); a conversation kind is any string that a claim's `startFresh` returns, and a plugin narrows the kinds of its own claims itself. `SessionContext.kind` is a `string`.
- Kit: `channelKey(channelId)` is `discordKey(channelId)`, because the main entry's `channelKey` builds a key on any surface.

- Addons: memory, skills, and Discord administration are built-in plugins of their own (`memory`, `skills`, `discord-admin`) that `defineRoundtable` adds unless the configuration switches them off with `memory: false`, `skills: false`, or `discord: { admin: false }`; all three are on by default. A switched-off addon contributes no tools, no prompt block, and no service, and its tables and rows are left untouched: `services.find(SKILLS)` and `find(MEMORY)` are `undefined`, the agents carry no skills, `agent_get` has no skills line, `agent_create` leaves out its `skills` parameter and refuses a call that passes some with an error saying skills are off, and `services.get` of an addon key fails naming the switch.
- `Contribution.toolTiers` (`Record<string, Tier>`): a plugin names the tier of each raw session tool it registers, as `defineTool` already does for its own; the operator's setting still wins and two plugins naming one tool are refused.
- `serviceKey(id, { absent })` and `ServiceKey.absent`: what a read of a service nobody provides says to fix it; `MEMORY` and `SKILLS` name their switches.
- `SkillRegistry.attach(agent, add, remove)`, which the agent team uses to give a new agent its skills.
- **Breaking (slash commands move under the Discord surface):** `Contribution.interactions`, `RoundtableOptions.commands`, `ChatSurface.useCommands` and the host's composition of commands are gone; the main entry no longer names `CommandRoot`, `ComposedInteractions`, `InteractionContribution`, `InteractionModule` or `RootOption` (they are in `pi-roundtable/discord`). A plugin that returns `interactions` from `setup`, a surface that has `useCommands`, and a host given `commands` are each refused with an error that names `context.services.get(DISCORD).commands.add(...)`, as `RoundtablePlugin.useCommands` is.
- **Breaking for the unreleased types:** the kit's Discord names moved to `pi-roundtable/discord` or were dropped: `DISCORD` and `DiscordServices` (now `connection`, `commands`, `guard`, `threads`; the owner's cards and the avatar studio are no longer published), `OwnerGuard` (now `CommandGuard`, a port), `ChannelExecutor`, `ChannelInfo`, `ChannelOperation`, `OwnerCommandHandlers`, `PanelContent`, `OwnerFacingError`, `groupOption`, `ownerCommandModule`, `ownerPanel`, `ownerPanels`, `ephemeralPanel`, `replyWithPanels` and `plain` moved; `DiscordSurface`, `DiscordSurfaceOptions`, `OwnerCards`, `OwnerCardsOptions`, `CardChannel`, `CardMessage` and `CardPayload` are gone (the owner's cards stay private to the Discord plugin and answer held actions through `context.surfaces.prompts`).
- `DiscordSurface.useCommands` is `setCommands` and is not published. `DiscordConnection` returns the public `AgentChannels`, `DashboardBoard`, `ThreadHost` and `OwnerOperations` (was `OwnerDiscord`) instead of the Discord classes, which removes five leaks from the type-leak baseline (now `ErrorReporter` only).
- `DISCORD_OWNER_TOOLS` is `DISCORD_ADMIN_TOOLS`.

### Changed

- **Breaking for the unreleased types:** `DefineOverrides` has five fields: `modelRuntime`, `logger`, `errorSink`, `listeners` and `aborted`. `errorReporter` is gone (set `config.ops` for the ops agent's reports, and `errorSink` for your own), `options` is gone (`options.listeners` is `listeners`, which adds listeners to the one `config.http` names, and `options.aborted` is `aborted`; the other host options come from the config), `modules.agentChannelOf` is gone (the modules read `AgentTeam.channelOf` from `AGENTS` when a tool runs), and `agentServer.ownerSessions` is gone (contribute `personas: [{ kind: "owner", prompt }]` and `requiredTools` from the plugin that owns the owner's conversations; the agent server no longer refuses a contributed `"owner"` persona). With no `"owner"` persona the owner's conversations start with an empty system prompt, as before.
- **Breaking for the unreleased types:** `AgentServerOptions`, `ModulesOptions`, `ErrorReporter`, `ErrorReportDelivery` and `ErrorReporterOptions` are no longer public: they were named by `DefineOverrides` only, and the public type-leak baseline is now empty. `Logger` is no longer pino's type, and `LogEntry` moved from `pi-roundtable/kit` to the main entry.
- **Breaking for the unreleased types:** migration names are unique inside a plugin, not across plugins (the ledger id is `<plugin>/<name>`), and `MigrationError.migration` and the start's error name that id. The same name in two plugins is allowed; a repeated id is still refused.
- The upgrade adds the ledger to a database that already ran the migrations without special handling: no id is recorded, so each `once` migration runs once more, as every start did before, and is recorded. **Rollback note:** a build from before the ledger ignores the table and runs every migration at every start; rolling forward again finds its ids recorded, so a `once` migration that fixes rows (for example one that gives rows written before speakers or guilds existed their owner or guild) does not run again over rows an older build wrote in between. Mark such a migration `runs: "every-boot"` if a rollback must converge.
- The host repository's tests use `migrateDatabase` where they migrated by hand, and its two import scripts read the ledger instead of migrating.
- **Breaking for the unreleased types:** the skills are provided by the new `skills` plugin, not by the agent server. the agent server takes no skills option (the paths are the `skills` config key's), the agent server provides only `AGENTS`, and the agent team reads the registry with `find(SKILLS)`, so the skill tools are the `skills` plugin's agent session tools (`skill-tools`) and its `agentSelection`, no longer part of `agent-tools`. `memoryPlugin` takes the `owner` and adds the `owner-memory` session tool, and `modulesPlugin` no longer adds that tool or `discord-admin`, which is the new plugin's.
- **Breaking for the unreleased types:** the core's tier table (`CORE_TOOL_TIERS`) names only `ask_user`, `compact_session` and `read_attachment`; the agent, schedule, delegation, web, skill and memory tools are declared by the plugin that adds them, with the same tiers. The Discord tools stay with the owner, as before.
- The order of the core's migrations is now memory, schedules, skills, held actions, agents, because the skills plugin sits before the agent server that reads its registry; all of them run before any setup and none touches another's tables. The stored data, the tool set, and each tool's tier under the default configuration are unchanged (a test records them for the owner's session, an agent's, and a group seat).
- The legacy skill kind `UPDATE` is no longer in the core's skill migrations; a host that still has skills stored under that kind converts them in a migration of its own, after the core's.
- **Breaking for a plugin that named it:** the built-in plugin list of `defineRoundtable` gains `discord-admin` (after `modules`) and `skills` (after it, before `agent-server`).

- **Breaking (the unreleased `InboundMessage` fields, and the second parameter's name of the published `ChannelClaim.owns`):** `InboundMessage` has neutral fields in place of Discord's. `guildId` is `space`, the server or workspace the channel belongs to; `webhookId` and `ownWebhook` are `integration?: { id, own }`, for a post by an integration such as a Discord webhook and whether it is the assistant's own voice; and `forwarded.channelMention` (`"<#id>"`) is `forwarded.source`, the forwarded-from channel's key. `ChannelClaim.owns(channel, guildId)` is `owns(channel, space)`; the parameter is positional, so callers do not change.
- **Breaking for the unreleased types (and the published `TurnEvent`):** `TurnEvent.agent` is optional and `TurnEvent` has `kind` (`"agent"` for an agent's turn, else the kind of a turn run through `context.turns`), so `turnStarted` and `turnEnded` also report those turns. `CoreAgents.runtime` is typed `AgentRuntime`, not the concrete `PiAgentRuntime` (the Pi runtime when no plugin fills the slot). `SessionContext.kind` is the turn's kind for a non-agent session, not always `"owner"`.
- `testPlugin`'s errors say what is possible inside it: `core service <name> is not provided yet` tells you to pass it in the `core` option instead of registering a built-in plugin, and a `conversations` call made from a handler no longer says it is "not during setup", since the harness links them.
- `DiscordSurface` implements `ChatSurface` (`surface = "discord"`, with `prompts`) and the Discord built-in contributes it: the `surface` service is now `surface:discord`, and a new `threads` service sweeps the dispatch threads once it has started.
- The agent server owns only `discord:` channel keys. A key of another surface, such as `mcp:<id>` on a host that claims those keys, whose id equals an agent's channel id was taken by the agent server at priority 100, because its ownership check sliced `discord:` off any key; it is now left to the claim that owns that surface.
  `AGENT_SERVER_PRIORITY` (100) is exported and documented: a claim on `discord:` keys with a lower priority is beaten in the agents' channels and in the rest of the agent guild.
- The stop button core posts is answered by the Discord built-in (owner only, through `conversations.stop`), so it works on a host that does not add its own handler.
- An unknown provider slot passed to `providers` is refused, naming the valid slots, as an unknown part of `setup` already was.
- Trim source tests and test-only helpers from npm contents; retain example tests embedded by the guide, excluding the guide verifier itself.
- Freeze shared protocol constants and publish readonly types; process-wide locale and time-zone setters are not exported by main, kit, or testing.
- Keep production integration inspectors out of testing and host-assembly values out of the kit.
- Without an `images` provider, agents get an avatar generated from their display name and the assistant's icon (a colour from the display name and the initial of the agent's name, always a Latin letter or digit, in a 512 px PNG served by content hash), instead of all sharing the neutral one. They are no longer offered drawing: `agent_create` has no `avatar_prompt`, `agent_avatar` is not registered, agents' prompts and `agent_get` leave avatar prompts out, and the profile panel says no image provider is configured instead of offering to redraw. Startup makes the missing pictures and logs one info line, not a warning per agent on every boot. A host with an `images` provider behaves as before.
- `roundtable doctor` has an `image provider` check, after `plugins`: it states whether a plugin fills the `images` slot and, without one, how to provide it; it is never a failure.
- `PluginContext.providers` also has `filled`, the set of slots a plugin fills, so a default can be told from a provider without calling it.
- **Breaking for the unreleased types:** the core no longer knows owner profiles. A held action carries an opaque `selectionId` (the `id` of the `TurnSelection` whose turn held it) in place of `PendingConfirmation.profile`; the core stores it and the caller resolves it when the owner confirms. `ConfirmationGate.beginTurn(selectionId, confirmed, addressee?)` takes that id, and a call held outside a turn throws instead of being stamped `"general"`.
- Held actions are stored in a new table, `held_actions(channel_key, selection_id, held_at, calls)`, which the core creates on every boot. A host upgraded from an earlier build keeps its old `pending_confirmations` table, which the core no longer reads; copy its rows across (`selection_id` takes the old `profile` value) in a migration of your own, after the core's.
- **Breaking for a plugin that named it:** the core extension `profile-tools` is named `active-tools` (a plugin may not take either name); `CoreExtensions.profileTools` is `activeTools`.
- Log and error wording: the stale-session reason `connectors changed` is `session tools changed`, the startup error `profile tools are not registered` is `required tools are not registered`, `profile tools missing; running without them` is `selected tools missing; running without them`, and the turn log's `profile` key is `selection`.
- **Breaking for the unreleased types:** the core no longer knows party channels. `BackgroundTurn.mode` (`"owner" | "party"`) is `BackgroundTurn.target`, a `string` naming a contributed `BackgroundTarget`; `Schedule.mode` and `NewSchedule.mode` are `target`, and `DelegationJob.mode` is `target`. The `schedules.mode` column keeps its name and its values (`"owner"`, `"party"`), which are now the target names, so no stored schedule is rewritten. The schedule tools' limits come from `ScheduleToolContext.target` (replacing `mode` and `SCHEDULE_LIMITS`), the delegator's running limit from `DelegatorOptions.targets(name)` (replacing the built-in table), and a target without `schedules` or `delegation` refuses both. The agent server's claim used to skip only `"party"` turns and now answers only `"owner"`, so a turn for any other target never reaches the owner's tools. The `/<root> schedule` list names a schedule's target by its label, or by its name when no plugin contributes it.
- The built-in plugin `stores` is split by feature, so one store can be replaced: `memory` (migrations and `MEMORY`) and `schedule-store` (migrations and `SCHEDULES`) come first, and the agent server now owns the tables it reads: held actions, and agents and groups; the skills have their own addon.
  The tables and the tools are unchanged.
- The default delegation worker is `WebResearchWorker` (it was named for one model), in `web-research-worker.ts`; it is not exported.
- **Breaking for the unreleased types:** `scheduleToolSpecs({ locale, timeZone })` takes the locale and the time zone its descriptions are written in, and `zonedStamp(date, timeZone)` (the kit's, a stamp in the zone you give) takes the zone, instead of both reading the process-wide setting. A worker of your own no longer sets the process's locale and time zone to get its tool descriptions in the wording and zone it wants. `useTestLocale({ locale, timeZone, assistant, root })` takes the same, with the neutral UTC and English defaults when called with nothing.
- The transitional local `pi-roundtable/internal` mapping is removed: the tsconfig path, `src/internal/`, and its guard test are gone, and a boundary test fails on any import of it and if the directory returns. It was never an npm export or part of the tarball, so a package consumer sees no change. `CardCadence`, `Expression`, `CardRenderError`, `packageDir`, `serveUnix` and the environment-variable parsers for tier members and tool tiers are no longer the core's: they moved into the host repository's own code, and the core does not export them.

### Fixed

- `defineRoundtable` no longer sets the process's locale, time zone, or `PI_CODING_AGENT_DIR`; `Roundtable.run()` applies the host's `environment`, so defining a second host no longer changes the first's.
- The root command `defineRoundtable` gives the host is built when `run()` applies the environment, so its description is in the host's language; `RoundtableOptions.commands.root` may be a `CommandRoot` or a function that returns one.
- One host runs per process: a second `run()` is refused with the fix. A failed `run()` stops what it started, closes the pool, and rethrows, and the same host may retry (tool tiers are declared idempotently per plugin).
- The shutdown drain waits on the host's own channel queue, not only on services, and the Discord built-in no longer contributes a `channel-queue` service.
- `shutdown()` runs once however many signals arrive and returns the exit code (non-zero when something did not stop or the boot had failed); only `listen()` exits the process, and the command line exits non-zero on a failed start.
- Importing `pi-roundtable/testing` in CI without a database URL no longer throws; repository CI requires its PostgreSQL URL in the workflow instead.
- Record the already-published main/testing API and CLI under 0.1.0 rather than presenting them as unreleased additions.

## [0.1.0]

### Added

- Main entry exports: `AgentSeed`, `ChannelClaim`, `Contribution`, `DefinedRoundtable`, `EventHandlers`, `HoldRule`, `InteractionContribution`, `Migration`, `NotLinkedError`, `PluginContext`, `PluginError`, `PromptSection`, `PromptTurn`, `Roundtable`, `RoundtableConfig`, `RoundtableOptions`, `RoundtablePlugin`, `Service`, `SessionTool`, `Speaker`, `Tier`, `ToolContribution`, `ToolRefusal`, `ToolSpec`, `ToolTurn`, `TurnEndEvent`, `TurnEvent`, `definePlugin`, `defineRoundtable`, `defineTool`.
- Testing entry exports: `RecordedEvent`, `TestPluginOptions`, `TestPluginResult`, `testPlugin`.
- The `roundtable` command: `init [dir]` creates a project from `templates/`, `doctor` checks Bun, `.env`, the configuration, PostgreSQL, Discord (token, guild, intents, entry-channel permissions), the model login, and the public URL and says how to fix each failure, `start` runs the checks that need no network and then the bot, and `add plugin <name>` renders `plugins/<name>.ts` and its test and lists the plugin in `roundtable.config.ts`.
- `@babel/parser` as a dependency, for the syntax-tree edit `add plugin` makes to `roundtable.config.ts`.
- `SessionTool.engine`: a compaction-phase tool names the `details.engine` its compactions record, so the compaction tiers tell its compactions from Pi's own. `defineRoundtable` refuses a compactor without one.
- The judge's yes-or-no question is `YesNoQuestion` (`type: "yesno"`), asked with `Judge.askYesNo`, next to `askChoice` and `askScore`.
- `docs/plugins.md`, the plugin guide: what a plugin is, each part with an example, the order things start and stop in, and every startup error with its fix. `examples/` holds one plugin and its test per part; a test fails when an example embedded in the guide differs from its file.
- The README's five-minute path: `init`, `.env`, `doctor`, `start`, a minimal plugin, the requirements, and the `locale` setting.
- `scripts/scan-public.ts` ships in the repository, and CI runs it against the checked-out tree before install, so a host address, Discord id, credential, or private name fails the build. The lockfile may name a registry dependency.

### Changed

- The compaction tiers name the compactor by its role: the engine is `extension` or `pi`, `CompactionTiers` takes the extension's engine as an argument, and its `wrapCompactor` replaces the wrapper named for one compactor.
- Time-zone wording derives from the configured zone in every catalog: English names the IANA id, Traditional Chinese the city, and the `at` and `time` errors of a schedule name the zone.

### Fixed

- `testPlugin`'s `contribution` includes the `agentSelection` a plugin adds; it was left out.
- A setup that throws a `NotLinkedError` reports its reason without a doubled period.
- `pi-web-access` (0.35.0) is a dependency: the built-in delegation worker loads its Pi extension by path, and a project without it failed at the `modules` plugin's setup with `Cannot find module 'pi-web-access/package.json'`.
