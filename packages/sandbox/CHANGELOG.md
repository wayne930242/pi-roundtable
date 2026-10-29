# Changelog

## [Unreleased]

### Added

- `sandbox({ channelContext })`: opt-in, off by default (`true` or the Discord plugin's `ChannelContextOptions`). A guest turn in a Discord server channel starts with what others said in that channel since the assistant last posted, read through `DISCORD.channelContext` for the addressed message's own channel only (direct messages, messages without a guild and other surfaces read nothing). Core's defaults and caps apply (keep 15, 500 characters, other bots 80); images are never read. The block is prepended as untrusted public text, not instructions, cut oldest first to fit `runTurn`'s 32,000 characters and the worker's current-message budget, and the addressed message is never cut. A failed read is logged and the turn runs without it. Options are validated at startup, and the option needs the Discord plugin. Host-only: no worker protocol change, no image rebuild.
- `SandboxClaimOptions.channelContext` and `reportContextFailure`, and the `SandboxChannelContext` type.

## [0.24.1] - 2026-10-29

### Added

- `sandbox({ replyText })`: rewrites each successful model reply on the host before it is split and posted (`(text, { channel, space }) => string | Promise<string>`), for example to convert stray Simplified Chinese to Traditional. Failure texts never pass through it, the worker's history keeps the model's own words, and a throw or a non-string fails the turn like any other failure. Host-only: no worker protocol change, no image rebuild. An empty result posts nothing, as an empty model reply does.
- `SandboxClaimOptions.reportFailure` receives the error as its second argument, and the plugin logs it with the channel.

## [0.24.0] - 2026-10-29

The core peer range is now `>=0.24.0 <0.25.0`. Every new option is optional; with none set, behavior, mounts, files on disk, the worker protocol and the public API are as in 0.23.x, and `PiSandboxRuntime` is unchanged.

### Added

- `sandbox({ guilds })`: Discord guild ids whose every channel and thread is a sandbox channel, with no `/roundtable sandbox on`. The claim now answers the router's `owns(channel, space)`; asked without a guild (stop, start fresh, delete, background turns, other plugins) it answers for channels it has seen in a listed guild, a process-local set of at most 20,000 that drops the least recently seen. `/roundtable sandbox off` is refused in a listed guild, `on` says it is already on and `status` names the configuration. Ids are validated as snowflakes at startup. `SANDBOX.channels.owns(channel, guild?)` answers for both sources; `has` keeps meaning "enabled by command". `SandboxChannelStore` takes `{ guilds }` as its third argument and has `configured(guild)`.
- `sandbox({ workspace: "server" })` (`"channel"` stays the default): every sandbox channel of one guild shares one workspace (memory notes and files), while each channel keeps its own last ten exchanges in a state directory mounted at `/channel`, a third bind mount in this mode only. Turns that share a workspace run one at a time in arrival order; the turn timeout starts when a turn runs, `stop` cancels a waiting turn, `busy()` lists both; at most `maxWaiting` (default 4) turns wait behind the running one in a guild, and one past that is refused as busy. `SandboxRuntime.runTurn` takes an optional fourth argument `{ space }`. On disk (under `workspaceRoot`): `guild-<sha256("guild\0" + surface + ":" + id)>` and `state-<sha256("state\0" + channel)>`; per-channel workspaces keep their names, and switching modes migrates nothing.
- `sandbox({ files })`: `files_list`, `files_read`, `files_write` and `files_delete` in the sealed worker, inside `files/` of the workspace (relative paths, a symlink at any segment refused, 256 KiB per file and 32 MiB in all by default, both settable). They run in the worker and spend no broker calls.
- `sandbox({ skills })`: directories of skill folders (`SKILL.md` with `name` and `description` frontmatter). The system prompt ends with a skill index, and the host tool `host_read_skill({ name, path?, offset? })` pages a skill's files from the host; nothing is mounted. Startup stops on a missing directory, bad frontmatter, a duplicate name or a configured host tool named `read_skill`.
- `sandbox({ budgets: { promptBytes, toolResultBytes, requestBytes } })` (defaults 8,192, 4,096 and 196,608; at most 32,768, 32,768 and 196,608), and `maxCalls` and `maxOutputTokens` settable through `sandbox()`. A prompt (with the skill index) over `promptBytes` stops startup naming both sizes. Host tools get `HostToolContext.resultBytes`, the allowance their result will be cut to net of the broker wrapper; `toolResultTextBytes` and `pageText` fit a page to it. A cut tool result is marked as cut and no longer points at `memory_get`.
- `modelUrl` may be a cleartext `http://` URL on `127.0.0.1`, `::1` or `localhost` without `allowHttp`; any other cleartext URL still needs it.
- Importing history: `guildWorkspaceDir`, `channelStateDir`, `channelWorkspaceDir`, `historyFilePath`, `workspaceFilesDir`, `HISTORY_FILE`, `HISTORY_MAX_ENTRIES`, `HISTORY_ENTRY_BYTES`, `encodeHistory` and `userHistoryContent` describe the on-disk layout and the history entries the worker reads.

### Changed

- The worker's request trim never drops the newest tool-call group (the model would call the same tools again until the call limit): when it does not fit, each of its results is cut to a fair share of what is left and marked as cut. Startup stops when `budgets.requestBytes` cannot hold `promptBytes` + 8,192 bytes of memory notes + 49,152 bytes for the current message + 8 KiB of tool-result room, naming every size.
- `budgets: {}` (or one whose keys are all undefined) no longer demands a protocol-2 image; only a budget with a key set does.
- With `workspace: "server"` the memory tools and the system line call the shared notes server notes, shared by every channel of the server; the `channel` scope name is unchanged.
- A turn stopped while it waits for its workspace, or refused because the queue is full, rejects with `SandboxTurnRefused` (exported; `reason` is `"stopped"` or `"busy"`), and the claim answers it without logging an infrastructure failure.
- The worker image carries the label `pi-roundtable-sandbox.protocol` (2), and the Dockerfile copies the new modules (`history.ts`, `paging.ts`, `files.ts`). **Rebuild the image** when you set `workspace: "server"`, `files`, `skills` or `budgets`: startup reads the label through the container driver (`ContainerDriver.imageProtocol`, optional; `DockerContainerDriver` uses `docker image inspect`) and stops on an older image, so an old worker never writes a channel's history into a shared workspace. The README's "exactly two bind mounts" now describes both modes.

## 0.23.2

- Release in lockstep with pi-roundtable 0.23.2; no package-specific behavior changes. The core peer range stays `>=0.23.0 <0.24.0`.

## 0.23.1

- Release in lockstep with pi-roundtable 0.23.1; no package-specific behavior changes. The core peer range stays `>=0.23.0 <0.24.0`.

## 0.23.0

- Release in lockstep with pi-roundtable 0.23.0; no package-specific behavior changes. The core peer range is now `>=0.23.0 <0.24.0`.

## 0.22.5

- Release in lockstep with pi-roundtable 0.22.5. `engines.bun` is now `>=1.4.4` (was `1.4.2`). The core peer range stays `>=0.22.0 <0.23.0`.

## 0.22.4

- Release in lockstep with pi-roundtable 0.22.4. The core peer range stays `>=0.22.0 <0.23.0`.
- The worker images build on `oven/bun:1.4.4` (was 1.4.2), the first Bun with the Brotli decoder fix (CVE-2026-111497). Rebuild the worker and deps images.

## 0.22.3

- Release in lockstep with pi-roundtable 0.22.3; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## 0.22.2

- Release in lockstep with pi-roundtable 0.22.2; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## 0.22.1

- Release in lockstep with pi-roundtable 0.22.1; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## 0.22.0

- Release in lockstep with pi-roundtable 0.22.0. The core peer range moves to `>=0.22.0 <0.23.0`.

## 0.21.0

- Release in lockstep with pi-roundtable 0.21.0. The core peer range moves to `>=0.21.0 <0.22.0`.

## 0.20.0

- Release in lockstep with pi-roundtable 0.20.0. The core peer range moves to `>=0.20.0 <0.21.0`.

## 0.19.2

- Release in lockstep with pi-roundtable 0.19.2. The core peer range stays `>=0.19.0 <0.20.0`.

## 0.19.1

- Release in lockstep with pi-roundtable 0.19.1. The core peer range stays `>=0.19.0 <0.20.0`.

## 0.19.0

- Release in lockstep with pi-roundtable 0.19.0. The core peer range moves to `>=0.19.0 <0.20.0`.

## 0.14.0

- Release in lockstep with pi-roundtable 0.14.0; no package-specific behavior changes. The core peer range moves to `>=0.14.0 <0.15.0`.

## 0.13.0

- Release in lockstep with pi-roundtable 0.13.0. The core peer range moves to `>=0.13.0 <0.14.0`.
- A failed attachment download is reported as `download failed: <code>` (the error's `code` or `name`, else `error`) instead of the error's text, which could quote a path in the guest-writable directory.

## 0.12.1

- Release in lockstep with pi-roundtable 0.12.1; no package-specific behavior changes. The core peer range stays `>=0.12.0 <0.13.0`.

## 0.12.0

- Release in lockstep with pi-roundtable 0.12.0; no package-specific behavior changes. The core peer range moves to `>=0.12.0 <0.13.0`.

## 0.11.0

- Release in lockstep with pi-roundtable 0.11.0; no package-specific behavior changes. The core peer range moves to `>=0.11.0 <0.12.0`.

## 0.10.0

- Release in lockstep with pi-roundtable 0.10.0; no package-specific behavior changes. The core peer range moves to `>=0.10.0 <0.11.0`.

## 0.9.13

- Release in lockstep with pi-roundtable 0.9.13; no package-specific behavior changes.

## 0.9.12

- Release in lockstep with pi-roundtable 0.9.12; no package-specific behavior changes.

## 0.9.11

- Release in lockstep with pi-roundtable 0.9.11; no package-specific behavior changes.

## 0.9.10

- Release in lockstep with pi-roundtable 0.9.10; no package-specific behavior changes.

## 0.9.9

- Release in lockstep with pi-roundtable 0.9.9; no package-specific behavior changes.

## 0.9.8

- Release in lockstep with pi-roundtable 0.9.8; no package-specific behavior changes.

## 0.9.7

- Release in lockstep with pi-roundtable 0.9.7; no package-specific behavior changes.

## 0.9.6

- A worker's compaction tiers measure the context left with the system prompt and tools its requests carry, as the host's do; its compaction report and the host's `conversation compacted` log add `contextAfter`.

## 0.9.5

- Release in lockstep with pi-roundtable 0.9.5; no package-specific behavior changes. 0.9.4 was tagged but never published.

## 0.9.3

- Release in lockstep with pi-roundtable 0.9.3; no package-specific behavior changes.

## 0.9.2

- Release in lockstep with pi-roundtable 0.9.2; no package-specific behavior changes.

## 0.9.1

- Release in lockstep with pi-roundtable 0.9.1; no package-specific behavior changes.

## 0.9.0

- The sandbox claim answers only an author the host's `access` rules serve: it reads the router's `message.speaker` and ignores a message without one, as it ignores a bot's. A guest who was answered in 0.8 without any tier is now ignored until `access` gives them one, for example `access.members.roles` naming their guild role. The message is still never routed to a host agent.
- `SandboxRuntime.runTurn` takes the author's `principalId` with their `id` and `name` (`SandboxSpeaker`, a new export) and refuses a turn without one. Host tools read it as `context.speaker.principalId`, and the credential hook as `scope.speaker.principalId`, so a host can pick a key per principal. The worker still reads only the author's `id` and `name`; its memory namespaces are unchanged. A `PiSandboxRuntime` turn's scope carries no principal.
- `precheckScriptRunner` grants a script what `context.tier`, the tier of its run (pi-roundtable 0.9's `PrecheckContext.tier`, its schedule's capped at what its creator holds now), reaches, instead of the tier the schedule was set at, so a script 0.8 stored at the owner tier no longer reaches the owner's tools for a member.
- `ScopedSandboxDelegator.start` takes the author's `principalId` and the tier `member`, as pi-roundtable 0.9's `DelegationJob.author` requires them, and refuses any other tier, as it refused a tier before: a guest's report runs as the principal the host bound them to, at the member tier or theirs, whichever is lower. The worker's `run` still hears only the author's `id` and `name`.

## 0.8.0

- `apiKey` and `oauthToken` receive `{ channel, speaker }` (`SandboxCredentialScope`, a new export) before every model call, so a host can pick a key or a subscription per channel or speaker, such as `apiKey: ({ channel }) => keys.get(channel)`. A zero-argument function keeps working. A turn keeps the scope it started with while its requests are in flight, and a getter that returns `undefined` or an empty string fails the call: no other credential is used. The worker still sees only the placeholder key.

## 0.7.18

- Preserve a reset requested during broker startup or an active turn for the following turn; a successful turn consumes only the reset generation it started with.
- Separate runtime configuration and per-turn broker/driver resource management from channel admission, cancellation and reset state, keeping the public API and cleanup order unchanged.
- Add regression coverage for failure cleanup, reset retries, independent channels and admitted speaker identity.

## 0.7.16

- `jevCompactor({ logger })` from pi-roundtable 0.7.16's `pi-roundtable/kit` is a `PiCompactor` as it is: `compaction: jevCompactor({ logger })` compacts a sandbox session through Jev with the core's summary rules (the previous summary once, a rule-keeping goal, a reload list) and logs each fallback to Pi's summary with its channel, reason and `tokensBefore`. Without a Jev API key it logs that once and compacts through Pi's summary.

## 0.7.15

- The model broker forwards a mid-conversation `role: "system"` message, which Claude Code 2.1.284 sends with each turn's environment, instead of refusing it. Like every other part of the request it is rebuilt, not passed on: its content may be only text (a string, or `text` blocks with `cache_control`), it keeps `clear_at`, and its per-message `output_config.effort` is capped at the host-judged level as the top-level effort is. The guest already writes the top-level system prompt and every user turn, so this text gives it no more reach. A tool change inside one (`tool_addition`, `tool_removal`, `tool_definition`) is still refused, with a 400 worded as the API words it, so Claude Code resends its tools whole.

## 0.7.14

- A model request the broker refuses (an unknown role, a native tool, remote media, a remote schema) is answered with a 400 in the Anthropic API's error shape (`invalid_request_error`) instead of a 502, and logged as `sandbox upstream call failed`. Claude Code 2.1.284 (agent SDK 0.3.284) sends a mid-conversation `role: "system"` message when MCP tools arrive late; the broker refused it with a 502, which Claude Code retried about ten times over several minutes before the turn failed. The refusal of a role now reads `messages.N: Unexpected role "system": the input message role must be "user" or "assistant"`, which Claude Code recognizes: it resends without system messages for the rest of that conversation. The broker still never forwards a system message.

## 0.7.13

- `precheckScriptRunner` forwards only the tools approved with the script (pi-roundtable 0.7.13's `PrecheckScriptContext.tools`) among those `grant` allows, and takes `toolName(server, tool)`, the name the host's hold rules know a tool by (default the tool's own name).

## 0.7.12

- A host compactor gets at most half the time the turn has left (the runtime passes the broker its `deadline`, `PiHostContext.deadline`), so Pi's own summary still fits after it runs out; with under two seconds left the broker falls back to Pi's summary at once.
- The broker logs the first `error` event of a server-sent event stream that started with a 200 (`sandbox upstream call failed`, with the event's data, credentials removed), which the status alone never showed; the worker still receives the whole stream.

## 0.7.11

- `precheckScriptRunner` runs agents' precheck scripts (pi-roundtable 0.7.11) in a sealed container per run: no network, a read-only root, no capabilities, a non-root user, an empty workspace, and a per-run broker (`precheckBroker`) that forwards only single `tools/call` requests of the tools `grant(scope)` allows, with the host's credential (`PrecheckMcpServer`). The container runs `worker/precheck-main.ts` (`PRECHECK_ENTRYPOINT`, `PrecheckWorkerInput`), which gives the script `mcp.call`, `mcp.json`, `firedAt`, `timeZone`, `today`, and `schedule`.
- A script's workspace is mounted read-only (`ContainerSpec.workspaceReadOnly`), so it writes only to the container's bounded `/tmp`. The broker refuses an answer that carries the credential plainly, escaped, inside JSON text, base64-encoded, or as a key; joins an SSE event's `data:` lines; and refuses a second call while one is pending (409) without spending the budget. The script's console output goes to stderr and never into its answer, and `grant` receives the creator's `tier`.
- `ContainerSpec` takes `entrypoint`, and `DockerContainerDriver.exec` runs a sealed container with any input and a bounded output (`PrecheckContainerDriver`); `worker/Dockerfile` includes the precheck worker.

## 0.7.10

- Compact Pi worker sessions with the core's tiers (300,000 tokens through a host compactor, Pi's summary past 500,000), through the new `compaction` option (`PiCompactor`: `engine`, `compact(request, { channel, signal })`, `timeoutMs`, `maxRequestBytes`) and the protocol types `PiCompactRequest`, `PiCompaction`, `PiCompactResponse`, `PiCompactionReport`, `PiCompactMessage` and `PiWorkerConfig`; the host logs every compaction and fallback per channel.
- A failed `runTurn` keeps its cause (`AgentRunError` message and `cause`, whether it timed out) and logs it; the broker logs upstream failures with channel, status, latency and the error body; a timed-out worker's last 200 log lines are logged before its container is removed (`PiContainerDriver.logs`).
- Behavior change: Pi containers log to journald tagged `sandbox/<channel>` by default, instead of two 10 MiB `local` files, so the Docker daemon must run with journald (pass `PiDockerContainerDriver` a `log` option for another driver) (`PiContainerSpec.log`, `PiDockerContainerDriver` option `log`, `defaultContainerLog`), and the worker logs model, broker, tool and compaction failures.

## 0.7.5

- `ScopedSandboxDelegator` limits a title to 200 characters by default again, and accepts `maxTitleChars`, `maxReportChars` and `diagnosticChars`.

## 0.7.4

- Let `SandboxResearchWorker` run the host's own web tools (`tools`, `scope`, `aborted`), and make `ScopedSandboxDelegator` refuse and fail with readable reasons (scrubbed) instead of generic text, with no title limit.

## 0.7.3

- Add the opt-in Pi subscription mode (`PiSandboxRuntime`, `PiSandboxBroker`, `PiDockerContainerDriver`), worker-initiated transport, controlled `safeFetch`, bounded media in and reply files out, scoped delegation and a research worker, with the sealed default unchanged.
- Add `assertPublicUrl`, `safeFetch` `followRedirects` and `headers`, and a research-worker `fetchContent` hook for hosts that keep a library's own extractors.
- Keep upstream error status, body and back-off headers through the rich broker, re-arm the metadata-only startup window for a restarted worker, and refuse compressed Teredo addresses.
- Stream rich broker responses without fixed total caps (the turn deadline is the bound), bind the host-judged thinking level so the worker can only ask for less, and replace guest-planted symlinks on start and start-fresh instead of following them.

## 0.7.2

- First release published by the lockstep workflow; no changes to the package. The `v0.7.1` tag published nothing.

## 0.7.0

- Move into the pi-roundtable monorepo at `packages/sandbox`, preserving Git history.
- Align the version, core development dependency, and peer range with core 0.7.0 (`>=0.7.0 <0.8.0`).
- Use the shared checks and lockstep publication workflow; the Docker integration remains opt-in locally and runs explicitly in Linux CI.

## 0.1.0

- Add sealed text-only guest channels for pi-roundtable 0.6.1 using Docker on Linux.
- Add a per-turn Unix broker with fixed model forwarding, host-only credential swapping, tool and MCP allow-lists, and bounded requests.
- Add persistent channel and speaker memory inside each isolated workspace.
- Add owner-only sandbox on, off, and status commands using the shared channel queue.
- Ship the minimal worker image, setup example, threat model, offline tests, optional Docker integration test, and CI/publish workflows.
