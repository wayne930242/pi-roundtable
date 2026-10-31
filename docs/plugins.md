# Writing plugins for pi-roundtable

After running `npx pi-roundtable init`, you can write a plugin to add something the bot doesn't do yet.

Every code block below marked with `example:` is a real file under [`examples/`](../examples), and the test suite fails when a block here differs from its file.
Each example has a test next to it that runs it without Discord or PostgreSQL, except the one that needs a database, which says so.

## What a plugin is

A plugin is an object with a name and a `setup` function.
`setup` returns the parts the plugin adds to the bot: tools agents can call, text added to their prompt, agents to create, handlers for events, long-lived services, slash commands, HTTP routes, and so on.
The bot itself is assembled from plugins too.
The core ships built-in plugins for its memory and schedule stores, schedule prechecks, Discord connection, agent server, notifications, delegation, and schedules.
You can switch off three [addons](#addons-memory-skills-and-discord-administration): memory, skills, and Discord administration.
Your plugins are added after them and can read or replace the built-ins' [keyed services](#services-what-plugins-provide-to-each-other).

You write plugins in TypeScript, list them in `roundtable.config.ts`, and Bun loads them directly.
Importing a plugin installs it, with no build step or plugin registry.

```ts
// roundtable.config.ts
import type { RoundtableConfig } from "pi-roundtable";
import { notes } from "./plugins/notes.ts";

export default {
	// ...the settings `init` wrote...
	plugins: [notes],
} satisfies RoundtableConfig;
```

Everything a plugin author needs comes from five entries and one stylesheet, and nothing else can be imported from the package:

| Entry | What it exports |
|---|---|
| `pi-roundtable` | `definePlugin`, `defineTool`, `defineRoundtable`, `ToolRefusal`, `PluginError`, `NotLinkedError`, `Roundtable`, and the types (`Tier`, `Speaker`, `Contribution`, `PluginContext`, and so on) |
| `pi-roundtable/testing` | Fixtures for testing plugins, without Discord or a database unless the test explicitly opens one; `testHost` names a few discord.js types (`ComposedCommands`, `CommandGuard`, `InteractionModule`, `RootOption`) so a test can drive the composed slash commands |
| `pi-roundtable/kit` | Helpers for channel claims, tools, presentation, worker processes, and naming existing core parts |
| `pi-roundtable/discord` | The entry built on discord.js types: the `DISCORD` service (slash commands, the owner guard), owner-command and panel helpers, the agent panel, and the channel-operation tables |
| `pi-roundtable/characters` | The composed characters: the catalog of classes and parts, the checks on a look, `suggestCharacter`, and `composeSvg`, which runs in a browser as well as on the server; see [Characters](#characters-composed-pictures-for-agents) |
| `pi-roundtable/characters.css` | The stylesheet that moves them (a file, not a module) |

### Advanced building blocks

Start with the main entry and the context's built-in services.
The kit and Discord entries follow the main entry's versioning: before 1.0, breaking changes to exported names come in minor releases and appear in the changelog.
A test compares every exported signature with a recorded report.
Use `pi-roundtable/kit` for channel claims, tool and presentation helpers, and the types of the core's existing parts.
Use `pi-roundtable/discord` for everything that touches Discord: slash commands, owner-command modules and panels, the agent panel, and the channel-operation tables.
The main and kit entries name no discord.js type (a test checks their declarations), so a plugin that does not talk to Discord never depends on it.
These entries expose built-in services through keys and ports, without exporting their classes; you can read a service or provide your own implementation.
Their exported names are grouped by area in the source, with one entry for each; directory paths and files under `src/core` are internal.
The [changelog](../CHANGELOG.md) lists every exported name, including type-only contracts.
Import fixtures and fake threads from `pi-roundtable/testing` for tests.

#### Workers of your own

A plugin that gives a model its own small set of tools, such as a worker that drives a browser, asks the host for a worker session instead of building one from Pi's parts:

```ts
const sessions = context.services.get(WORKER_SESSIONS);
const report = await sessions.run({
	task: "What the worker is asked to do.",
	signal: turn.signal,
	prompt: "You are a ... worker. Report in the task's language.",
	extensions: [registersTheWorkersTools],
	toolNames: ["my_tool"],
});
```

`run` starts a fresh session that is never saved, on the host's model login (the same credentials and refreshes the agents use), with the `model` and `thinking` of the host's `delegation` settings unless the request names its own (`model` is `<provider>/<id>`; `sessions.delegation` shows the defaults).
The session has no built-in tool, no skills, no context files, no memory and none of the agents' tools: only the tools the `extensions` register with `pi.registerTool` and `toolNames` lists are active, and an extension that activates another tool is undone.
`prompt` is added to its system prompt, so the standing rules and any instructions the worker should follow, such as a tool's usage guide, go there.
`run` resolves to the worker's final answer, rejects with an `AgentRunError` when it ends without one, and rejects when `signal` aborts (`aborted` is the message of that rejection, default "the worker ran out of time"); the session is disposed either way.
The tools are the plugin's to bound: the worker has no tier, no hold and no conversation, so a tool checks what the worker asks for, limits its work, and cleans up in a `finally` around `run`.
A file a tool produces reaches the person only through the tool that called `run`: collect it and call `turn.attachFile` after `run` returns, as the [browser package source][browser-source] does with screenshots.
The `worker-sessions` plugin provides the service on every host.

#### Helpers for a Pi session of your own

Use the kit's building blocks for a plugin that runs Pi itself, such as a coding worker:

- MCP: `mcpExtension` and `VirtualServer` expose MCP servers to a session, and `mcpAdapterExtension` and `readAttachmentExtension` do the same inside an out-of-process worker.
- Admitted media: `prepareImageBytes(data, contentType)` prepares raster bytes without reopening a guest-writable path; the result's type is the one the bytes show (PNG, JPEG, GIF or WebP), not the declared one, and other bytes throw `ImagePreparationError`; supported small images remain unchanged, and larger sides/encoded images are downsized to JPEG at a 2,000 px long side.
  Before any native decoder, it refuses more than 25 MiB of encoded bytes or 64 million decoded pixels, including aggregate GIF/WebP frame dimensions.
  `ImagePreparationError.reason` is `byte-limit`, `pixel-limit`, or `invalid-image`; hosts can localize refusals without parsing native decoder errors.
  Ordinary 48 MP images and thin 9000×1 images remain admitted.
  This helper is not a downloader or filesystem validator.
- Square pictures: `squarePng(bytes, { size?, maxBytes?, maxSide? })` crops a PNG, JPEG or GIF to its centered square and scales it down to at most `size` pixels per side (default 512; a smaller picture is not enlarged), as PNG: the helper the agent avatars are made with, for a plugin that needs a profile picture or an icon.
  The header is read first, and nothing is decoded for a picture that declares a width or height over `SQUARE_PNG_MAX_SIDE` (4096), which rejects with `ImagePreparationError` (`pixel-limit`, the message naming the side limit; `maxSide` sets another limit, and the 64 MP decoded-pixel budget always applies), or for bytes of no such type, a WebP (the canvas cannot decode it) or a picture that fails to decode (`invalid-image`).
  With `maxBytes` the side steps down by a quarter at a time until the PNG is no larger; a picture that does not fit even at 16 pixels throws a `RangeError`, as does a `size` or `maxBytes` that is not a whole number in range. `SquarePngOptions` types the options.
- Codex images: `drawCodexImage({ token, prompt, references?, model?, signal?, fetch? })` draws one image through ChatGPT's Codex backend with the owner's `openai-codex` login (`CODEX_IMAGES_PROVIDER`) and returns `{ data, revisedPrompt? }`: `data` is PNG bytes, and `revisedPrompt` is the prompt Codex says it drew, when it says. `model` defaults to `CODEX_IMAGE_MODEL` (`gpt-6-sol`), which only routes the request; the backend picks the image model. `fetch` is a `CodexFetch`, which `typeof fetch` satisfies, for tests.
  The call aborts with `signal`, before the response arrives and while its stream is read, and rejects with the signal's own reason, so a turn's `signal?.throwIfAborted()` still sees its own abort. It stops after five minutes with a `TimeoutError`, refuses a stream over 32 MiB (`Codex image response too large`; the completed event may repeat the image, so a PNG of about 12 MiB can be refused), and reads only the first image. An HTTP error carries its status and the first 300 characters of the body, never the token.
  A call that ran and returned no image, and a response that completed without one, both throw `ImageNotGeneratedError`, usually because Codex refused the prompt; asking again with the same prompt fails again.
  `createCodexImages({ fetch?, model?, onMissingLogin? })` is the `codex-images` plugin built on it. It fills the `images` provider, reads the login through `context.apiKey` for each drawing (the login refreshes), and passes the drawing's `options.signal` on, so the turn that asked for an image can abort it. Without a login, setup throws a `PluginError`; `onMissingLogin: "warn"` logs once and lets the host start, and a drawing then fails with the same `PluginError`. The kit exports no ready-made plugin object, because a plugin object shared between `check()` and `run()` should come from your own module; the `codex-images` template makes one.
  The types are `CodexFetch`, `CodexImage`, `CodexImageRequest` and `CodexImagesOptions`.
  This uses ChatGPT's Codex backend, signed in with the owner's ChatGPT subscription. OpenAI does not document it for this use, so it can stop working without notice, and OpenAI's terms for the subscription apply.
- Work: `promptSlot` (how a run asks the owner while it works), `workTimeout` (a time limit that does not count the time spent waiting on the owner), `runWorkerTask`, `archiveSessions`, and `approvalCard`, `approvalDetails` and `canonicalJson` for the cards of held actions.
  `InterimPoster(posts, { logger, channel, primaryChars?, editMs? })` posts a run's [interim text](#interim-text-what-a-turn-writes-before-its-final-answer) to an `InterimPosts`, such as a dispatch thread's `interim`: feed it `messageEnd(message)` and `toolStart(name)` from the session's events, bind `() => poster.flush()` as the slot's `beforeCard`, and `await poster.flush()` before the final report.
- Diagnostics: `scrubDiagnostic(text, max = 600)` masks credentials (URL userinfo, token shapes, secret-named assignments and JSON fields, `Authorization`/`Cookie`/`x-api-key` headers, JWTs, PEM blocks), turns control characters other than tab and newline into spaces, and cuts the result at `max` characters.
  It scans only the first `max * 4` characters (at least 4,096), in linear time, so pass it git, gh or provider error text before showing that text to a user.
- Shell: `SHELL_TOOLS`, and `shellHoldRule` and `shellHoldRuleFor(policy)`, the hold rule that keeps risky host-shell commands behind the owner's approval; see [the shell rule](#the-shell-rule).
- Tools: `textToolsExtension`, `requiredString`, `stringList` (with `toolText` and `toolError`) for tools that return text.
- Mirroring a built-in tool in a worker that cannot reach the host: `SCHEDULE_TOOLS`, `scheduleToolSpecs({ locale, timeZone })`, `isScheduleTool`, `callScheduleTool`, `DELEGATE_TOOL` and `DELEGATE_TOOL_SPEC`.
  The specs take the locale and time zone for their descriptions, so the worker needs no process-wide setting.
- Compaction: `CompactionTiers` gives a session the core's compaction tiers (`settings()` for Pi's `SettingsManager`, `wrapCompactor(factory, onBypass, prepare?)` to hold a compaction extension back past the ceiling and change what it is given first, `latest()`: the latest compaction's `contextTokens`, the context it left as a request sends it, system prompt and tools included, `measured` once a request after it reported its usage), with `SOFT_COMPACT_TOKENS` (300,000), `HARD_COMPACT_TOKENS` (500,000), `COMPACT_HEADROOM_TOKENS` (50,000), `compactionEngine(details, engine)` and the types `CompactionEngine`, `CompactionHistory` and `LatestCompaction`. `summaryProjection(messages, history?)` is what a shared conversation's compaction may summarize, without anyone's private memory, prompt states, or reasoning, and `privateCompaction(preparation, additionalMessages?)` sets a `session_before_compact` preparation to it. Optional surrounding history pairs calls/results split across summary, prefix and kept context. Independent shared sessions use `memoryProjection(messages, view)` on requests and `hidesPrivateExchange(messages, view)` for raw replay guards (`MemoryView`: `shared` and `reader`; legacy attribution is internal to the bridge guard, not a projection option). `recordMemoryTurn(manager, reader, privateMemory)` appends `MEMORY_TURN_ENTRY` (`roundtable-memory-turn`) before prompting and returns a marker for memory first used later in that turn; `carriesMemory(message)` recognizes built-in memory calls/results and custom `privateTo` results, including immediate failures and unanswered calls. `bridgeHistoryHidesMemory(rawBranch, reader)` checks those records and raw exchanges across compaction; SYSTEM is a reader of its own there, and the core's SYSTEM-as-primary-owner attribution and its pre-scope legacy attribution stay inside the core.
- Jev compaction: `jevCompact(input, options)` compacts through Jev (pi-jev-compaction 1.0.0) and returns `{ compaction }` or `{ skipped, detail? }` (a `JevSkipReason`: pi-jev-compaction's fallbacks `no_key`, `aborted`, `nothing_to_compact`, `no_candidates`, `cannot_fit`, `jev_error`, `reduction_too_small`, or `previous_summary_too_large`), for Pi's own summary to run instead.
  Its summary carries the previous summary once, as the transcript's `[previous compaction]` message, with `estimatedTokensAfter` measured on the final text; a previous summary over `previousSummaryLimitTokens` (default `JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS`, 60,000) skips without calling Jev, so Pi's summary condenses the chain.
  Jev judges with `goal` (default `JEV_GOAL`: keep the tool results that set rules still in force, drop stale lookups, listings and finished edits), and the summary ends with a `## Rules loaded before this compaction` section naming each rule load among the summarized messages (tool name and JSON arguments cut at 200 characters) for the agent to load again; `ruleLoad(tool, args)` picks them (default `isRuleLoad`: tools ending in `invoke-skill` or `get-system-prompt`, and tools ending in `read` whose `path` is a `SKILL.md`, an `AGENTS.md` or under `.agents/skills/`).
  `config` passes pi-jev-compaction's settings (`apiKey`, `model`, thresholds) over its config file and environment; `asker` replaces Jev's service, for tests.
  The API key is optional: without one, `jevCompact` skips with `no_key` without calling Jev, and compaction is Pi's own summary.
  Two adapters log each skip as `Jev leaves the compaction to Pi's summary` with `reason`, `detail` and `tokensBefore` through the `logger` they take: `jevCompactionExtension({ logger, ...options })`, the `compaction` session tool's extension, placed as `session.compaction.wrap(jevCompactionExtension({ logger }))` under the engine `JEV_COMPACTION_ENGINE` (`pi-jev-compaction`), and `jevCompactor({ logger, ...options })`, a `JevCompactor` for pi-roundtable-sandbox's `compaction` option that returns the compaction or `undefined` and logs with the `channel`.
  A `no_key` skip is logged once per adapter, as `Jev is not configured, so compaction uses Pi's summary`, and then not again; every other skip is logged each time.
  The types are `JevCompactInput`, `JevCompactOptions`, `JevCompactOutcome`, `JevCompactor`, `JevCompactRequest`, `JevExtensionOptions` and `JevSkipReason`.
- Jev judge: `jevJudge({ apiKey, model?, baseUrl?, timeoutMs?, fetch? })` is a `Judge` (the `judge` provider) that asks Jev, built on pi-jev-compaction's client. Each question is one request: a yes-or-no question goes out as Jev's own question type and its probability is read from Jev's answer, a choice question's answer must be one of the options you listed, and a score question's probabilities are read by criterion index, so a missing index is an error. Probabilities must be numbers from 0 to 1.
  Every failure throws a `JudgeError`: a failed request, an answer that is missing or malformed, a choice that is not an option, and a question that outlasts `timeoutMs` (default 20,000, a limit of its own for each question that also covers reading the answer), as `Jev did not answer within <n> ms`.
  The `apiKey` is required, and an empty or blank one throws a `JudgeError` when `jevJudge` is called, because pi-jev-compaction's client would otherwise fall back to the key in the environment. `baseUrl` and `model` default to pi-jev-compaction's; `fetch` replaces the request function, for tests. The option type is `JevJudgeOptions`.
- Effort: `effortJudge` picks a turn's thinking level from a message with your own brief (`EffortBrief`, `JUDGE_WORK`). A host that wants other turns decided differently sets `effortPolicy` (an `EffortPolicy`) in its configuration: it gets the turn's `channel`, `kind`, `agent` and `origin` and answers `{ fixed: level }` (no judge call), `{ requiredMass: [0, medium, high, xhigh] }` (the highest level whose share of the judge's answer at or above it meets its entry; the previous level does not carry over and a failed judge gives low), or `undefined` for the default. The `kind` of an agent-server agent's turn is `"agent"`; a policy that throws, or a `requiredMass` that is not four finite numbers in [0, 1], fails the turn.
- Presentation and small helpers: `thinkingLine`, `zonedStamp(date, timeZone)`, `channelQueue()` (a queue of your own, so work does not wait behind a running turn), `checkRepoName` and `SKILL_LIST_TOOL` with `skillListExtension` for repositories and skills, `searchTerms` for memory search, and `within` for a path-inside-a-directory test.

The [coding package source][coding-source] shows these helpers in an out-of-process Pi worker.
The [MCP package source][mcp-source] is a full example of connectors and remote MCP endpoints.

`roundtable add plugin <name>` creates `plugins/<name>.ts` and its test from a small template and lists it in `roundtable.config.ts`.
The name is lowercase words joined by dashes, such as `my-notes`.
Three names are reserved for the [official plugins](#official-plugins): `codex-images`, `dice`, and `release-notice` copy a ready-made plugin into the project.

`roundtable add package <spec>` adds a Pi package from npm: it runs `bun add <spec>`, loads the package's extensions to find the tools they register, and writes `plugins/<name>.ts` and its test, named after the package without its scope, as [`piPackages`](#pipackages-pi-extensions-every-session-loads) describes.

## The plugin object

```ts
definePlugin({
	name: "my-notes",          // lowercase words joined by dashes; unique across all plugins
	migrations: [],            // optional: tables the plugin needs
	providers: {},             // optional: replaces a part the core runs on
	provides: [],              // optional: keys of the services setup provides to other plugins
	replaces: [],              // optional: keys of built-in services this plugin takes over
	identities: [],            // optional: identities the plugin's own credentials stand for
	hostAccess: true,          // optional: its tools reach the host's machine (shell, files)
	preflight() {},            // optional: a check that runs before anything starts
	setup(context) {           // required: returns the parts the plugin adds
		return { /* parts */ };
	},
});
```

`definePlugin` checks the name and the presence of `setup`, then returns the typed object you gave it.
Errors point to the plugin definition.

`hostAccess: true` marks a plugin whose tools reach the host's machine, such as one whose workers run shells or edit files (`pi-roundtable-coding` declares it).
A host that gives its agents [no shell](#chat-only-agents-no-shell-file-or-workspace-tools) refuses to start with such a plugin registered.

A plugin whose `setup` returns `{}` and has no migrations, providers, or hooks stops startup (see [Errors](#errors-and-their-fixes)).

`identities` is for a plugin that serves a credential of its own, such as the bearer token of an endpoint, and runs turns for whoever holds it.
Each entry is a `PluginIdentity`, `{ identity, principal? }`: the identity written `token:<subject>`, such as `token:remote-mcp`, and the id of the principal it stands for, by default the primary owner (the first of `access.owners`).
Only the `token` provider is accepted. A surface's identity, such as `discord:<user id>` or `oidc:…`, is a person's own account: declaring it would make whoever holds it the principal the plugin binds it to, owner included, and unlink it when the plugin stops declaring it. Link those in `access.owners` or with `roundtable principal link`.
At every start the `identity` plugin links each one to its principal as the plugin's (`roundtable principal list` shows `plugin <name>`), moves one whose principal changed since the last start, and unlinks one no plugin declares any more.
The start stops with a `ConfigError` for an identity that does not parse or is not a `token:` identity, one two plugins declare, the system principal, a principal that does not exist, and an identity linked to someone else by the configuration, the CLI, or a first contact; the message names what to change.
A declared identity is never admitted or claimed as someone new, and linking it leaves the principal's 0.8 claim alone: a plugin's credential is not the person's own identity.
Nor does its link tell who a configured owner is: an owner in `access.owners` that also lists a declared identity is known by its `principal` or its other identities, and the start stops when that is not the principal the plugin binds the identity to on that start (its `principal`, or else the primary owner), or when nothing else tells who the owner is. Whom the identity was bound to at an earlier start does not matter: once the plugin is bound to that owner in its options, the next start moves the identity to them.
Read whom it stands for with `IDENTITY.principalOf(identity)`, and start the turn with `IDENTITY.speakerFor(principalId)`.
A plugin that replaces `IDENTITY` replaces this too: the declarations are the built-in `identity` plugin's to link.

### The context

`setup` receives a `PluginContext`:

| Field | What it is |
|---|---|
| `logger` | The host's logger with `plugin: <your name>` on every line; each line is JSON on stdout. Its type is `Logger` (`debug`, `info`, `warn`, `error`, `fatal`, `child(fields)`), which a pino logger satisfies |
| `env` | The host's own environment for the run: `locale`, `timeZone` (an IANA zone), `now()`, `scratchDir` when the host has one, `characterSkins`, the six skin tones the host draws its agents with ([host skins](#host-skins-the-charactersskins-option)), and `agentTools`, `"full"` or `"chat-only"` ([chat-only agents](#chat-only-agents-no-shell-file-or-workspace-tools)); read the zone from here rather than from the process, give `scratchDir` to a shell the plugin runs itself, and pass `characterSkins` to `composeSvg` when the plugin draws a character |
| `database()` | The host's one PostgreSQL connection (a Bun `SQL`), already migrated |
| `toolTiers` | What each tool needs; ask it when a tool is used, not during setup |
| `events` | Where the core reports turns and team changes to every plugin's handlers |
| `providers` | Each provider slot, from the plugin that fills it or the core's default; `providers.filled` is the set of slots a plugin fills |
| `apiKey(provider)` | The credential the host's model login holds for a provider such as `openai-codex`, the same login the agents use. It resolves to `undefined` when the host has none for that provider and never throws for that. The value is a secret: keep it out of logs and error messages. Read it when you use it rather than keeping it, since a login may refresh its token |
| `listener(id)` | The address the host's listener `id` serves on, as configured: `{ socketPath, mode? }` for a unix socket or `{ port, hostname? }` for TCP (a frozen copy, without the id), or `undefined` for an id the host has no listener for. A plugin that serves without authentication reads it to refuse an address that reaches beyond the machine, as the web console's `auth: { mode: "none" }` does |
| `queue` | The one channel queue that every conversation and channel operation shares |
| `services` | The services plugins provide to each other, read by key: `services.get(SCHEDULES)`; see [services](#services-what-plugins-provide-to-each-other) |
| `attachments` | Files a plugin takes from a person outside a turn, such as an upload, kept for a conversation until a turn uses them: [`attachments`](#contextattachments-files-from-outside-a-turn) |
| `surfaces` | Every contributed [chat surface](#surfaces-a-chat-network-of-your-own), chosen by the prefix of a channel key: `of`, `sendReply`, `startTyping`, `showStop`, `react`, `unreact`, `prompts` |
| `turns` | Runs one turn of a conversation your claim owns, over the runtime and the surfaces: [`turns.run`](#personas-and-contextturns-conversations-of-a-kind-of-your-own) |
| `observe(filter, observer)` | Hears inbound messages without owning or admitting them: [`observe`](#observe-hearing-messages-without-owning-them). Returns a function that stops it; may be called during `setup` |
| `directChannels` | Every plugin's [direct channels](#directchannels-reaching-a-person-on-their-own): `providers()`, `reach(principalId)`, `known(principalId)`, and `notify(principalId, text)` |
| `sessions()`, `conversations`, `surfaces`, `directChannels`, `turns`, `dashboard()` | Linked once every plugin has been set up; calling them during `setup` throws `NotLinkedError` |

`sessions()`, `conversations`, `surfaces`, `directChannels`, `turns`, and `dashboard()` are available from a service's `start`, an event handler, a session tool, or a claim's turn.

Use `QueuePort` from the main entry for `context.queue`; the kit's `ChannelQueue` is also type-only.

`context.core` of 0.1.0 is gone: reading it throws a `PluginError` that names `context.services`.

### Logging and error reports

`context.logger` is a child of the host's logger and adds `plugin: <your plugin's name>` to each line in the journal.
`Logger` has five levels and `child(fields)`; you can pass an existing pino logger as `DefineOverrides.logger`.

With `defineRoundtable`, the host's logger sends every `error` and `fatal` line to the ops agent named by `config.routing.places.ops` as `{ agent }` (or the deprecated `config.ops.agent`), which reports it in its primary place, or, with a conversation key there (or `config.ops.conversation`), to that conversation as a visible message and a report turn its claim answers.
The report turn is the host's own background turn of the `owner` target: it runs as the system principal (`SYSTEM_PRINCIPAL`) at the owner tier, as in 0.8, and so does the report turn of an outside Discord webhook's post in an agent's channel, whose text is untrusted input; neither can set up a schedule or delegate a task. The host does not start, with a `ConfigError` naming `config ops.conversation` (or `config routing.places.ops`) and the reason, when no chat surface serves the key, no plugin's claim owns it, no plugin contributes the `owner` background target, the claim that owns it takes no background turns (has no `background`), or that claim says `takesSystemReports: false`, since its conversations are each private to their person and refuse the system principal's turns; a report is then never only logged. A claim like that is answered at startup, not by a warning at each report.
A webhook's post in an agent's channel starts that report turn with the post's text, and an embed counts as text: the post's embeds (author, title, description, each field as `name: value`, footer, link) follow its own content, plain and at most 4,000 characters, so a CI bot that posts only an embed, such as "Build 42 failed" with the branch and the run's link as fields, reaches the agent as `Webhook "CI" posted in your channel:` followed by those lines. A post with neither text nor embed text starts no turn. A replied-to message's embeds and the embeds in `discord.channelContext` are read the same way.

The core contributes `PERSONAL_TARGET` (`"owner"`) with or without Discord; `ops.conversation` still needs a surface and a claim that accepts system report turns.
Webchat accepts personal background turns but declares `takesSystemReports: false`, so `web:<id>` fails at startup; name a shared conversation of another surface, or an agent with Discord.
It then calls `DefineOverrides.errorSink(entry)` if you supply one; this function must not throw.
A logger you supply reaches the ops agent and `errorSink` only if it forwards its error lines there.
The report names the plugin next to `app` and `module`; the same error is reported at most once an hour, regardless of which plugin wrote it.

`OpsAlerts` in `pi-roundtable/kit` is for a plugin's own alerts, such as a failed push, that the people who run the host should read; it is not the error report above, and a host that wants both uses both.
`new OpsAlerts({ sink?, logger, kinds?, windowMs?, kindCap?, now? })` takes `sink(text, alert) => Promise<boolean>`, which posts the text where those people read it: resolve `true` when it was posted, `false` when you chose not to (log why yourself, for example a channel outside the one guild alerts may go to), or throw. The kit names no discord.js type, so the sink is the only place a transport appears.
The second argument, `alert`, is `{ kind, key, code?, info?, severity? }`, so a sink can choose a picture or a route per kind; a sink that takes only the text still works, and `code`, `info` and `severity` are present only when `raise` was given them. `severity` (`"info"`, `"warning"` or `"critical"`) is yours to set and nothing in `OpsAlerts` reads it.
`raise(key, text, { code?, info?, severity? })` resolves whether the alert was posted. The kind is the key's word before the first colon (`push:group-7` is `push`).
A key is posted at most once per window (one hour by default) and a kind at most `kindCap` times per window (8 by default), whatever the keys, so a fault that touches everything cannot flood the sink. An alert is posted when it is raised, not queued, and what is held back is only counted: `faults()` lists the last fault of each kind, newest first, with its `name` (from `kinds`, else the kind itself), `code`, `raised` and `suppressed`, in memory only, for a status command. `info: true` marks news, not a fault: it posts at most once per key, does not count against the kind's cap and is not listed in `faults()`.
`resolve(key)` says a fault is over: it gives the key back (a new fault under it posts again at once), calls the optional `sink.resolved({ kind, key })` so the sink can mark the alert it posted as recovered, such as by editing its message, and sets `clearedAt` on the kind in `faults()` once none of the kind's alerts is open; a later raise of the kind removes it again. It resolves `true` when it ended an open alert. Resolving a key that was never posted, an info alert, a key already resolved, or one whose post has not finished does nothing and resolves `false`, so it is safe to call from every "the read worked" path. Posted alerts are remembered for `resolve` up to 1,000 keys, the oldest first forgotten, and past the window too: a fault that lasts for hours still resolves. A `resolved` that throws is logged by the error's name and never reaches the caller.

```ts
const sink: OpsSink = Object.assign(
	async (text: string, alert: OpsAlert) => post(text, alert.kind),
	{ resolved: async ({ key }: OpsResolution) => markRecovered(key) },
);
```

A sink that throws or answers `false` gives the key and the kind's slot back, so the next raise tries again, and a throw is logged by the error's name only. `raise` never throws. With no `sink`, alerts are only recorded, the key stays held and the log has one line per window (`an ops alert was raised and there is no sink to post it to`); `posts` tells which. `ErrorReporter` and `OpsAlerts` each keep their own limits, so alerts never count against the error reports' five an hour.

### Services: what plugins provide to each other

A service is something one plugin builds and others read, such as the schedule store or the agent team.
Each has a key made with `serviceKey<T>(id)`, where `T` is the service's interface, or port.
Any object with those methods can provide the service or stand in for it in a test.
List the keys in `provides` and provide each from `setup` with `services.provide(KEY, value)`.
The host reads these lists before setup to find which plugin declares each service.

| Method | What it does |
|---|---|
| `services.get(KEY)` | The service, or a `PluginError` that names the key and the plugin to register first when it is not provided yet |
| `services.find(KEY)` | The service, or `undefined` when no registered plugin declares it, such as an addon that is off; it throws like `get` when a plugin declares it but has not set up yet, because that is order, not absence |
| `services.lazy(KEY)` | A function that returns the service once every plugin is set up, for a service whose plugin is registered after this one; call it from a service's `start`, a handler, or another callback that runs after startup, since calling it during setup throws a `NotLinkedError`. The host refuses to boot, naming your plugin, when no registered plugin provides the key |
| `services.provide(KEY, value)` | Only from setup, only for a key the plugin declares in `provides`, once per key |

The host refuses a plugin that declares a key without providing it when `setup` returns.
It refuses duplicate declarations before any setup.

If your plugin reads a service with `get` during setup, list the key in `requires` (`noteCounter` below).
A wrong order is refused before any migration or setup, with both plugins named.
A key in `requires` must come from a plugin registered before yours.
A service you read with `find`, such as an addon that may be off, stays out of `requires`.
If the other plugin reads your service and has to come after yours, use `services.lazy` to read its service when setup is complete (`earlyNoteReader` below).

The built-in plugins provide these, from the main entry:

| Key | Port | Provided by | What it is |
|---|---|---|---|
| `IDENTITY` | `IdentityService` | `identity` | Who the host serves, read-only: `resolve(facts, { conversation }?)` gives the `Speaker` with its `principalId` behind a surface's `ActorFacts`, or undefined; `principal(id)`, `list()`, `identities(principalId)`, `roles(principalId)`, `tierOf(principalId)` (the lasting roles' tier), `speakerFor(principalId, tier?)` for a turn on someone's behalf, `owners()`, and `principalOf(identity)`, the principal an identity written `<provider>:<subject>` is linked to, such as one a plugin declares in `identities`. Principals are written only by the configuration and `roundtable principal`. `SYSTEM_PRINCIPAL` is the host's own, which no plugin speaks as |
| `IDENTITY_LINKS` | `IdentityLinks` | `identity`, only with `access.selfLink` | Lets a plugin link a person's own account to their principal, which `IDENTITY` cannot: `link(principalId, identity)` and `unlink(identity)`, identities written `<provider>:<subject>`. See [Self-linking](#self-linking). Absent unless the configuration lists the providers; read it with `find` |
| `PROFILES` | `PersonProfiles` | `identity` | How the core names a person: `register(source)` a `ProfileSource` for a provider, `observed(principalId, provider, name)` a name a signed-in session reported, `sourceOf`, `choose`, `of(principalId)` (name, source, whether a picture exists) and `picture(principalId)` (the picture through the source's allowed hosts). Always on. See [Naming people: `PROFILES`](#naming-people-profiles) |
| `CONVERSATIONS` | `ConversationRegistry` | `conversations` | The conversations run through `context.turns`: `register`, `get(key)`, `list({ principal }?)`, `setTitle(key, title)`, and `adopt(key, principalId)` only for migrating a conversation recorded before 0.9; each a `ConversationRecord` of `key`, `surface`, `kind`, `visibility` (`"private"` or `"shared"`), `principalId?`, `title?`, `createdAt`, `lastActiveAt` |
| `MODES` | `ConversationModes` | `modes` | Each conversation's modes, stored per key and kept across restarts: `peek(channel)` gives its `ConversationMode` (`yolo` and `longRunning`, both off by default; `changedBy?`, `changedAt?`) from memory, `set(channel, { yolo?, longRunning? }, speaker)` changes them and throws `PluginError` unless the speaker is an owner other than `SYSTEM_PRINCIPAL`, `onChange(listener)` hears each change, and `autoApproved(entry)` with `onAutoApproved(listener)` report a held call that yolo mode approved. See [Conversation modes](#conversation-modes-modes) |
| `RUNTIME` | `AgentRuntime` | `runtime` | The runtime every conversation turn runs on, the agent server's and `context.turns`': the `runtime` slot's when a plugin fills it, Pi's otherwise |
| `AGENTS` | `AgentServer` | `agent-server` | The `team` (`AgentTeam`), the read-only `directory` (`AgentDirectory`), the `runtime` every agent turn runs on (the same one `RUNTIME` provides), `approvals` (whether the owner's reply approves held actions), `avatars` (`AvatarStudio`), `workspace` (`AgentWorkspace`: the agents' `workDir` and, when set, `scratchDir`), and `routes` (`RoutingTable`: where work no person started lands; see [Routing](#routing-where-work-no-person-started-lands)) |
| `PROMPTS` | `PromptDocuments` | `prompts` | The prompt texts the owner edits in the app, each with a file version, an override and a history: `register`, `text`, `list`, `get`, `set`, `revert`, `history`. Always on; read it with `get`. See [`PROMPTS`: prompt texts the owner edits](#prompts-prompt-texts-the-owner-edits) |
| `SKILLS` | `SkillRegistry` | `skills` (an addon) | What agents carry: `carried`, `carriedNames`, `describeCarried`, `catalog`, `list`, `linkedFrom`, `checkRegistered`, `link`, `attach`, and the owner's whole-SKILL.md edits `document`, `saveDocument`, `createDocument`, `documentHistory` |
| `SCHEDULES` | `ScheduleStore` | `schedule-store` | The stored schedules: `create`, `createWithin`, `get`, `forChannel`, `all`, `update`, `remove`, `due`, `claim`, `recordStatus` |
| `PRECHECKS` | `PrecheckRegistry` | `prechecks` | The host's named [prechecks](#prechecks-wake-a-schedule-only-when-it-has-work): `register`, `get`, `list`; and the runner of agents' precheck scripts: `useScriptRunner`, `scriptRunner` |
| `MEMORY` | `MemoryStore` | `memory` (an addon) | `forSpeaker(principalId)` gives that principal's `SpeakerMemory`: `list`, `forPrompt`, `add`, `search`, `update`, `removeById`, `remove`; `MEMORY_KINDS` is `core`, `note`, `event` |
| `BACKGROUND_TURNS` | `BackgroundTurns` | `modules` | Turns nobody wrote: `runScheduled`, `runDelegated`, `runErrorReport` |
| `CHANNEL_CONTEXT` | `pi-roundtable` | value |
| `ChannelContexts` | `pi-roundtable` | type |
| `ChannelContextSource` | `pi-roundtable` | type |
| `ChannelContextSourceAttachment` | `pi-roundtable` | type |
| `ChannelContextVerdict` | `pi-roundtable` | type |
| `DELEGATION` | `Delegator` | `modules` | `start(request)` a background task, `runningChannels()`, `idle()` |
| `THREADS` | `DispatchThreads` | `threads` | The threads of background dispatches (coding tasks, delegated tasks), on any surface that hosts them: `open(origin, title, intro?)` opens the thread under the channel `origin` through the `threads` of the surface that serves its prefix and resolves to a `DispatchThread`, or `undefined` when that surface hosts none or the channel cannot. See [Dispatch threads on any surface](#dispatch-threads-on-any-surface) |
| `CHANNEL_CONTEXT` | `ChannelContexts` | `channel-context` | `read(message, options?)` gives the context of one addressed message, from the surface whose key prefix its channel carries: the messages posted there since the assistant last posted, or `undefined` for a surface without `channelContext`, a channel that is not shared, and when nothing new was said. See [Channel context](#channel-context-what-was-said-around-an-addressed-message) |
| `WORKER_SESSIONS` | `WorkerSessions` | `worker-sessions` | Fresh Pi sessions for a plugin's own workers, on the host's model login: `delegation` is the host's delegation `model` and `thinking`, and `run({ task, signal, prompt, extensions, toolNames, model?, thinking?, aborted? })` runs the task in a session that has only the tools `extensions` register and `toolNames` names (no built-in tool, skill, context file, memory or agent tool) and returns the worker's final answer; see [Workers of your own](#workers-of-your-own) |

The data types the ports use (`Schedule`, `NewSchedule`, `Agent`, `AgentGroup`, `TeamStatus`, `Memory`, `SkillSet`, `DelegationJob`, and so on) are in the main entry too.
Your plugins run after the built-ins, so they can read every key above.
The Discord connection's key, `DISCORD`, is in the Discord entry, because its port names discord.js types: `DiscordServices` has `connection`, `commands`, `guard`, `threads` (the same instance as `THREADS`), `poster` (see [Posting through `DISCORD.poster`](#posting-through-discordposter)) and `channelContext`; commands are in [`commands.add`](#slash-commands-commandsadd). A plugin's own stand-in for `DISCORD` (such as one written with `as unknown as DiscordServices`) needs a `poster` too before code that posts runs under it; `fakeDiscord()` and `testHost` give one.

To share your own service, export its key as a constant and its port as an interface.
Plugins registered after yours can read it during setup.
An earlier plugin can read it with `services.lazy` from a callback that runs after startup.
Reading it during that earlier plugin's setup throws: `service <id> is not provided yet; plugin <yours> provides it. Register plugin <yours> before plugin <reader>.`

<!-- example: examples/shared-services.ts -->
```ts
import { definePlugin, serviceKey } from "pi-roundtable";

/** What the notes plugin offers other plugins: a port, so any object with these methods will do. */
export interface NoteIndex {
	add(text: string): void;
	all(): readonly string[];
}

/** The key is the service's name. Give its id a prefix of your own; two keys with one id are one service. */
export const NOTE_INDEX = serviceKey<NoteIndex>("my-notes.index");

/** A plugin lists the services it provides, then provides each from `setup`. */
export function notes() {
	const stored: string[] = [];
	return definePlugin({
		name: "my-notes",
		provides: [NOTE_INDEX],
		setup: ({ services }) => {
			services.provide(NOTE_INDEX, {
				add: (text) => void stored.push(text),
				all: () => stored,
			});
			return { services: [{ name: "notes-ready" }] };
		},
	});
}

/** A plugin registered after it reads the service; `find` is undefined when nobody provides it. */
export function noteReader(
	onNotes: (notes: readonly string[] | undefined) => void,
) {
	return definePlugin({
		name: "note-reader",
		setup: ({ services }) => ({
			services: [
				{
					name: "note-reader",
					start: () => onNotes(services.find(NOTE_INDEX)?.all()),
				},
			],
		}),
	});
}

/** A plugin that reads the service in `setup` lists it in `requires`: a wrong order stops the start, naming both plugins. */
export function noteCounter(onCount: (count: number) => void) {
	return definePlugin({
		name: "note-counter",
		requires: [NOTE_INDEX],
		setup: ({ services }) => {
			const index = services.get(NOTE_INDEX);
			return {
				services: [
					{ name: "note-counter", start: () => onCount(index.all().length) },
				],
			};
		},
	});
}

/** A plugin registered before the notes reads them with `lazy`, from a callback that runs after startup. */
export function earlyNoteReader(onNotes: (notes: readonly string[]) => void) {
	return definePlugin({
		name: "early-note-reader",
		setup: ({ services }) => {
			const index = services.lazy(NOTE_INDEX);
			return {
				services: [
					{ name: "early-note-reader", start: () => onNotes(index().all()) },
				],
			};
		},
	});
}

/** A plugin that provides the same key and lists it in `replaces` takes the place of the one before it. */
export function shoutingNotes() {
	const stored: string[] = [];
	return definePlugin({
		name: "shouting-notes",
		provides: [NOTE_INDEX],
		replaces: [NOTE_INDEX],
		setup: ({ services }) => {
			services.provide(NOTE_INDEX, {
				add: (text) => void stored.push(text.toUpperCase()),
				all: () => stored,
			});
			return { services: [{ name: "shouting-notes-ready" }] };
		},
	});
}
```
<!-- /example -->

#### Replacing a built-in service

A plugin that lists a key in both `provides` and `replaces` takes over that service.
The host drops the original plugin and sets up the replacement in its place.
During setup, the replacement can read services from plugins before that position.
The dropped plugin's migrations and setup do not run.
To replace the schedule store, implement `ScheduleStore`, provide it under `SCHEDULES`, and replace it:

```ts
definePlugin({
	name: "my-schedules",
	provides: [SCHEDULES],
	replaces: [SCHEDULES],
	migrations: [/* your own tables */],
	setup: ({ services }) => {
		services.provide(SCHEDULES, myStore);
		return {};
	},
});
```

The host checks replacements before setup:

| Message | Fix |
|---|---|
| `plugin <name>: replaces service <id>, which no other registered plugin provides.` | Register the plugin that provides it, or drop the key from `replaces` |
| `plugin <name>: service <id> is also replaced by plugin <other>.` | Keep one replacement per service |
| `plugin <name>: replaces service <id> but does not list it in provides.` | Provide what you replace |
| `plugin <name>: replacing plugin <built-in> would drop <id> too, which it also provides.` | Replace every service of that plugin, or none; `BACKGROUND_TURNS` and `DELEGATION` come from the one `modules` plugin, so they are replaced together |

#### Addons: memory, skills, and Discord administration

The host adds these three built-in plugins by default.
You can switch them off in the configuration.

| Addon | Plugin | Switch in `roundtable.config.ts` | What it adds | When it is off |
|---|---|---|---|---|
| Memory | `memory` (provides `MEMORY`) | `memory: false` | The memory table, keyed by principal, the `memory_add`, `memory_search` and `memory_remove` tools, and the memory block of every system prompt but a `memory: "none"` persona's | No memory tools and no block; the table is left as it is |
| Skills | `skills` (provides `SKILLS`) | `skills: false` | The skill tables, the skill tools of agent sessions (`skill_list`, `skill_link`, `skill_create`, `agent_skills`, and the rest), and the skills every agent carries, `writing-skills` included | No skill tools and no skills in any session; `agent_get` has no skills line; `agent_create` leaves out its `skills` parameter and refuses a call that passes some with `Skills are off on this host`; the tables are left as they are |
| Discord administration | `discord-admin` | `discord: { admin: false }` | The `discord_*` tools that read and manage the server, for the owner; they check what the primary owner may do on the server, whichever owner's turn calls them | No `discord_*` tools; the channel executor that remote MCP uses is the connection's, so it stays |

Switching an addon off leaves its tables and rows unchanged, ready for when you turn it on again.
`skills` also takes the two directories and the skill packages (`skills: { builtinDir, reposDir, packages }`) when it is on.

`skills.packages` lists npm packages the host installed, for example `["pi-workflow-skills"]`.
At startup the registry reads each package's `pi.skills` folders (Pi's package manifest) and offers every skill it finds there as a fourth kind, `package`, beside the built-in, linked and written ones.
A package skill is named by its frontmatter and resolved to the installed file on every read, so upgrading the package changes the skill and nothing is written to the database.
Agents carry package skills and groups include them exactly like the others: `agent_skills`, `agent_create`'s `skills` field, `skill_group_set` and `repo_task` accept their names.
`skill_unlink`, `skill_update` and `skill_delete` refuse a package skill, naming the package, and `skill_link` and `skill_create` refuse a name a package skill already holds.
`SkillCatalogEntry.source` is `{ kind: "package", package }` for them, and the web console's skill list shows the package.
A package that is not installed, a package with no `pi.skills` (or none that holds a `SKILL.md`), two packages offering one name, a package skill with the name of a built-in, linked or written skill: each stops startup with a `PluginError` naming the fix.
A carried package skill that an upgrade removed is reported missing and skipped, as a linked skill whose file vanished is.

Use `find` for an optional addon service; it returns `undefined` while the addon is off.
Use `get` if your plugin needs the addon; it fails with a message naming the switch:

```text
service roundtable.memory is not provided. The memory addon is switched off (config memory: false). Switch it on, or provide the service from a plugin of your own.
```

`serviceKey(id, { absent })` lets your own keys say the same.
Switching an addon off and adding a plugin of yours that provides the same key is equivalent to `replaces`.

##### Memory in the agents' channels

By default every speaker an agent's channel admits reads their own memory there, as in any shared conversation.
`discord: { agentMemory: "owners" }` (or the same key in `discord({ ... })`; `AgentServerOptions.memory`, which the agent server hands the runtime as `AgentSessions.memory`) limits that to the owners: a turn of a speaker below the owner tier has no memory block in its prompt and no memory tools, and its worker tasks load none either, while an owner's turns in the same channel are unchanged.
A guest's turn then records no private memory, so it never makes a `claude-bridge` model refuse the owner afterwards (see the [bridge guard](migration-0.9.md#claude-bridge-guard)).
It does not make the guest's turn safe to run after the owner's: once the owner's turn has loaded memory, the guest's bridge turns are refused, as they are without the option, until the conversation starts fresh.
It applies to the agents' channels and groups only; other conversations keep deciding by their persona.
The default `"everyone"` is the 0.8 and 0.9 behavior.

`discord: { agentSpeakers: "owners" }` (or the same key in `discord({ ... })`) limits who the agents answer: in the agents' and groups' channels only an owner-tier speaker starts a turn, and a message from an admin or member gets no reply and no turn. The default `"everyone"` answers every speaker the access rules admit. An outside webhook's post in an agent's channel is a report turn either way. Scheduled turns and delegated-work reports started for a non-owner are skipped the same way. Under `"owners"` a member's message can still reach an owner's turn as channel context. Use it on a host whose `access.admins` or `access.members` admit Discord: a non-owner turn runs in the agent's home session, shared with the owners, so it can read earlier owner conversation and shell output and leaves history that owner turns inherit. `roundtable doctor` warns about that combination.

#### Conversation modes: `MODES`

A conversation can run with less supervision when its owner switches a mode on. There are two:

| Mode | Effect |
|---|---|
| `longRunning` | A turn that reaches its time limit goes on by itself, up to `autonomy.longRunning.maxSeconds` of work, instead of asking on a card. See [long-running conversations](#long-running-conversations) |
| `yolo` | The server approves the held calls whose [hold classes](#hold-classes-and-yolo-mode) it allows itself, before a card is posted, and logs each one. What it allows is `autonomy.yolo.allow` and `autonomy.yolo.card` in the config |

Both are off for a conversation nobody has set. `MODES` stores them in the `conversation_modes` table, one row per conversation key, so they survive a restart, and works for any key; a surface decides who may toggle them. Read a mode where you act on it, with `peek`, which never waits on the database. Change it with `set`, which writes first and updates the memory afterwards:

```ts
import { MODES } from "pi-roundtable";

const modes = context.services.get(MODES);
await modes.set(channel, { longRunning: true }, speaker); // speaker: an owner's Speaker
modes.peek(channel).longRunning; // true
```

`set` throws `PluginError` for anyone but an owner, and for the host's own principal (`SYSTEM_PRINCIPAL`), so a webhook or a report turn cannot switch a conversation to run unattended. A change names only the modes it sets. It logs `conversation modes changed` with the channel, both modes and who changed them. `onChange(listener)` hears every change until the function it returns is called; a listener that throws is logged and the rest still hear it.

When a held call is approved by yolo mode, `ApprovedBy.auto` is `"yolo"` (a person's answer never sets it; `ToolTurn.approvedBy` shows it to the tool), and the approver reports it with `autoApproved(entry)`, which logs `held call approved by yolo mode` and tells the `onAutoApproved` listeners, so a surface can show it. What yolo approves, and what it never does, is under [hold classes and yolo mode](#hold-classes-and-yolo-mode).

## Principals and access

A principal is the person the host serves; an identity is an account or credential linked to that person.
`Speaker.id` identifies the external actor, while required `Speaker.principalId` keys memory, private conversations, schedule authors, notifications, and per-person limits.
Link Discord and web accounts with `roundtable principal link <principal> <identity>` to make them one person rather than two memories.
A 0.8 person's principal retains their old speaker id; new admitted people get opaque `p_<ulid>` ids.

Configure top-level `access.owners`, `admins`, and `members`.
Identities are `<provider>:<subject>` (OIDC uses `oidc:<base64url issuer>:<subject>`), and roles are `<surface>:role:<name>`.
`everyone: ["web"]` admits that surface only; `everyone: true` admits all surfaces and deserves particular care on a host with several adapters.
The primary owner is the first owner, with an explicit `principal` and, on Discord, a Discord identity; Discord administration still acts with that person's permissions.
Owner is granted only through configuration or the principal CLI, never an IdP role.
`provisioning: "admitted"` is the default; `"linked"` admits only already linked identities.
A map gives the mode per surface, such as `provisioning: { web: "admitted", discord: "linked" }`: with `members.everyone: ["web", "discord"]`, a Discord id someone linked is served at member, an unlinked one is refused and not recorded, and web admits as before. A surface the map leaves out is `linked`, so a misspelled name cannot admit everyone; the one-word form and an omitted field stay `admitted`. `roundtable doctor` warns about a map key that is not a known surface and prints the effective mode.
A disabled principal is refused, and CLI changes reach a running host within the identity cache's 30 seconds.

### Reading who someone is without recording it: `peek` and `partial`

`IDENTITY.resolve(facts)` is the call for a contact that happens: it links a first contact, may admit a new principal, and records the person as seen at their tier.
`IDENTITY.peek(facts, { conversation }?)` only reads.
It never links, claims, admits or records, also when it refuses, and it gives the tier `resolve` would give now: the principal's lasting roles together with what the access rules give these facts, never the tier last recorded.
It answers undefined for an identity nothing is linked to, for a disabled principal, and when no tier results.
Use it where a request must be checked again and again, such as a web session, so the check leaves no trace; a first contact still goes through `resolve`.
A plugin that replaces `IDENTITY` adds `peek` to its service.

A surface that cannot see everything a person holds reports `partial: true` in its `ActorFacts`.
The facts then show less than the person may hold, so `resolve` never records a lower tier from them and never records them as a refusal, as it does for Discord facts that lack the roles the rules decide by.
The owner app sets it on every app sign-in, because an identity provider's roles for another application say nothing about this one.

`oidcProvider(issuer)` and `oidcIdentity(issuer, subject)` from `pi-roundtable/kit` write the provider `oidc:<base64url issuer>` and the identity `oidc:<base64url issuer>:<subject>` that `access.owners[].identities`, `selfLink.providers` and `ActorFacts.provider` take.

### Self-linking

`access: { selfLink: { providers: ["discord"] } }` lets a plugin link the account a person controls to their principal.
A plugin that proved who someone is, such as one that checked a one-time code a signed-in person read out, calls `IDENTITY_LINKS.link(principalId, "discord:<user id>")`; the host provides the service only when `selfLink` is configured, so without it `services.find(IDENTITY_LINKS)` is undefined and `services.get` explains how to switch it on.
The plugin proves the person; the host only checks the rules below, so it must not link an identity it has not verified.
`token` and `legacy` cannot be listed: they are credentials and carried-over ids, not a person's own account. An OIDC provider is listed in its full form `oidc:<base64url issuer>`; a bare `oidc` is refused.

`link` throws `IdentityError`, and changes nothing, for a provider `selfLink` does not list, text that is no identity, the system principal, a principal that does not exist, a principal holding the owner role (owners' identities are linked in `access.owners` or with `roundtable principal link`), and an identity already linked to another principal, whoever linked it.
The owner check is part of the link's own database transaction, so a role another process granted a moment ago is seen; an owner role granted after a self link was made leaves that link in place.
Linking the identity again to the same principal changes nothing and keeps the source it already has.
The link has the source `self`, which `roundtable principal show` and `list` print.
`unlink(identity)` removes only a `self` link and answers true when it removed one, false when there was no self link to remove (the identity was linked to no one, or its link went away meanwhile); a link the configuration, a plugin, the CLI, a first contact, or a 0.8 claim made throws `IdentityError`, and a link another source took over meanwhile is kept.
The host logs the principal id and the identity on each, never a name.
A plugin that replaces `IDENTITY` must replace `IDENTITY_LINKS` too when `selfLink` is configured, as the host refuses a partial replacement.
A link made here is served at once by this process; another process sees it within the identity cache's 30 seconds.

Surfaces report verified `ActorFacts`, not authority.
The router resolves them through `IDENTITY` before admission and overwrites a surface's own `message.speaker`.
A claim must ignore a message without a resolved speaker and run an admitted message as that speaker, rather than reconstructing one at an assumed tier.
Old author fields are a warned fallback until 1.0.
A plugin initiating a turn on someone's behalf uses `IDENTITY.speakerFor(principalId)` and passes the speaker explicitly; `runTurn` without one is refused.
A plugin's own credential bindings accept only `token:` (see [the plugin object](#the-plugin-object)), never a surface's account.

The example below reads only the current principal, so two linked actors ask about the same person and owner tier alone cannot invent a missing principal.
Put its `access` in the host configuration and its plugin in `plugins`.

<!-- example: examples/principals.ts -->
```ts
import {
	type AccessConfig,
	definePlugin,
	defineTool,
	IDENTITY,
	ToolRefusal,
} from "pi-roundtable";
import { Type } from "typebox";

/** One person may have several identities; surface roles never make an owner. */
export const access = {
	owners: [
		{
			principal: "operator",
			name: "Ada",
			identities: ["discord:966666600000000001", "token:remote-mcp"],
		},
	],
	members: { roles: ["web:role:App.User"] },
	provisioning: "admitted",
} satisfies AccessConfig;

/** Ask about the current principal, not the external actor or the primary owner. */
export const principals = definePlugin({
	name: "principals",
	requires: [IDENTITY],
	setup: ({ services }) => {
		const identity = services.get(IDENTITY);
		return {
			tools: [
				defineTool({
					name: "principal_who",
					description: "Show who this turn is for.",
					parameters: Type.Object({}),
					minTier: "member",
					run: async (_args, turn) => {
						if (!turn.speaker)
							throw new ToolRefusal("No speaker for this turn.");
						const person = await identity.principal(turn.speaker.principalId);
						if (!person || person.disabled)
							throw new ToolRefusal("This principal is not available.");
						return `${person.displayName} (${person.id})`;
					},
				}),
			],
		};
	},
});
```
<!-- /example -->

<!-- example: examples/principals.test.ts -->
```ts
import { expect, test } from "bun:test";
import { IDENTITY, type Speaker } from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import { access, principals } from "./principals.ts";

test("two actor identities of one principal ask about the same person", async () => {
	const lookedUp: string[] = [];
	const harness = await testPlugin(principals, {
		services: [
			servicePair(IDENTITY, {
				principal: async (id) => {
					lookedUp.push(id);
					return { id, displayName: "Mo", disabled: false };
				},
			}),
		],
	});
	try {
		for (const id of ["discord-actor", "web-actor"]) {
			const speaker: Speaker = {
				id,
				name: "Mo",
				principalId: "p_mo",
				tier: "member",
			};
			expect(await harness.runTool("principal_who", {}, { speaker })).toBe(
				"Mo (p_mo)",
			);
		}
		expect(lookedUp).toEqual(["p_mo", "p_mo"]);
	} finally {
		await harness.stop();
	}
});

test("an unavailable principal is refused even at owner tier", async () => {
	const harness = await testPlugin(principals, {
		services: [servicePair(IDENTITY, { principal: async () => undefined })],
	});
	try {
		expect(
			await harness.runTool(
				"principal_who",
				{},
				{
					speaker: {
						id: "actor",
						name: "Ada",
						principalId: "operator",
						tier: "owner",
					},
				},
			),
		).toContain("This principal is not available.");
		expect(access.owners[0]?.principal).toBe("operator");
		expect(access.members.roles).toEqual(["web:role:App.User"]);
	} finally {
		await harness.stop();
	}
});
```
<!-- /example -->

For existing hosts and compatibility aliases, read [Migrating to 0.9](migration-0.9.md).

### Naming people: `PROFILES`

A person's linked accounts each carry a name and maybe a picture, and a host decides which one represents them.
`PROFILES` (provided by the `identity` plugin, always) holds the sources and the choices:

```ts
setup: ({ services }) => {
	services.get(PROFILES).register({
		provider: "github",
		label: "GitHub",
		modelVisible: false,
		pictureHosts: ["avatars.githubusercontent.com"],
		fetch: async (login, signal) => {
			const user = await (await fetch(`https://api.github.com/users/${login}`, { signal })).json();
			return { name: user.name ?? login, pictureUrl: user.avatar_url };
		},
	});
}
```

- **Who names a person.** Their stored choice (`choose(principalId, provider)`, which refuses a provider they have not linked; `null` returns to the default), else the first provider in `profiles.prefer` they have linked, else nobody, and `of` falls back to the principal's display name.
- **Observed names.** A surface that signs a person in reports the name its identity provider gave (`observed`), so an OIDC issuer names people with no fetch. It is held in memory for an hour and renewed by each sign-in.
- **A fetch** has two seconds. A miss, a failure or a timeout is remembered for ten minutes, so the name on the hot path costs the wait at most once per person per ten minutes. Fetched and observed names and picture addresses stay in memory for an hour at most and are written to no table; only the choice (`principal_profile_choices`) is stored.
- **What agents read.** `Speaker.name` from `IDENTITY.resolve`, `peek` and `speakerFor` is the profile name only for a provider the host lists in `profiles.modelVisible`; the source's own `modelVisible` flag never decides it. With no source, no observed name and an empty list nothing changes. Names are made safe first: control characters become spaces and at most 80 characters remain.
- **Pictures.** `picture(principalId)` fetches only an `https` address on the source's `pictureHosts`, follows no redirect, accepts PNG, JPEG, GIF and WebP only (an SVG is refused), at most 2 MiB, and answers `nosniff` and `private, max-age=3600`. The bytes stay in memory for an hour, and a failure is remembered for ten minutes.

```ts
export default defineRoundtable({
	// ...
	profiles: {
		prefer: ["line"],        // LINE names whoever linked it and has not chosen
		modelVisible: ["line"],  // and agents read that name
	},
});
```

`pi-roundtable-line` ships `lineProfileSource(services.get(LINE).api)`, a source for provider `line` over LINE's `/v2/bot/profile/{userId}` (picture hosts `profile.line-scdn.net` and `obs.line-scdn.net`, `modelVisible: false`).
`roundtable principal show` prints the source a person chose.

## Tiers: who may use what

Every turn has a speaker with a tier: `owner`, `admin`, or `member`, from most to least trusted.
By default, only the configured owner speaks.
The operator can open admission through `access` and is responsible for that setup.
A turn's `kind` chooses a persona, never a tier.

Each tool names the lowest tier that may call it.
The bot offers the tool in turns whose speaker is at that tier or above; the operator's `toolTiers` setting can override the plugin's choice.
Tools with no tier assigned require the owner.
A plugin that adds raw session tools names their tiers with `toolTiers`; the core's own table names only `ask_user`, `compact_session` and `read_attachment`.

## The parts

Each heading below is a key `setup` may return.
A key the contract does not have stops the start and names the closest one.

### `context.attachments`: files from outside a turn

A surface that takes a file as it arrives, such as Discord, hands the core a link, and the core downloads it into the conversation's attachment directory.
The downloads of one message and of the message it replies to share a 60 second deadline, and a file that sends no byte for 10 seconds (the wait for its headers counts) is given up at once, so a stalled download costs 10 seconds, not the whole deadline. A file still to come when the deadline passes, a file that went quiet (`download failed: idle_timeout`), or one whose directory cannot be made, is reported as `download failed` and the turn goes on without it. `attachmentsOf(message, dir, logger, fetch?, { deadlineMs?, idleMs?, signal?, prepareImages? })` takes both limits; on the agent server they are `discord.attachmentDownload: { deadlineMs?, idleMs? }` (each 1,000 to 600,000 ms; defaults 60,000 and 10,000), for a host on a slow link or with large files. A failure reason carries a code only (`download failed: ENOTDIR`, `download failed: TimeoutError`, `download failed: error`), never the error's text, which could quote a path of the host.
`prepareImages: false` (default `true`) downloads the files only: `images` is empty and an image that cannot be decoded is not reported, for a host that hands the files to the attachment store, which prepares the images itself, so they are not decoded twice and a failure is not reported twice.

A surface may take files larger than the 25 MiB every surface has by default. It declares `maxAttachmentBytes` (a positive integer of bytes) on its `ChatSurface`, and `attachmentsOf` takes the same number as `maxBytes`; the limit holds a ref's reported `size`, a file, a stream and a download alike, and a file over it is reported as `larger than <n> MB (<bytes> bytes)` (`larger than 25 MB` by default, which is what Discord keeps). A surface that stored the file itself hands it over without reading it into memory: `readAttachment(channel, ref)` (and `read` for `attachmentsOf`) may answer an `AttachmentContent`, which is the bytes, `{ path }` (an `AttachmentFile`: the absolute path of a regular file the surface owns, not a symlink; copied into the conversation's attachment directory and left where it is) or a `ReadableStream<Uint8Array>` (stored as it comes). Neither is held whole in memory, and the count is kept while they are copied, so a file that grows is cut off at the limit; a failed or cut-off copy leaves nothing behind, and a path that is relative, a symlink or not a regular file fails that file with `download failed: EINVAL`, a missing one with `ENOENT` (the error's code). The file is opened once and read from that handle. `context.attachments.save` stays capped at 25 MiB; only a surface's own attachments take its `maxAttachmentBytes`. A stored file over 25 MiB is not inlined: an image is not shown to the model (it is reported as an image that could not be decoded) and `read_attachment` refuses a text or PDF file that large, saying it is too large to read as text; the `## Attachments` block marks the file `too large for read_attachment; kept as a file for tools`, and a tool takes it through `turn.attachment(file)` (`stream()` reads it without buffering it). Smaller text, PDF and image files behave as before.
A plugin whose clients upload a file themselves, over HTTP for instance, has the file before any turn exists.
`context.attachments` keeps such a file for the conversation until a turn uses it:

| Call | What it does |
|---|---|
| `save(channel, principalId, { name, contentType, data })` | Keeps the file for that principal in that conversation and returns a `StoredAttachment`; its `file` is the name to hand back to the client. Refuses a file over 25 MiB (`too_large`) |
| `turnAttachments(channel, principalId, files, options?)` | Takes the `file` names `save` returned and returns the turn's `TurnAttachments`; pass it as `attachments` to [`turns.run`](#personas-and-contextturns-conversations-of-a-kind-of-your-own). Each file moves into the conversation's attachment directory, up to four images are prepared for the model, and the turn's prompt lists every file under `## Attachments`. Refuses the whole set when one name is unknown or already used (`unknown_file`), or when `options.usedBytesLimit` would be passed (`quota_exceeded`); then none moves, even when other calls for the same principal run at once |
| `remove(channel, principalId, file)` | Discards a saved file no turn used; `false` when there is none |
| `discardPending(olderThan)` | Discards every saved file no turn used that was saved before the date, and returns how many; call it from a service's timer so abandoned uploads do not pile up |
| `pendingBytes(principalId)` | The bytes the principal has saved that no turn used yet, for a quota of your own |
| `expireUsed({ olderThanMs })` | Optional on a custom port; the host's own has it. Removes the files turns used more than that long ago and returns `{ files, bytes, unattributedBytes }`; the owners' used-bytes tallies shrink by exactly the bytes removed. See [Retention](#retention-removing-used-files-after-a-period) |

A saved file waits for its owner: only the principal that saved it can use it, and only in the conversation it was saved for.
The conversation's record decides who may save into it: a private conversation refuses every principal but its own with an `AttachmentRefusal` whose `code` is `forbidden`, and a shared one lets each principal save and use their own files.
**The plugin that owns a channel checks that the caller may use it, before every call.** The port knows only the conversation's record: a channel with no record yet, such as a conversation opened but not written in, is admitted for every principal, and so is every channel on a host with no conversation registry. A plugin that takes the channel key from a person (a URL, a frame) and passes it on unchecked lets that person stage files into, and move files into the attachment directory of, a conversation that is not theirs. Check first that the channel is the person's, as the web chat does before it saves or uses a file.
`usedBytesLimit` caps what one principal's turns keep, across all their conversations; the core sets no limit of its own, and a deleted conversation gives its bytes back.
Deleting a conversation (`runtime.deleteConversation`) also removes its attachment directory, the files saved for it that no turn used, and its share of the tally.
The calls reject with `AttachmentRefusal`, and throw a `PluginError` when the host has no `dataDir` (a host built by `defineRoundtable` always has one).
The core limits only the size; the types a plugin accepts, the number of files, and the rate are its own to limit.

Once a turn has used a file, the model reads it with `read_attachment`, and a tool reads it with `turn.attachment(file)` (see [`tools`](#tools-what-agents-can-call)).

#### Retention: removing used files after a period

Left alone, a file a turn used lives as long as its conversation.
A host that must not keep uploads (for privacy, say) sets a retention period, and the core removes used files that old:

```ts
export default {
	// ...
	attachments: { retention: { maxAgeMs: 7 * 24 * 60 * 60_000 } },
} satisfies RoundtableConfig;
```

`maxAgeMs` counts from the turn that took the file, not from the upload, so a file that waited a day before a message used it still lives its full period.
The host sweeps when it starts and then every `sweepEveryMs` (default one hour, never more than `maxAgeMs`); a host built without `defineRoundtable` passes the same object as `RoundtableOptions.attachments`.
It needs a `dataDir`, and `maxAgeMs` and `sweepEveryMs` must be positive whole numbers of milliseconds: a host that cannot keep the setting stops at start and names it.
A plugin that wants its own schedule calls `context.attachments.expireUsed({ olderThanMs })` itself.

A sweep, for each person who used files:

- runs with that person's other attachment calls, one after another, so it never races a message taking files; a conversation deleted meanwhile is skipped, not brought back;
- removes the file, then replaces its record with a mark that keeps no file name or type, then takes exactly the removed bytes off that person's used-bytes tally for the conversation. A failure part way leaves a tally that is too high, never too low, and the next sweep finishes the job. The `usedBytesLimit` allowance a plugin enforces (the web chat's `usedAttachmentBytesPerPrincipal`) comes back as files expire, instead of filling for good.

After that, `read_attachment` and `turn.attachment(file)` answer a clear refusal that the file "was removed after its retention period", with neither a host path nor a bare "not found". The refusal is the only trace; the person's name for the file is gone.
Files waiting for a turn are not touched: `discardPending` is theirs.
A file a turn used under an earlier release has no recorded owner; the sweep ages it by the file's modified time and gives its bytes back to the one person with a tally in that conversation. When several people have tallies there, it removes the file but cannot tell whose bytes they were, so no tally shrinks and the bytes are reported as `unattributedBytes`; deleting the conversation clears the tallies.
Only files taken through `context.attachments` are covered. Files the core downloads from Discord links keep their conversation's lifetime.
The host logs counts only (`files`, `bytes`, `unattributedBytes`), never a file name, and a failed sweep only its error code.

### `tools`: what agents can call

`defineTool` takes a name (lowercase words joined by underscores), a description the model reads to decide when to call it, a Typebox parameter schema, the lowest tier that may call it, and the function.
`run` receives the arguments, already typed, and the turn: the speaker, the channel, the agent, an abort signal, `workspace`, `attachFile`, `attachment`, `attachments`, `origin`, and `client`.
`turn.workspace` is `{ workspace, scratchDir? }` in a session with a shared workspace (an agent's), the same roots as `SessionContext.workspace`, and undefined elsewhere: a tool that makes a file can save it there, under the scratch dir when there is one, and name its path, so the model sends it on with `attach_file` or a `discord_send_message` file `path` instead of carrying its bytes.
A plugin that shows or serves the agents' files, outside a turn, reads the same two directories from `AGENTS.workspace` (`{ workDir, scratchDir? }`, read-only data from the agent server's options; the directories may not exist yet), and checks a path against a directory it serves with `within(parent, child)` from `pi-roundtable/kit` (a lexical test of two absolute paths; resolve symlinks with `realpath` first, as `attach_file` does).
It returns the text the model reads, or `{ text, images? }` (`ToolOutput`) to show the model images beside it: each image is `{ mimeType, data: Uint8Array }` and reaches the model as an image part of the tool result.
`turn.origin` is where the turn's request came from, as the transport that carried it reported it, and undefined when the channel gives none: the web chat sets it to the browser origin its connection opened with (`https://chat.example.com`, `chrome-extension://<id>`), a Discord message, a schedule or an agent's turn leave it undefined.
Only a channel's transport sets it, never the message text or the model, so a tool may write it on a record it creates, such as an issue's source line; a tool that needs it fails closed when it is undefined.
A claim passes it to `context.turns.run` as `origin`, and the hold of the same call sees it too, since `hold` receives the same `ToolTurn`.

`turn.attachment(file)` opens a file someone attached to the conversation, by the name the turn's `## Attachments` block lists, and returns `{ file, name, contentType, size, bytes(), stream() }` (`stream()` is the content as a `ReadableStream<Uint8Array>`, for a file too large to hold in memory): a tool passes a user's file on without the model carrying its bytes.
Only the conversation's own files open; a path, a hidden name, or a missing file throws a `ToolRefusal` the model reads, and so does a file the host's [retention period](#retention-removing-used-files-after-a-period) removed, which says so.
`turn.attachments?.()` lists those files, the newest first, as `{ file, name, contentType, size, addedAt }` (`ToolAttachmentInfo`): the names `attachment` opens and nothing else; a session that keeps no attachments lists none. The turns the core builds always have it; it is optional on the type for code that builds a turn by hand.
Throw `ToolRefusal` for a call the model should correct; any other error fails the call.

##### `turn.client`: asking the party that started the turn

Some transports carry a client that can do something for a tool: the web chat's browser extension can read the page the person has open.
`turn.client` is that client's `ClientPort` when the turn's transport provides one and the client declared it, and undefined otherwise (a Discord message, a schedule, an agent's turn, and a web chat connection that declared nothing have none), so a tool that needs it fails closed with a `ToolRefusal` when it is undefined.
`client.names` lists the functions the client declared, and `client.call(name, args, { timeoutMs?, maxValueBytes?, signal?, approval? })` asks it to run one. `approval: { prompt }` names the approval the call acts on, normally `{ prompt: turn.approvedPrompt }` for a tool whose hold the person approved: the transport hands it to the client beside the call (the web chat as `client_call.approval`, see its README), so a client can check that the person approved this very card before it acts. A call without `approval` carries no such field; the core does not judge it, the client does.
The call never rejects for a transport problem: it resolves `{ ok: true, value, parts }`, with the value the client answered with and its binary `parts` (`{ mimeType, data }`, such as a screenshot), or `{ ok: false, error, message }` where `error` is `no_client`, `refused`, `timeout`, `cancelled`, `disconnected`, `too_large`, `busy`, or `failed`.
One call is open on a client at a time: a second one made meanwhile resolves `busy`, so make calls one after another.
The core gives every call the turn's `signal`, so stopping the turn cancels the call in flight (`cancelled`) and the tool need not handle it.
The value and the parts come from the client, outside the host, so a tool treats them as untrusted data: it checks their shape, and passes images on as `ToolOutput` images rather than trusting their names or types.
The transport sets `client` and bounds each call (its default timeout, its ceiling and its size limits); a claim passes it to `context.turns.run` as `client`.

<!-- example: examples/tools.ts -->
```ts
import { definePlugin, defineTool, ToolRefusal } from "pi-roundtable";
import { Type } from "typebox";

/** Tools are what agents can call; each names the lowest tier of speaker whose turns may call it. */
export const notes = definePlugin({
	name: "notes",
	setup: () => {
		const saved: string[] = [];
		return {
			tools: [
				defineTool({
					name: "note_add",
					description:
						"Save a short note. Call it when asked to remember something.",
					parameters: Type.Object({ text: Type.String() }),
					minTier: "member",
					run: ({ text }, turn) => {
						// A refusal is read by the model, which can correct the call.
						if (text.trim() === "")
							throw new ToolRefusal("The note is empty. Ask what to save.");
						saved.push(text);
						return `Saved note ${saved.length} for ${turn.speaker?.name ?? "nobody"}.`;
					},
				}),
			],
		};
	},
});
```
<!-- /example -->

The tool names `bash`, `read`, `edit`, and `write` belong to the agents already.

#### Attach files to the agent's reply

Call `turn.attachFile(file)` from a tool's `run` to queue a file for the turn's reply, and still return the text the model reads.
A `ReplyFile` is `{ name: string; data: Uint8Array }`: raw bytes, including images, not a path or base64 string.
The core copies the bytes when the call succeeds, so the tool may reuse its buffer afterwards.
The tool does not send a message itself; the successful turn returns `TurnResult.files` and the reply path hands them to the surface as `OutboundReply.files`.
On Discord, files follow the text as one file per message to avoid image grids, all through the same agent webhook name and avatar as the text.
Other surfaces may send the text and files in one message or a message group.
The [drawing package source][drawing-source] uses `turn.attachFile` to deliver images produced by its tools.

<!-- example: examples/reply-files.ts -->
```ts
import { definePlugin, defineTool } from "pi-roundtable";
import { Type } from "typebox";

/** A small PNG keeps this example runnable without an image provider. */
export const imageReply = definePlugin({
	name: "image-reply",
	setup: () => ({
		tools: [
			defineTool({
				name: "reply_image",
				description: "Attach a sample image to your reply.",
				parameters: Type.Object({}),
				minTier: "member",
				run: (_args, turn) => {
					turn.attachFile({
						name: "sample.png",
						data: Buffer.from(
							"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
							"base64",
						),
					});
					return "The sample image is attached to this turn's reply.";
				},
			}),
		],
	}),
});
```
<!-- /example -->

`attachReplyFile(file): void`, `ReplyFile`, `ReplyFileError`, and the frozen `REPLY_FILE_LIMITS` are exported from `pi-roundtable`.
Raw `sessionTools` and Pi package tools may import and call `attachReplyFile` during their awaited tool execution; it is the same function as `turn.attachFile`.
It uses the current asynchronous turn, not a global channel queue, so simultaneous turns and nested conversation turns keep separate files.
A Pi package should use the host's peer dependency on `pi-roundtable`, not bundle another copy of it.
Transient `SessionContext.runTask` tasks return only text and cannot attach to their parent's reply.

The model attaches a file it already has on disk with the core's `attach_file({ path, filename? })`. A session with a workspace (`SessionContext.workspace`, an agent's) registers it; the path must resolve, symlinks followed, inside the workspace or the scratch dir, a relative path resolves in the workspace, and `filename` defaults to the path's base name. It queues the file with `attachReplyFile`, so `REPLY_FILE_LIMITS` apply and a surface without reply files refuses it as a tool error; its result tells the model the file will appear with its reply. It holds nothing, since it only posts in the channel the turn answers in, and its tier defaults to the owner, like any tool the core's table does not name.

With an `images` provider, agent and owner sessions also offer the core's `generate_image({ prompt, reference_paths? })`, which draws a new picture from a description (`prompt`, at most 4,000 characters). `reference_paths` lists up to 4 local images, checked like `attach_file` paths (inside the workspace or the scratch dir, symlinks followed, regular files only), each a PNG, JPEG, WebP or GIF by content, at most 20 MiB each and 40 MiB together; a refused reference is a tool error before the provider is called. It passes them to the provider as `ReferenceImage`s with the turn's signal, saves the picture under `<scratch dir or workspace>/drawings/generated-<ISO time>.<ext>`, and attaches it with `attachReplyFile`; when it cannot be attached the file is kept and the result says so. The result names the saved path, never the bytes, so the model can send it on or edit it. A provider error, such as a refusal, is a tool error carrying the provider's message. It holds nothing, and its tier defaults to the owner; `toolTiers` lowers it. The agents' prompt mentions it only when it is offered.
The Discord tools that upload, `discord_send_message` and `discord_edit_message`, take each file as exactly one of `path` (a local file, read when the call runs, with the same roots; `filename` defaults to its base name) or `dataBase64` with a `filename`, at most 8 MiB in all. A session without a workspace takes only `dataBase64`, and so does remote MCP, whose schemas stay inline only. A path outside the roots, a missing file, or a directory is a tool error naming the path. A held call's card (`approvalCard(call, workspace?, limits?, parameters?)`) lists each file it sends by path with the file's size now, never its bytes, and shows an input within `limits.totalChars` (1,500) whole; a longer input has its string values cut, longest first and never below `limits.valueChars` (200), to their start plus `… [N chars]` (N in code points) until it fits, and if it still does not, the rest is dropped and the keys no longer shown are listed. `approvalDetails(call, workspace?)` gives the same call as data (`{ action, tool, input, files? }`, the whole input, files as `{ path, bytes? }`); the gate passes it to `Prompts.confirm` as `details`, for a surface that is not text.

Given `parameters`, the tool's JSON Schema, `approvalCard` shows the input as fields instead of JSON, and the gate does so for every tool the session lists (it reads the schema from the tool list of the Pi session): one line or block per argument, in the order the schema declares its properties (an argument the schema does not list follows them, its name in code format so it cannot pass for a declared label), labelled by the property's `title` or else its name, absent arguments left out; only an argument's own properties count, so one named `toString` or `constructor` is shown with its value. A short value sits on the line (`**label**: value`, with markdown, links and `@everyone`/`@here` in it escaped so nothing in a model-written value formats or mentions anyone); a string with a line break or over 100 characters, and a nested value as compact JSON, go in a fenced block that keeps their line breaks and in which nothing is markdown (`\r`, `\u2028`, `\u2029` and `\u0085` are line breaks too); booleans, numbers and enum values show as they are; an array of scalars is joined with commas, unless an item is empty, shows nothing, holds a comma and a space or a line break, in which case the array is shown as JSON; a string that is empty or shows nothing (white space, zero-width characters) is written out as a quoted, escaped text, such as `""`, so the person sees it is there. `limits` apply as they do to the JSON: a long string is cut, the longest first and never below `limits.valueChars`, marked `… [N chars]`, and when that is not enough the last fields are dropped and their labels listed. A tool with no schema, or one that lists no properties (and a card a plugin builds without `parameters`, such as the coding desk's), shows the JSON as before. The card is text, so every surface that shows `message` shows the fields; `approvalDetails` is unchanged.
Calling the helper outside `context.turns.run` or an agent-team turn, or after that turn finishes, throws `ReplyFileError`; direct standalone runtime calls have no reply collector.
Await work that produces files before returning from the tool.
A standalone isolated worker may wrap its complete awaited turn in `withReplyFiles(supported, run)` from the main entry.
`run` returns `Promise<TurnResult>`; the collector validates any returned files, includes accepted attachments only on success, and deactivates on success, failure, or throw.
The caller must deliver the returned `files` and must not open a fresh collector per tool to evade turn-wide limits.

| Case | Behavior |
|---|---|
| Successful final answer with no text | Files are posted without a placeholder text; a final answer with neither text nor files still fails in the Pi runtime |
| Stopped, timed-out, or failed turn | Accepted files are discarded; only the usual stopped or failure notice is posted |
| A tool fails but the model recovers and completes the turn | Files already accepted remain queued for the successful reply; a tool failure does not roll back earlier attachment calls |
| Unsupported surface | `ChatSurface.supportsFiles` must be `true`; absent or false makes attachment calls throw `ReplyFileError`, which Pi reports to the model as a tool error |
| Too many or too large files | At most 10 files per turn, 10 MiB (10,485,760 bytes) per file, and 50 MiB (52,428,800 bytes) in total across all tools; the exceeding call throws `ReplyFileError` without queuing that file |
| Invalid file | Empty bytes, non-`Uint8Array` data, empty filenames, names over 255 characters, paths, `.`/`..`, or control characters throw `ReplyFileError` |
| A surface rejects delivery | The reply path logs `reply not posted` or `agent reply not posted`; delivery may be partial, is not retried, and does not change the completed runtime result |

A surface declaring `supportsFiles: true` must deliver every `OutboundReply.files` entry with the reply's speaker identity, or reject with an error; its transport may impose stricter limits.
`SurfacePort.sendReply` also refuses direct file sends to a surface without that declaration instead of silently dropping files.
A replacement runtime may return `files` in its successful `TurnResult`; the turn path applies the same limits and capability check before posting.
Use either the helper or the result for each file: returning an already attached file queues a second copy, counted against the same limits.
A custom `ConversationTurnInput.reply(result)` receives `result.files` and owns their delivery instead of the default surface reply.
Test an attachment tool with an injected file-capable surface and inspect `harness.files` (see [`reply-files.test.ts`](../examples/reply-files.test.ts)); `runTool` itself posts nothing.

### `holdRules`, and a tool's `hold`: calls that wait for the owner

A held call is described to the owner, who approves or refuses it in Discord before the call runs.
A tool's `hold` returns the description for its own calls, and `holdRules` are rules over every tool call, asked in order until one describes the call.
Each rule needs a name, unique across plugins.
The [coding package source][coding-source] uses an owner hold for `repo_push`.

<!-- example: examples/holds.ts -->
```ts
import { definePlugin, defineTool } from "pi-roundtable";
import { Type } from "typebox";

/** Holds make a call wait for the owner's approval; the description is what the owner is asked to approve. */
export const cleanup = definePlugin({
	name: "cleanup",
	setup: () => ({
		tools: [
			defineTool({
				name: "file_delete",
				description: "Delete a file in the shared workspace.",
				parameters: Type.Object({ path: Type.String() }),
				minTier: "admin",
				// Returning text holds this call; returning undefined lets it run.
				hold: ({ path }) => `Delete ${path}`,
				run: ({ path }) => `Deleted ${path}.`,
			}),
		],
		// A rule sees every tool call, whoever defined the tool.
		holdRules: [
			{
				name: "cleanup-production",
				describe: (tool, input) =>
					JSON.stringify(input).includes("production")
						? `${tool} touches production`
						: undefined,
			},
		],
	}),
});
```
<!-- /example -->

#### A hold that looks things up

A hold may need something it must fetch as the speaker before it can describe the call, such as the display name of the entity an id stands for, read with the speaker's own credentials.
A tool's `hold` may then return a promise and takes the turn as a second argument: the `ToolTurn` its `run` receives, with the `speaker`, the `channel`, the `agent` and the `origin` of the turn that makes the call.

```ts
defineTool({
	name: "ticket_close",
	description: "Close a ticket.",
	parameters: Type.Object({ id: Type.String() }),
	minTier: "member",
	hold: async ({ id }, turn) => {
		const ticket = await tickets.get(id, turn.speaker, turn.signal);
		return `Close ticket ${ticket.title}`;
	},
	run: ({ id }) => tickets.close(id),
});
```

The gate awaits the description before it posts the card, so the card's bold line, the `action` of `ApprovalDetails` (the web chat's `approval.action`) and the held call all carry the fetched text.

- `turn.signal` aborts when the turn stops, or when the wait ends. A turn stopped while its description is awaited opens no card and holds nothing.
- The wait lasts `HOLD_DESCRIBE_TIMEOUT_MS` (10 seconds, exported from `pi-roundtable/kit`). A rejection, a throw or a timeout holds the call under a generic description (`run <tool>`, in the host's locale), never lets it run: the owner still sees the exact input on the card.
- Returning `undefined` after the lookup lets the call run, as for a hold that answers at once.
- Calls made together are held, and their cards opened, in the order they were made, each with its own description, whichever lookup returns first.
- The agent loop runs one tool call's checks after another's, so hold lookups are awaited one call at a time: a model message with N calls whose lookups all hang waits up to N × `HOLD_DESCRIBE_TIMEOUT_MS` before the last card. This holds in the confirming turn too, where an already approved call still waits for its lookup before it is released. Keep lookups fast and give them a short timeout of their own.
- A hold must change nothing: it may be called again for the same call, such as when the owner's confirming message makes the call again.
- A hold that declares only its arguments and answers at once is called as it always was. Where a host checks the hold with no turn, such as the `holds` of a test harness or a [precheck script](#precheck-scripts-prechecks-the-agent-writes)'s tool call, a hold that declares `turn` is not called; it is described as `run <tool>` and so counts as held.

A hold may also offer the owner's approval card a text to copy, such as the whole message a call would send, by answering `{ text, copy }` (the type `HoldDescription`: the description alone, or `{ text, copy?: { label?, text } }`) instead of the description:

```ts
hold: async ({ customer, body }, turn) => ({
	text: `Send a message to ${(await customers.get(customer, turn.speaker, turn.signal)).name}`,
	copy: { label: "Copy message", text: body },
}),
```

`text` is the description, with every behaviour above; `copy` goes to the gate's `ApprovalDetails.copy` for that call, so the Discord card gets the [copy button](#who-answers-a-prompt-promptscope) with all of its limits (the 20,000 character cap, the label, `discord.cardCopies`), and the web chat forwards it as `approval.copy`. It is part of the same answer, so a rejection, a throw or a timeout drops it with the description: the call is held under the generic description with no copy, and the exact input is still on the card. A `copy` whose `text` is not a non-empty string is left out and the call is still held. The copy is not kept with the held call (`HeldCall` has no copy), so a card the owner answers by a message after a restart has no button, and a host that shows no card, or that checks the hold with no turn, such as a precheck script's call, uses `text` and ignores `copy`. A hold that answers a plain string is unchanged. The copy is visible to anyone who sees the card, so it holds nothing they may not read.

#### Withdrawing a held call

A hold that no longer wants a call it held, because a newer request replaced it or its subject is gone, withdraws it by answering `{ text, supersede }` with an `AbortSignal` of its own and aborting the signal when the time comes (`HoldDescription.supersede`, beside `copy`; a tool's `hold` and a rule's `describeInTurn` both may):

```ts
const replaced = new AbortController();
hold: (args) => ({ text: `send ${args.to} the quote`, supersede: replaced.signal }),
// later, when a newer quote for the same customer replaces it:
replaced.abort("replaced by a newer quote");
```

Aborting does four things, whichever way the call was held, and the abort reason, when it is a text, is the footer the closed card shows (`withdrawalNote(signal, fallback)` gives the one-line text, cut to 200 characters; any other reason, and no reason, gives `fallback`):

- Its approval card closes: controls off and the footer instead of "answer whenever you are ready", **also after the turn stopped waiting** (the card then stays open for as long as the process runs, and now closes by itself). On Discord the message is edited; on the web chat the prompt closes with the outcome `withdrawn` and the reason as `note`. A card that arrives with the signal already aborted is not shown. A surface implements this through `ApprovalOptions.supersede`, which the contract checks (`describeSurfaceContract`: an approval its plugin withdraws resolves `cancelled` and closes, and one answered first stays answered).
- The held call is forgotten: it leaves the held actions (saved so, if it was held for a message), and an approval of the identical call that has not been spent yet, on the card late, or by a confirming message, no longer releases it. A repeated call is described by the hold anew.
- A turn still waiting on the card is told the call was withdrawn (progress reports `refused: "withdrawn"`), not that it was declined or stopped. It does not retry.
- A late answer to the closed card, or a press that was being checked when the signal aborted, answers nothing and starts no turn.

**One outcome.** Withdrawing and approving are the two ways a held call leaves "may run", and the first one wins. An approval that was answered before the abort stands: the call runs once, or has run, and the abort changes nothing, the card keeps its answered footer. An abort that came first wins whatever the card then reports, also on a surface that ignores `supersede`, since the gate decides, not the card. Aborting twice, after the call ran, or after the card was declined does nothing. A call approved late but not made yet is withdrawable until the call is made.

**Identical calls.** A held call is identified by its tool and its canonical input, as everywhere in the gate. Withdrawing a call therefore removes every identical call held for the conversation, including one that another hold (another tool's rule, or a second request from the same plugin) held with the same tool and input, and an approval that is waiting for it. A plugin that needs to withdraw one of two identical requests apart from the other gives the calls different inputs.

**Nothing leaks.** The gate listens to the signal only while the call can still run: from the hold until it is released, refused, or no longer held (the next turn that does not confirm it drops it); a gate that is dropped with its conversation stops listening. A signal that is never aborted keeps nothing alive after that.

**After a restart.** A signal does not survive one, so a withdrawal cannot reach a call held before it: the stored call stays held, a confirming message still releases it, and its card (open cards are in memory) is gone anyway. The hold is what decides then: it describes the repeated call again, and a hold that answers with an already aborted `supersede` refuses the call without opening a card, drops a confirmation of it, and tells the model it was withdrawn. That is how a plugin withdraws what a restart left held.

A rule of `holdRules` does the same with `describeInTurn(tool, input, context, turn)`, which may return a promise, and a `HoldDescription` as well as a string, and which the gate asks instead of `describe` in a turn.
`describe` is still required and is what a host without a turn sees. `holdChain(rules).inTurn(tool, input, context, turn)` asks the rules as a turn does, in order: each rule's `describeInTurn`, or its `describe` for a rule without one.

A rule whose verdict depends on the input, such as one that holds only a `delete` action, can also answer `mayHold(tool)`: whether it may hold some call of that tool. A rule with `approversInTurn` whose answer depends on the input can likewise answer `mayName(tool)`: whether it may name approvers for some call of that tool; without it the rule is taken to name approvers for every tool.
It is asked when the input is not known yet, as for a [precheck script](#precheck-scripts-prechecks-the-agent-writes)'s call whose arguments are computed when it runs; a rule without it is judged by `describe` with an empty input.
A rule whose held call stands for others can answer `approvalTier(tool, input, context)`: the lowest tier that may approve it when higher than the tool's own. The held call keeps it as `minTier`, and both its card and a confirming message require it. A card is answered, and a confirming message accepted, from the speaker whose turn held the call, when their tier is at least `minTier`, and from the owners where the conversation is shared ([who answers a prompt](#who-answers-a-prompt-promptscope)); nobody else in the channel may approve it. The held call records that speaker as `PendingConfirmation.speakerId` and their principal as `principalId`, so a confirming message from another identity of theirs counts after a restart too; a call held without them is the owners' to approve, and one held before 0.9, without a principal, is matched by `speakerId`.

#### Hearing that the card was declined

A hold that opened something of its own for the call, such as a notice that asks for the approval, closes it when the owner declines the card by answering `{ text, onDeclined }` (`HoldDescription.onDeclined`, beside `supersede`; a tool's `hold` and a rule's `describeInTurn` both may):

```ts
hold: (args) => {
	const notice = openNotice(`Send ${args.to} the quote?`);
	return { text: `send ${args.to} the quote`, onDeclined: () => notice.close() };
},
```

`onDeclined` is called once when the call's approval card is declined, whether the turn was still waiting on it or the owner declined after the turn stopped waiting (the call is refused either way, as before).
It is not called when the card is approved, goes unanswered or expires, is cancelled with the turn, or when the plugin withdrew the call with `supersede` first (the plugin did that itself), and a held call that a message does not confirm is simply dropped without it.
A hook belongs to the process that holds the card: a restart loses it with the card, so a plugin that must clean up after a restart does so when the hold describes the repeated call again.
What the hook throws or rejects with is ignored, and so is anything but a function.

#### A hold that makes its card the speaker's alone

By default the speaker whose turn made a held call may answer its card, and in a shared conversation so may every owner. A hold that wants only the speaker to press, such as one whose tool books something under the speaker's name, answers `{ text, approval: "speaker" }` (`HoldDescription.approval`, beside `copy` and `supersede`; a tool's `hold` and a rule's `describeInTurn` both may):

```ts
hold: async ({ draft }, turn) => ({ text: await summaryOf(draft, turn), approval: "speaker" }),
```

- Only the speaker answers the card: their principal, on any of their identities the surface knows, at the call's tier, checked again when they press. An owner's press is refused with the card's own line, the card stays open for the speaker, and the owner's decline is refused too. An owner who is the speaker answers as the speaker.
- It holds for a late press as well: a card answered after the turn stopped waiting is still the speaker's alone, so the turn that follows is started by the speaker.
- A speaker below the call's tier, a turn with no speaker, and a surface that cannot tell who the speaker is get `unavailable` at once, shown to no one, and the call stays held, as for any card nobody may answer. It never falls back to the owners.
- Combined with [approvers](#a-hold-that-names-its-approvers) the card is still the speaker's alone, and the runtime accepts the press only when the approvers name the speaker (or they are an owner); otherwise the call stays held.
- The option governs the card only. A message that confirms the held call is judged as for any call, so an owner's message can still release it. A tool that must act on the speaker's press alone checks in `run` that `turn.approvedPrompt` is set (a message sets none) and that `turn.approvedBy?.speakerId` is the speaker's.
- Anything but `"speaker"` leaves the card as every card is. A surface implements this through `ApprovalOptions.speakerOnly`; the Discord cards and the web chat (whose prompts are its person's alone) honour it, and the contract checks it where a subject declares `speakerOnly`.

#### A hold that names its approvers

A held call is approved by the speaker whose turn made it, or by an owner where the conversation is shared. A tool whose call stands for someone else, such as a message sent under another person's name, can name who approves it instead:

```ts
defineTool({
	name: "customer_message_send",
	description: "Send a message to a customer.",
	parameters: Type.Object({ customer: Type.String(), text: Type.String() }),
	minTier: "member",
	hold: ({ customer }) => `Send a message to ${customer}`,
	approvers: async ({ customer }, turn) => owners.ofCustomer(customer, turn.signal),
	run: async ({ customer, text }, turn) => {
		const by = turn.approvedBy;
		// The runtime already releases the call only for a named principal or an owner; a tool that
		// sends under a name checks again, against its own set, and names the sender from the
		// principal, never from `by.name`, which is only what the person's account calls itself.
		if (!by || !(by.owner || (await owners.ofCustomer(customer, turn.signal)).includes(by.principalId)))
			throw new ToolRefusal("the message was not approved by one of the customer's approvers");
		return messages.send(customer, text, await people.displayName(by.principalId));
	},
});
```

`approvers(args, turn)` returns the principal ids that may approve this call. It is asked, as `hold` is, in the turn that makes the call, with the same `ToolTurn`, the same wait (`HOLD_DESCRIBE_TIMEOUT_MS`) and the same `turn.signal`, once for each call a rule holds; it must change nothing. A rule of `holdRules` does the same with `approversInTurn(tool, input, context, turn)`, and `holdChain(rules).approversInTurn(...)` leaves the principals every rule that names approvers names.

- The named principals approve the call **instead of the speaker**: the speaker whose turn made the call may not answer its card or confirm it by message unless they are named. Owners may still. This holds in every conversation, private or shared.
- Each named principal needs the call's tier (its tool's tier, or the `approvalTier` a rule gives it) when they answer, checked again then, and is accepted only on an identity of theirs the surface knows.
- An empty list leaves the owners alone. A rejection, a throw or a timeout of the lookup does the same: it never widens who may approve.
- In a [private conversation](#who-answers-a-prompt-promptscope) the person alone could answer, so the call is theirs only when they are named or an owner. Otherwise its card resolves `unavailable` at once, shown to no one, and a message confirming it is refused: the call stays held for the people who may approve it. A call above their tier resolves `unavailable` as without names.
- A held call that the speaker cannot approve, in a private conversation or in a shared one whose card expired or that has no prompts, is reported to the model as such: who may approve it by name (never by id), that this conversation cannot, and not to retry it or ask the speaker to confirm; in a shared conversation it asks a named approver or an owner to confirm in the channel. The names come from the runtime's principal lookup; where they cannot be read, the text says "the people named for it".
- The names are kept with the held call as `HeldCall.approverIds`, in the same record as `minTier`, so a message that confirms it after a restart is judged by them: from the speaker or an owner, as before, only when the call names none; otherwise from a named principal or an owner, and only when their tier now holds every held call. The runtime checks this whenever a turn is begun as an approval, so a plugin's own claim that starts a turn with `confirmed` cannot release a call whose approvers exclude its speaker: that call stays held, and the calls the speaker may approve run. A confirming message that holds several calls needs a person every one of them accepts. A row written before this, or by a version that does not know it, names nobody, which leaves the speaker as the approver.
- A call whose rules name no approvers is unchanged, and so is a call held where no turn is known, such as a [precheck script](#precheck-scripts-prechecks-the-agent-writes)'s call when it runs. Saving a script that calls a tool that names approvers is held too: the schedule tool's call is approved by the principals every such call in the script names, or by the owners alone where they cannot be read, or where the script computes a call's arguments and a rule may name approvers for its tool (`mayName`), since the names are not known until it runs.

`run` learns who approved: `turn.approvedBy` is `{ principalId, speakerId, name, owner? }` of the person who pressed the card, or whose message confirmed the call, and the same for a card answered after the turn stopped waiting. It is undefined for a call that was not held, and for a call a surface released without saying who (the web chat does not, for a call that names no approvers); a tool that must know the approver fails closed when it is undefined. `name` is the name the person's identity goes by on the surface, which they may change: look the sender up by `principalId`. `owner` is true when they approved as an owner. A surface reports it through `ApprovalOptions.approvedBy` of `Prompts.confirm`, and `LateAnswer.approvedBy`; for a call that names approvers it must, because the runtime accepts an approval from a named principal or an `owner` only: in a shared conversation an approval that does not say who gave it leaves the call held.

`run` also learns which card approved: `turn.approvedPrompt` is the id of the approval card whose answer released the call, for a tool that must show a client which approval it acts on (it passes it as `approval: { prompt }` in the options of `turn.client.call`). It is set when the person approved the held call on its card, in the turn that asked, or, for a card answered after that turn stopped waiting, in the later turn whose call that approval releases. It is undefined for a call that was not held; for one a message confirmed (no card was involved, and a restart keeps no cards); for one a surface released without a card id; and in a host with no turn, such as a precheck script's call. Discord's id is the one in the custom ids of its card buttons (`roundtable:card:<id>:yes`), the web chat's is the `id` of the `prompt` frame, and a surface reports it through `ApprovalOptions.approvedPrompt` of `Prompts.confirm` and `LateAnswer.prompt`. It comes from the surface, never from the model or the message text; a tool that needs it fails closed when it is undefined.

#### Hold classes and yolo mode

Every held call carries its **hold classes**: ids of the form `<rule>.<class>` that name why it is held. They are what yolo mode (below) judges, and they are recorded with the call as `HeldCall.holdClasses`, so they survive a restart. A rule reports them with `holdClasses(tool, input, context)`, which lists every reason the call is held, not only the first. **Report only classes that are safe to approve with no one looking: a rule that reports classes has opted its calls in to yolo mode**, which approves them unless the config cards them. A rule that reports none leaves its calls **unclassed**: they carry the rule's bare name (`mail` for a rule called `mail`) and yolo cards them, unless `autonomy.yolo.allow` lists that name. A tool's own `hold` is a rule named `tool:<name>`, so it is unclassed, and `autonomy.yolo.allow: ["tool:repo_push"]` approves a `repo_push` tool's calls. Every reported id must start with the rule's name and a dot; one that does not, such as another rule's id, leaves the call unclassed, as does a `holdClasses` that throws. A rule that stands for other rules' calls, as the one that holds saving a precheck script does, declares `relay: true` and may list their ids instead; its calls also carry `<rule>.relay`, so `autonomy.yolo.card: ["precheck-scripts"]` cards them. A rule name has no dot. The same holds for `HoldDescription.classes`, and a hold check built without `holdChain` has no classes: yolo cards its calls. A rule that describes a call in a turn may name the classes in the description instead: `{ text, classes: ["repo.push"] }` (`HoldDescription.classes`). When several rules hold one call, its classes are all of theirs, so one unclassed or carded rule cards it. `holdChain(rules)` reports them as `classesOf(tool, input, context)` and, with the description, as `inTurnWithClasses(...)` (`ClassedHold`), which also asks the rules after the first that holds the call; a hold check built without `holdChain` has none.

**Yolo mode.** In a conversation whose `yolo` mode an owner switched on ([`MODES`](#conversation-modes-modes)), the server decides a held call before any card opens, and approves it without one only when **all** of these hold at that moment:

- the conversation's `yolo` mode is on (read when the call is held, so a card opened before the toggle stays open for a person to answer);
- the turn's speaker is an owner, and not the host's own principal (`SYSTEM_PRINCIPAL`), which webhook and report turns speak as;
- the call names no approvers and its card is not [the speaker's alone](#a-hold-that-makes-its-card-the-speakers-alone);
- the call has hold classes (a call held before this existed, or by a check without classes, is unknown and always asks), and none of them is carded.

A class is carded when it is listed in `autonomy.yolo.card`, when its rule's name is, when it is in `YOLO_CARDED_SHELL_CLASSES` (`pi-roundtable/kit`) and `autonomy.yolo.allow` does not list it, or when it is a rule's bare name (the call is unclassed) and `autonomy.yolo.allow` does not list that name. A class in both lists stays carded. Everything else is approved. So a plugin rule that reports no classes, such as Merlin's `google`, `discord` and `mc` rules or a tool's own `tool:repo_push` hold, asks on a card in yolo conversations until the config allows it by name.

Yolo approves only where there is a turn: a call decided outside one (none of the host's own paths does) is held as before. It covers every owner-attributed turn in that conversation, including turns another agent starts with `message_agent` and turns a schedule starts for an owner's conversation; only turns the host's own principal speaks (webhooks, reports) always ask. Saving a precheck script through a schedule tool is classed by every held call the script makes, so yolo approves the save only if it would approve each of them (an inner call that is unclassed counts as its rule's bare name, and so does one whose arguments the script computes, besides its classes; a computed call of a classed tool counts as the bare name of its own rules, not of `precheck-scripts`); `autonomy.yolo.allow` listing `precheck-scripts` does not cover them, and `autonomy.yolo.card` listing it cards every such save. A redirect or `tee` target the shell cannot expand, such as `> $(printf /dev/sda)` or `> $DISK`, is `shell.disk`. The same holds for the targets of `>|`, `>& file`, `<>` and a `tee` behind a path or wrapper. A command substitution inside double quotes is judged like an unquoted one (inside single quotes it is text), so substitutions in a redirect or `tee` target card under yolo; this is a known cost of failing closed.

```ts
export default {
	autonomy: {
		yolo: {
			allow: ["shell.rm"], // yolo may also approve an rm outside the scratch roots
			card: ["shell.push", "tool:repo_push"], // never approve these, whatever the mode
		},
	},
} satisfies RoundtableConfig;
```

An approved call runs in the same turn. It is reported as approved by the speaker with `ApprovedBy.auto: "yolo"`, logged as `held call approved by yolo mode` (channel, tool, classes, principal) and told to `MODES.onAutoApproved` listeners. A message that confirms a held call works as before. A turn with no card surface is decided the same way, so an owner's own turn there goes on instead of holding the call.

**Plain `git push` and writes outside the workspace are approved under yolo**, because they are the non-destructive shell classes (`shell.push`, `shell.write`). A plain push to `main` deploys wherever a push to `main` deploys. To keep it behind a card, put `shell.push` in `autonomy.yolo.card`; to keep every write outside the roots behind one, put `shell.write` there.

#### The shell rule

`shellHoldRule` in `pi-roundtable/kit` judges the agents' `bash`, `write` and `edit` calls; the agent server links it, and a session without a workspace has no shell.
Its scratch roots are the shared workspace (`HoldContext.workspace`) and the scratch dir (`HoldContext.scratchDir`).
The scratch dir is the config's `scratchDir`, by default `<os temp dir>/<discord.rootCommand>-scratch` (such as `/tmp/roundtable-scratch`); the agent server creates it with mode 0700 at startup and refuses one that is a symlink or another user's, and the agents' `bash` runs with `TMPDIR` pointing to it, so tools that read `TMPDIR` and GNU `mktemp` write there. macOS's BSD `mktemp` ignores `TMPDIR` for a bare `mktemp`; `mktemp -p "$TMPDIR"` works with both, and the agents' prompt tells them to use it.
`AgentSessions.scratchDir` carries it to a runtime, and the agents' prompt tells them to write temporary files there, and to show a file with `attach_file` or a `discord_send_message` file `path` rather than reading an image or base64-encoding it.

- A `>`, `>>` or `tee` target, and a `write` or `edit` path, inside a scratch root run; anything else, the rest of `/tmp` included, is held.
- An `rm` runs when every operand resolves inside a scratch root and none is a root itself or `/`. Operands resolve after the variables assigned earlier in the same command line (`NAME=value` and `export NAME=value` with literal values; `$TMPDIR` is the scratch dir and `$HOME` the service user's home), from the directory of the last `cd`, through `..` and, for paths that exist, symlinks, so a link out of a root is held. A glob is judged by its directory part. A command substitution, an unknown variable, `~user`, an `rm` without operands, and `xargs rm` are held.
- `sudo`, `kill`, `dd`, `mkfs` and the other programs held whatever their arguments stay held, as do service, container, firewall and package changes, `git reset --hard`, and `gh` writes.
- `git push` is held, `force-pushes` for a force push and otherwise as a push to GitHub.

The rule reports the class of **every** held command in the line, including those inside `bash -c`, so a harmless write cannot hide a `sudo` behind it (`echo x > /etc/f; sudo ls` is `shell.write` and `shell.privilege`):

| Class | Held for |
|---|---|
| `shell.privilege` | `sudo`, `su`, `doas` |
| `shell.disk` | `dd`, `mkfs*`, a redirect or `tee` to a device node such as `/dev/sda` (`/dev/null` runs) |
| `shell.power` | `shutdown`, `reboot`, `poweroff`, `halt` |
| `shell.kill` | `kill` and the name-matching killers |
| `shell.rm` | an `rm` outside the scratch roots, or one the line cannot resolve |
| `shell.write` | a redirect, `tee`, `write` or `edit` outside the scratch roots |
| `shell.service` | `systemctl` and `service` changes |
| `shell.docker` | stopping, removing or pruning containers, images and volumes; `docker compose down` |
| `shell.firewall` | `ufw`, `iptables`, `ip6tables`, `nft` changes |
| `shell.packages` | `apt`, `apt-get`, `snap`, `dpkg` installs and removals |
| `shell.push` | a plain `git push` the push policy holds |
| `shell.force-push` | a forced push, and a push that deletes, mirrors or prunes refs (`+` or `:` refspec, `--delete`, `--mirror`, `--prune`) |
| `shell.reset-hard` | `git reset --hard` |
| `shell.gh` | `gh` writes |
| `shell.crontab` | `crontab -r` |
| `shell.unreadable` | a line the rule cannot read to the end, so it cannot rule out a destructive command: longer than 200,000 characters, nested deeper than 48 levels, a here-document or `case` it cannot place, a script built at run time (`eval`, `bash -c` of a variable or a substitution), a shell that reads a script the line does not show as a word (`echo x \| bash`, a here-document or here-string for a shell, `source <(…)`, `. /dev/stdin`, a file the line wrote earlier and then runs, anything `xargs` fills in), `env -S`, a builtin's subscript that runs a substitution (`declare 'a[$(x)]=1'`), `PS4`, `PROMPT_COMMAND` and the other variables that run a command, or a rule that failed while judging |

The rule reads a line the way bash does, so text that only looks like a command stays unheld and text that runs is judged: quotes (`'…'`, `"…"`, `$'…'`, where a backslash escapes the next character), `$(…)` and backticks at any depth, `${…}`, comments (a `)` or a quote in one means nothing), here-document bodies up to their delimiter line (an unquoted body is still searched for substitutions, a quoted one is not), `case` patterns, arithmetic (`$((1<<2))` is a shift), line continuations, leading keywords (`then sudo ls`, `do rm -rf /x`), a descriptor before the command (`3>&1 sudo ls`), `eval`, `bash -c` (also `-ec`), and `find -exec`. Where it cannot tell, it holds the whole line as `shell.unreadable` instead of guessing; an error inside the rule also holds the call. So does a command whose name is a brace expansion, a pattern or a variable the line did not set to a literal (`{sudo,ls}`, `/usr/bin/su*`, `$cmd args`). The rule names programs it knows; a wrapper it does not list (`flock`, `chroot`, `ssh host`) runs its command unjudged. Known gaps: words in arithmetic (`$(( ))`, `(( ))`) are not commands, but a `$(` or backtick inside them is judged. A `bash -c` script is held whole only when the outer shell expands a substitution in it; a single-quoted script is judged like a line. `trap` scripts are judged. `alias NAME=…`, an assignment to `PROMPT_COMMAND`, `PS0`–`PS4`, `BASH_ENV`, `ENV` or `SHELLOPTS`, and `${x@P}` are held as `shell.unreadable`, because bash runs their value later. A line that evaluates arithmetic and also holds a literal `$(` or backtick (`x='a[$(cmd)]'; echo $((x))`) is held as `shell.unreadable`, so `echo '$(date)'; echo $((1 + 2))` is held too. Not followed: array subscripts and `printf -v` that evaluate a value, `source` of a file that defines aliases or traps, and a command run by a program the rule does not list.

The rule follows the variables a line assigns one after another, but bash may skip an assignment (`false && x=ls`, `(V=1)`, a branch not taken) or bind a name where the rule does not look (a loop, `read`, `declare`, `eval`, a function). So a variable the line itself binds is unknown as the name of a command or a script (`x=ls; $x -la` is held as `shell.unreadable`, besides the class of what it would run), and a variable it writes more than once is unknown everywhere, an `rm` operand included; `$HOME` and `$TMPDIR` keep their values.

The rule's one promise (if bash runs a held command, the line is held) is tested against real bash, under `src/core/modules/host-shell/`:

- `shell-policy.differential.test.ts` runs a hand-written corpus of lines in bash 3.2 and 5 on a `PATH` that holds only stubs. The stub `sudo` creates a marker file, the wrappers (`env`, `nice`, `timeout`, `xargs`, `find -exec`, `bash -c`, ...) run the program they are given, and nothing else exists, so nothing destructive runs. Every line that creates the marker must be held.
- `shell-policy.fuzz.test.ts` does the same with generated lines: `shell-fuzz-grammar.ts` composes random lines from the grammar of bash (every quoting kind, escapes, `;` `&&` `||` `|` `&` and newlines including CRLF, subshells, groups, arithmetic, command and process substitution, backticks, here-documents and here-strings with every delimiter form, `case`, `for`, `while`, `until`, `select`, `if`, functions, `coproc`, aliases, redirections, comments, line continuations, `!` and `time`, wrappers, `trap`, `eval`, `bash -c`, brace and parameter expansions) and plants `sudo marker` at random places in many spellings. A line that creates the marker but is not held fails the test and is printed with its seed. It also reports how many lines of everyday commands and of harmless lines over the whole grammar the rule holds (false positives, which are reported and never fail the test).

```sh
bun test src/core/modules/host-shell/shell-policy.fuzz.test.ts                    # 2,000 lines from seed 1, about a minute
ROUNDTABLE_SHELL_FUZZ=100000 bun test src/core/modules/host-shell/shell-policy.fuzz.test.ts   # a long run
ROUNDTABLE_SHELL_FUZZ=1 ROUNDTABLE_SHELL_FUZZ_BASE=<seed> bun test src/core/modules/host-shell/shell-policy.fuzz.test.ts   # one line again
```

`ROUNDTABLE_SHELL_FUZZ` is the number of lines, `ROUNDTABLE_SHELL_FUZZ_BASE` the first seed (the others follow it) and `ROUNDTABLE_SHELL_FUZZ_JOBS` how many bash processes run at once (up to six by default; use `1` on a busy machine); a line is a function of its seed alone. Each line runs in a process group of its own, killed as a whole after 5 seconds or when the line ends, with a cap on the user's processes. A line the fuzz finds goes into the hand corpus, minimized, so the fix stays tested without the generator.

Yolo mode never approves these unless `autonomy.yolo.allow` lists them: `YOLO_CARDED_SHELL_CLASSES` is every class above except `shell.write` and `shell.push`; that includes `shell.unreadable`.

`shellHoldRuleFor({ ownPushOwners?, heldPushRepos? })` (its options are the type `PushPolicy`) is the same rule with plain pushes to the owner's own repositories let through; `shellHoldRule` is `shellHoldRuleFor()`, which holds every push.
A push runs without a hold when all of these hold:

- it does not force (`-f`, `--force*`, a `+` refspec), delete (`--delete`, `-d`, a `:ref` refspec), or push tags or more than its refs (`--tags`, `--follow-tags`, `--mirror`, `--all`, `--prune`), takes no other option than `-u`, `-q`, `-v`, `-n`, `--no-verify`, `--atomic`, `--porcelain`, `--progress` and `-o`, and names no `refs/tags/…` ref or local tag;
- the repository directory is known: `git -C <dir>`, else the last `cd` in the command line, else the workspace; a line with a subshell or `||` does not follow its `cd`;
- every push URL of the remote (the named one, default `origin`, read with `git remote get-url --push --all` with a short timeout and no shell; or a URL given in its place) is a GitHub repository, https or ssh, whose owner is in `ownPushOwners` and whose `owner/repo` is not in `heldPushRepos`.

Git's `-c`, `--git-dir` and `--work-tree`, a `GIT_*` variable before `git`, and any failure to read the remote keep the push held.

```ts
import { shellHoldRuleFor } from "pi-roundtable/kit";

const shell = shellHoldRuleFor({
	ownPushOwners: ["octocat"],
	heldPushRepos: ["octocat/deployed-app"],
});
```

### `PROMPTS`: prompt texts the owner edits

A prompt that comes from a file or the configuration can be made editable by the owner without touching the file.
Register a document during `setup`; read its text with `text()` whenever you build a prompt:

```ts
import { definePlugin, PROMPTS } from "pi-roundtable";

export const persona = definePlugin({
	name: "persona",
	setup: ({ services }) => {
		const merlin = services.get(PROMPTS).register({
			id: "merlin",
			label: "Merlin's prompt",
			description: "Who Merlin is in the owner's conversations.",
			default: () => readFileSync("persona/merlin.md", "utf8"),
		});
		return { personas: [{ kind: "owner", prompt: () => merlin.text() }] };
	},
});
```

- `default` is the file version: a string, or a function called at each read so a default that follows a file is current. The id is 1 to 32 lowercase letters, digits and hyphens; a repeated or unusable id is an `AgentError`, and so is a function `default` that throws when the document is registered, so the host does not start with it. `maxChars` defaults to 20,000.
- The core registers `shared` (`prompts.shared`, the base every agent's prompt starts with) and `guest` (`prompts.guest`, used when the speaker is not the owner). A plugin's own documents are registered by that plugin; the plugin that registers them is set up after `prompts`, so it can `get` the service.
- **The override.** `set(id, text, by, base?)` stores the owner's text in PostgreSQL (`prompt_overrides`, with `prompt_history` beside it; both are additive migrations). While an override is set it wins over the file version, and it is read at every turn, so a change applies from the next turn without a restart. `revert(id, by, base?)` drops it and the file version is back. Text equal to the file version reverts instead of storing a copy. A document has `text`, `fileText`, `overridden`, `differs` (set and not equal to the file) and `override: { by, at }`.
- **Edits from a stale view.** `base` is the text the change was edited from. When it is given, it is compared with the text in force inside the write queue, where the write takes its turn, so two saves from the same text give one write; the other is refused with `PromptConflictError`, whose `current` is the document as it is now. A call without `base` writes as before.
- **A file that stops reading.** When a function `default` throws later (the file was removed), nothing quietly carries on with an old text: `text(id)` throws an `AgentError` naming the document unless an override is set, and logs an error with the document's id; the persona or agent prompt that asked stops the run it was read for (an error in the log, the turn gets no reply) instead of running with the text it was built with, or with none. `list()` and `get()` still answer for every document: the broken one has `broken` (the reason), an empty `fileText` and `differs: false`, and `set` and `revert` refuse it until the file reads again.
- **History.** `history(id, limit?)` lists each change newest first: `action` (`set` or `revert`), `text`, the `previous` text, `by` and `at`. An agent's own prompt keeps the same kind of history through `AgentTeam.promptHistory(name)`; `AgentTeam.update(name, change, by?)` records `by`. A directory agent has no override layer: its stored row is the source, and a seed does not overwrite an existing row.
- **On by default.** The override layer is always on, because nothing is overridden until the owner saves one and the file stays the default. The host logs one warning per document that differs from its file version when it starts, naming who set it and when, and the web app shows a "differs from the file version" badge. Deleting the rows (or using **Revert to the file version**) returns the host to its files.
- `PromptDocuments.set` and `revert` do not check who calls: the owner-only check belongs to the caller, as the web app's routes do it.

### `prompt`: text added to every agent turn

Each section's `build` gets the agent, the speaker (undefined between turns), and the turn's scope.
What it returns is added after the core's prompt, separated by a blank line, in plugin order; returning `undefined` or empty text adds nothing.

<!-- example: examples/prompt.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/** A prompt section is text added after the core's prompt in every agent turn; return undefined to add nothing. */
export const houseRules = definePlugin({
	name: "house-rules",
	setup: () => ({
		prompt: [
			{
				name: "house-rules",
				build: ({ agent, speaker }) =>
					[
						`House rules for ${agent.displayName}: answer in the language you were asked in.`,
						speaker ? `You are talking with ${speaker.name}.` : undefined,
					]
						.filter((line) => line !== undefined)
						.join(" "),
			},
		],
	}),
});
```
<!-- /example -->

A test builds a section the way a turn does: `section.build({ agent, speaker, scope })` takes the agent's `name` and `displayName`, the speaker or `undefined`, and the scope (`name`, `session`, `home`), and returns the text that would be added.

<!-- example: examples/prompt.test.ts -->
```ts
import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { houseRules } from "./prompt.ts";

test("the section names the agent, and the speaker when there is one", async () => {
	const harness = await testPlugin(houseRules);
	const section = harness.contribution.prompt?.[0];
	const scope = {
		name: "guide",
		session: "discord:1",
		home: "discord:1",
	} as const;
	const agent = { name: "guide", displayName: "Guide" };
	expect(section?.build({ agent, speaker: undefined, scope })).toBe(
		"House rules for Guide: answer in the language you were asked in.",
	);
	expect(
		section?.build({
			agent,
			speaker: { id: "1", name: "Ada", tier: "member", principalId: "1" },
			scope,
		}),
	).toContain("You are talking with Ada.");
	await harness.stop();
});
```
<!-- /example -->

### `seeds`: agents created on the first start

A seed has a name, a display name, a prompt, and a prompt for drawing its avatar.
On the first start, the host creates agents that aren't stored yet and leaves existing agents unchanged.
You can edit them in Discord afterwards.
`agents` in `roundtable.config.ts` is the same list, for your own team.

<!-- example: examples/seeds.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/** Seeds are agents created on the first start; an agent already stored is never overwritten, so edit it in Discord afterwards. */
export const library = definePlugin({
	name: "library",
	setup: () => ({
		seeds: [
			{
				name: "librarian",
				displayName: "Librarian",
				prompt:
					"You keep the team's reading list. Answer briefly and cite what you were given.",
				character: { class: "scholar", palette: "azure" },
			},
		],
	}),
});
```
<!-- /example -->

### `events`: hear what the core does

| Handler | Runs when |
|---|---|
| `serviceStarted(event)` | A service's `startInBackground` ended: `event` is `{ plugin, service, outcome }`, and `outcome` is `"ready"` or `"failed"`; the rest of the process runs either way |
| `turnStarted(turn)` | An agent's turn began, or a turn run through `context.turns` |
| `turnEnded(turn)` | The turn ended; `turn.result` is `"ok"`, `"failed"`, or `"stopped"` |
| `turnProgress(event)` | A turn run through `context.turns` wrote text or ran a tool, between its start and its end: `event` is the turn's fields and `progress`, a `TurnProgress` (see the surface's `progress` below); a runtime without live progress reports none |
| `changed()` | The team changed: an agent or group was created, edited, arranged, archived, or started over |
| `action(event)` | A plugin reported something a person did through its surface with `context.events.action?.(...)`: `event` is `{ kind, actor, principalId, channel?, ok, at }`, with `kind` in the reporting plugin's own words (a support inbox says `"assign"`, `"reply"` or `"close"`), `actor` the `Speaker.id`, and `channel` a `ChannelKey` or a `page:<name>`. It carries no content. The core reports none itself; a plugin hears the others' |
| `shutdown(left)` | The shutdown drain ended, before any service stops; `left` lists the work it gave up on |

The host logs errors thrown by a handler and continues running the others.

<!-- example: examples/events.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/** Handlers hear what the core does. One that throws is logged and never stops the others. */
export function turnLog(lines: string[]) {
	return definePlugin({
		name: "turn-log",
		setup: () => ({
			events: {
				turnStarted: (turn) => {
					lines.push(`${turn.agent ?? turn.kind} started`);
				},
				turnEnded: (turn) => {
					lines.push(`${turn.agent ?? turn.kind} ${turn.result}`);
				},
				changed: () => {
					lines.push("team changed");
				},
				// The drain is over, and no service has stopped yet.
				shutdown: (left) => {
					lines.push(`shutdown, ${left.length} unfinished`);
				},
			},
		}),
	});
}
```
<!-- /example -->

`serviceStarted` names the plugin and the service.
When the agent server's channels and dashboard are up, it reports `AGENT_SERVER_PLUGIN` and `AGENT_TEAM_SERVICE` (`"agent-server"` and `"team"`) with `outcome === "ready"`.
Wait for that event to do something that needs the team running, such as posting a notice.

A turn event has a `kind`: `"agent"` for an agent's turn, else the kind the turn ran as (`"study"` in the example below).
`agent` is the agent's name and is absent for a turn of another kind.
In a test, call the handler with the payload the core sends.
A turn is `{ agent, kind, channel, speaker }`, plus `group` for a member's turn in a group.
`turnEnded` adds `result`, `changed` takes nothing, and `shutdown` takes the list of unfinished work.
`harness.stop()` delivers an empty list.

<!-- example: examples/events.test.ts -->
```ts
import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { turnLog } from "./events.ts";

test("the handlers record a turn, a team change, and the shutdown", async () => {
	const lines: string[] = [];
	const harness = await testPlugin(turnLog(lines));
	const { events } = harness.contribution;
	// The harness does not deliver the core's events: call the handlers with the payload the core sends.
	const turn = {
		agent: "guide",
		kind: "agent",
		channel: "discord:1",
		speaker: undefined,
	} as const;
	await events?.turnStarted?.(turn);
	await events?.turnEnded?.({ ...turn, result: "ok" });
	await events?.changed?.();
	// stop() delivers shutdown(left) with an empty list, then stops the services.
	await harness.stop();
	expect(lines).toEqual([
		"guide started",
		"guide ok",
		"team changed",
		"shutdown, 0 unfinished",
	]);
});
```
<!-- /example -->

### `services`: long-lived parts

A service has a name and optional `start`, `stop`, and `busy`.
Services start once everything is set up and stop in reverse order.
`busy` lists the work still running, one entry each; a shutdown waits until every service's list is empty, for at most the drain limit (three minutes by default, `drainSeconds` in the config), so a deploy rarely cuts work short.
The host adds its own channel queue to that wait, so a surface that queues its turns through `context.queue` needs no `busy` for them.

A service may also have `startInBackground`.
After all the `start`s finish and the HTTP listeners open, the host runs every service's background start without waiting for it.
Boot is already complete.
The host logs errors from background starts and keeps running the process and the other background starts.
When a background start finishes, every plugin hears `serviceStarted` with `ready` or `failed`.
A `ready` event means the service has finished its background setup.

```ts
services: [
	{
		name: "warm-index",
		// Runs after the boot, so a slow start never holds up the listeners.
		startInBackground: async () => {
			await buildIndex();
		},
	},
],
```

Use a service for anything with a lifetime: a timer, a queue, a connection.
Agents create schedules with the built-in `schedule_create` tool, and the built-in scheduler fires them.
A scheduled turn is an ordinary agent turn that can call your tools, so schedules need no separate plugin part.
Nobody waits on a scheduled turn, so it ends quietly when it has nothing to say: an empty final answer posts nothing and fails nothing (the log says `unattended turn had nothing to say; nothing posted`), which lets a schedule say "send nothing if there is no progress". A turn someone waits on (an owner's message, a report turn, a remote caller's turn) still fails on an empty answer. A turn is unattended only when its caller says so: `TurnRequest.unattended`, or `unattended` on the `context.turns.run` input, which the agent server sets for schedules, agent messages and opening tasks; a custom claim's `background` hook sets it for its schedule turns, and a turn that leaves it out is attended. When such a turn ends empty, `context.turns.run` resolves `{ ok: true, text: "" }`, posts nothing and does not call `reply`.
A schedule may carry its own time limit, `time_limit_minutes` on `schedule_create` and `schedule_update` (1 to 240, the four hours of `MAX_SCHEDULE_TIME_LIMIT_MINUTES`; `null` on update returns to the default; stored in the additive column `schedules.time_limit_minutes`, migration `schedules-time-limit`). It replaces the 10-minute default for that schedule's turns, and the runtime never lets it pass `autonomy.longRunning.maxSeconds`. A custom claim's `background` hook reads it as `BackgroundTurn.timeLimitMs` and passes it on as `ConversationTurnInput.timeLimitMs` (`TurnRequest.timeLimitMs`).
For a timer of your own, write a service like this one.

<!-- example: examples/services.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/** A service is a long-lived part: it starts once everything is set up and stops in reverse order at shutdown. */
export function heartbeat(everyMs: number, beat: () => Promise<void> | void) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let running = 0;
	return definePlugin({
		name: "heartbeat",
		setup: () => ({
			services: [
				{
					name: "heartbeat-timer",
					start: () => {
						timer = setInterval(async () => {
							running++;
							try {
								await beat();
							} finally {
								running--;
							}
						}, everyMs);
					},
					stop: () => clearInterval(timer),
					// Shutdown waits until this list is empty, so a beat is never cut off.
					busy: () => (running > 0 ? ["a heartbeat is running"] : []),
				},
			],
		}),
	});
}
```
<!-- /example -->

#### Prechecks: wake a schedule only when it has work

A schedule whose answer is "all normal" on most days still costs a model turn each time it fires.
A precheck is host code that runs first and decides whether the turn runs at all.
Register it with `services.get(PRECHECKS).register({ name, description, timeoutMs?, run })` during setup; the agent attaches it to a schedule by name with the `precheck` parameter of `schedule_create` or `schedule_update` (`null` removes it), and `schedule_list` shows the registered names with their descriptions.
The model only picks a name: it never supplies code or a command, so attaching a precheck grants nothing beyond what the schedule already has, and the same tier rules apply.

When a schedule with a precheck falls due, the scheduler takes it first (moves it to its next run, or deletes a one-time schedule) exactly as before, so a slow precheck never fires it twice, and then calls `run({ schedule, firedAt, signal })`:

- `{ wake: false, note? }` skips the turn. A `note` is posted in the schedule's channel as the bot's own small message, which starts no turn. The last status reads `skipped by precheck (note)`.
- `{ wake: true, context }` runs the turn; its text carries `context` under a `### Precheck found (<name>):` heading after the prompt. The last status reads `woken by precheck; ran`.
- A throw, a wrong answer, a name no longer registered, or running past `timeoutMs` (default `PRECHECK_TIMEOUT_MS`, 60 seconds; `signal` is aborted then) runs the turn with the error under `### Precheck failed: <name>`, so the agent can look into it. The error is logged, and the last status reads `precheck failed (…), woke; ran`.

A name is lower-case letters, digits, `.`, `_`, and `-`; registering one twice throws a `PluginError`.
A `BackgroundTurns` of your own receives what the precheck found as `runScheduled`'s third argument, a `PrecheckFinding`.

<!-- example: examples/prechecks.ts -->
```ts
import { definePlugin, PRECHECKS } from "pi-roundtable";

/** Last night's reading and its usual level, from wherever the host keeps them. */
export interface RecoveryReading {
	hrv: number;
	baseline: number;
}

/**
 * A precheck a daily schedule can name: the host reads the numbers first and wakes the agent
 * only when they are off, so an ordinary morning costs no model turn.
 */
export function recoveryPrecheck(read: () => Promise<RecoveryReading>) {
	return definePlugin({
		name: "recovery-precheck",
		setup: ({ services }) => {
			services.get(PRECHECKS).register({
				name: "health.recovery",
				description:
					"Reads last night's HRV; wakes you when it is a fifth or more under its baseline.",
				timeoutMs: 15_000,
				run: async () => {
					const { hrv, baseline } = await read();
					if (hrv >= baseline * 0.8)
						return { wake: false, note: `HRV ${hrv} ms, as usual.` };
					return {
						wake: true,
						context: `HRV ${hrv} ms against a baseline of ${baseline} ms.`,
					};
				},
			});
			return {};
		},
	});
}
```
<!-- /example -->

##### Precheck scripts: prechecks the agent writes

A host can also let agents write a schedule's precheck themselves, so a new check needs no change to the host.
The core stores the script with the schedule and decides with it exactly as with a named precheck, but it never runs a script itself: a `PrecheckScriptRunner` does, registered once with `services.get(PRECHECKS).useScriptRunner(runner)`.
pi-roundtable-sandbox's `precheckScriptRunner` runs each script in a sealed container whose only way out is the MCP tools the host grants for that schedule; see its README.

- `schedule_create` and `schedule_update` take `precheck_script`, a JavaScript module of at most `PRECHECK_SCRIPT_CHARS` (8,000) characters with a default export; it is parsed, never run, when it is set. A schedule has a `precheck` or a `precheck_script`; setting one removes the other, and `null` removes either.
- The runner's `run(script, context)` gets the `PrecheckScriptContext`: the schedule, `firedAt`, `tier`, `signal`, the host's `timeZone`, and `today`, the date there. `tier` is the tier the run is for: the schedule's, capped at what its creator holds now, as its turn would run. Its answer is checked like a named precheck's, and its finding is named `script`.
- `describe({ channel, target, tier })` (a `PrecheckScope`) tells the model how to write one and what it may call there; `schedule_list` shows it, waiting at most 10 seconds. `tier` is the asker's there and the run's `tier` when it runs, so a runner may grant lower tiers less.
- Before a schedule's precheck, named or a script, the scheduler checks who its turn would run as, as `ConversationPort.runsAs` does: a creator who may not run it now, such as one disabled, runs no precheck, and the run is recorded `skipped:` with the reason. The claim that owns the channel is asked too (`ChannelClaim.backgroundRefusal`): with `discord.agentSpeakers: "owners"`, a schedule whose turn would run below the owner tier starts no precheck and no container, and is recorded with the same reason its turn would have been skipped with.
- When the host stops, the scheduler aborts running scripts and waits up to 15 seconds for the runner to clean up; a precheck that ends then starts no turn.
- Without a runner, the tools neither take nor mention `precheck_script`, a script is refused with the registered names, and a schedule that already has one wakes with `### Precheck failed: script`, never a silent skip.

A script's MCP calls follow the hold rules as the agent's own calls do.
When a script is saved, the core reads its `mcp.call(server, tool, args)` and `mcp.json(...)` calls; server and tool must be written as strings, and `mcp` may be used for nothing else.
The runner's `toolName(server, tool)` gives the name the hold rules know each tool by, and each call is judged by its arguments when they are written out, or otherwise by `describe` with an empty input and the rules' `mayHold`.
If any call is held, saving the script is itself a held action, approved or refused through the confirmation gate like any other, so it is approved once, by someone who may approve each of those calls, and the scheduled runs do not ask again.
The schedule keeps the tools it may call as `precheckTools` (`PrecheckTool`, its held ones marked), the runner gets them as the context's `tools` and must refuse every other call, and `schedule_list` shows them.
A script saved before 0.7.13 has no recorded tools: its first run reads them, runs it if none is held, and otherwise wakes the agent to save it again for approval.


### `migrations` and `context.database()`: tables of your own

Declare `migrations` on the plugin object.
At each start, the host runs every plugin's migrations in plugin order before any `setup`, so the tables are ready when setup asks for the database.
A migration is `{ name, runs?, up(sql) }`.
Table names are shared with the core and with every other plugin, so prefix them with your plugin's name; a migration's own name only has to be unique inside its plugin.

The host creates `roundtable_migrations` to keep a ledger of migrations.
Each migration is recorded under the id `<plugin>/<name>`, such as `visit-counter/visit-counter-1-create`.
Renaming a plugin or migration makes its migrations run again, so keep both names once they are recorded.

- `runs: "once"` (the default) runs the migration one time over a database and records it.
  It runs in its own transaction under an advisory lock, with the ledger row written in the same transaction.
  A failed migration leaves nothing behind; two hosts starting together apply it once between them.
  A `db.begin(...)` inside `up` becomes a savepoint of that transaction.
  Write DDL that PostgreSQL can run in a transaction (no `CREATE INDEX CONCURRENTLY`).
- `runs: "every-boot"` runs at every start and is never recorded, so `up` must be idempotent (`CREATE TABLE IF NOT EXISTS`, `UPDATE ... WHERE` a condition that stops matching).
  Use it for a migration that converges data another build may write since, such as a move from a table an older version still writes.

A start logs one `migrations` line with the ids applied now, the number skipped, and the number that ran every boot.
When you add a ledger to a database that already ran the migrations, each `once` migration runs one more time and is recorded.
This is safe because it repeats the same work that previously ran at every start.
`roundtable doctor` runs the same runner inside a transaction it rolls back, so it checks exactly what a start would run.

`migrateDatabase(url, plugins)` from the main entry runs the plugins' migrations with the same ledger and lock, then closes its connection.
It returns a `MigrationReport` with three lists of ids: `applied`, `skipped`, and `everyBoot`.
Use it in a test or a script that needs the tables before the host runs, and pass the same plugins, with the same names, the host runs.

Run migrations before passing a database to `testPlugin`, as this example's test does.
The harness gives your plugin that database without running migrations.
This is the one example whose test needs PostgreSQL; it is skipped unless `ROUNDTABLE_TEST_DATABASE_URL` is set.
The test opens a Bun `SQL` on that URL, runs the migrations twice, passes the client to `testPlugin`, and drops its table in `finally`.
The package exports no test database client.
Use a disposable database you can write to:

```sh
ROUNDTABLE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/plugin_test bun test
```

<!-- example: examples/migrations.ts -->
```ts
import { definePlugin, defineTool } from "pi-roundtable";
import { Type } from "typebox";

/**
 * Migrations create the plugin's tables before any setup runs. Each one runs once and is recorded
 * in a ledger. Table names are shared with every other plugin: prefix them.
 */
export const visitCounter = definePlugin({
	name: "visit-counter",
	migrations: [
		{
			name: "visit-counter-1-create",
			up: async (sql) => {
				await sql`CREATE TABLE IF NOT EXISTS visit_counter (
					channel text PRIMARY KEY,
					visits integer NOT NULL DEFAULT 0
				)`;
			},
		},
	],
	setup: (context) => {
		// The host's one connection pool, already migrated.
		const sql = context.database();
		return {
			tools: [
				defineTool({
					name: "visit_count",
					description: "Count a visit to a place and say which visit it is.",
					parameters: Type.Object({ place: Type.String() }),
					minTier: "member",
					run: async ({ place }) => {
						const [row] = await sql`
							INSERT INTO visit_counter (channel, visits) VALUES (${place}, 1)
							ON CONFLICT (channel) DO UPDATE SET visits = visit_counter.visits + 1
							RETURNING visits`;
						return `Visit ${row?.visits} to ${place}.`;
					},
				}),
			],
		};
	},
});
```
<!-- /example -->

The test:

<!-- example: examples/migrations.test.ts -->
```ts
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { testPlugin } from "pi-roundtable/testing";
import { visitCounter } from "./migrations.ts";

const url = process.env.ROUNDTABLE_TEST_DATABASE_URL;

// The harness gives the plugin your database but does not migrate it: run the migrations first.
test.skipIf(!url)(
	"the tool counts visits in the plugin's own table",
	async () => {
		const sql = new SQL(url as string);
		try {
			for (const migration of visitCounter.migrations ?? []) {
				await migration.up(sql);
				await migration.up(sql); // Written to be idempotent, so a second run changes nothing.
			}
			const harness = await testPlugin(visitCounter, { database: sql });
			expect(await harness.runTool("visit_count", { place: "lab" })).toBe(
				"Visit 1 to lab.",
			);
			expect(await harness.runTool("visit_count", { place: "lab" })).toBe(
				"Visit 2 to lab.",
			);
			await harness.stop();
		} finally {
			await sql`DROP TABLE IF EXISTS visit_counter`;
			await sql.close();
		}
	},
);
```
<!-- /example -->

### `providers`: replace a part the core runs on

`providers` also sits on the plugin.
There are three slots, each filled by at most one plugin.
An unknown or misspelled slot stops startup with an error listing the valid names.

| Slot | The core's default | Your replacement |
|---|---|---|
| `judge` | Asks the configured model small questions: does this reply approve the held actions, how hard is this turn, which agents does this group message concern | An object with `askYesNo`, `askChoice`, and `askScore` |
| `images` | No drawing; no session offers `generate_image` | `async (prompt, references, options?) => bytes` returning PNG, JPEG, WebP or GIF bytes; `options.signal` aborts with the turn that asked |
| `runtime` | None: the runtime plugin builds the Pi runtime itself | `(deps) => runtime`, an [`AgentRuntime`](#the-runtime-slot-replace-pi) that runs every conversation |

A filled `images` slot powers the core's [`generate_image`](#attach-files-to-the-agents-reply) tool.
`AgentTeam.redrawAvatar` and the `AvatarMode` type are deprecated, still work (with an image provider), and are removed in 1.0; use `AgentTeam.dress`.
Agents' avatars are composed characters since 0.23 and do not use it; drawing them with the slot, `AvatarStudio.draw`, `edit`, `fallback` and `canDraw`, `config.avatar` (a warning is logged when it is set) and `AgentSeed.avatarPrompt` are deprecated, ignored, and removed in 1.0.
When no `images` provider is configured, no session offers `generate_image`; `agent_create`, `agent_avatar` and the profile panel are the same either way.
`bunx roundtable doctor` reports whether the slot is filled.
The copy-in [`codex-images` provider template][codex-images-template] fills the `images` slot with `createCodexImages` from `pi-roundtable/kit`, which also exports the client it is built on, `drawCodexImage`.

<!-- example: examples/providers.ts -->
```ts
import { definePlugin } from "pi-roundtable";

// A one-pixel PNG standing in for a real image service.
const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** A provider fills a slot the core otherwise runs on its default; one plugin may fill each slot. */
export const pixelAvatars = definePlugin({
	name: "pixel-avatars",
	providers: {
		// The images slot draws an agent's avatar from a prompt and reference pictures.
		images: async (_prompt, _references) => new Uint8Array(PIXEL),
	},
	setup: () => ({}),
});
```
<!-- /example -->

### The `runtime` slot: replace Pi

The runtime handles the agent server's conversations and those of every claim that runs turns through `context.turns`.
It keeps one persistent conversation per channel key, with its turns, held actions, and history.
By default, the host's `runtime` plugin builds the Pi runtime and provides it as `RUNTIME`; the agent server and `context.turns` both run on it, and a host without the agent server has it too.
Filling the `runtime` slot replaces it for agent turns, the owner's conversations, steering, held actions, and transcripts; the host skips building Pi.
The slot's default factory refuses calls: read the running runtime with `services.get(RUNTIME)` instead of calling `providers.runtime`.

The slot is a `RuntimeFactory`: `(deps: RuntimeDeps) => AgentRuntime`, called once when the runtime plugin sets up, before the agent server.
`deps` provides `logger`, `env`, `owner`, `toolTiers`, and the host's `judge`.
Its `sessions()` gives you linked hold rules, packages, session tools, and personas from preflight onwards; call it in a turn, when those parts are available.
`prompts(conversation, scope)` gives you the approval and question prompts on the conversation's surface for a turn's `PromptScope`, made with `promptScope(speaker, visibility)` from the turn's speaker and `TurnRequest.conversation`, or `undefined`; see [who answers a prompt](#who-answers-a-prompt-promptscope).
Given a `Speaker`, the 0.8 form, it reads them as the speaker of a shared conversation and the host warns once that the form goes away in 1.0.
`agents` holds the agent server's per-agent settings: `workDir`, `scratchDir` (the agents' shell's `TMPDIR`), `skills(name)`, `modelOf(name)`, `turnChannel(scope)`, and `memory` (`"everyone"`, the default, or `"owners"`; see [memory in the agents' channels](#memory-in-the-agents-channels)).
The agent server sets up after the runtime is built, so read `agents` when a turn runs; it is `undefined` on a host without the agent server, where no agent turn runs.
`confirmations` stores held actions across restarts.

An `AgentRuntime` has these methods:

| Method | What it does |
|---|---|
| `runTurn(request)` | Runs one turn and returns `{ ok: true, text }` or `{ ok: false, error }`; `error` is an `Error`, and `AgentRunError` (exported) is the core's own |
| `steer(conversation, text, attachments, speakerId?)` | Adds a message to the conversation's running steerable turn; `false` when the message must wait for its own turn |
| `stop(conversation)` | Aborts the conversation's running turn; `false` when none runs |
| `startFresh(conversation)`, `deleteConversation(conversation)` | Archive the conversation, or remove it for good; called between turns |
| `pendingConfirmation(conversation)`, `heldActions(conversation)` | The held actions known in memory, and those restored from the store after a restart: the agent server reads `heldActions` to show an approval card again after a restart. After a restart `pendingConfirmation` knows a conversation's held actions only once `heldActions` or `recentTranscript` has restored them, so a host that decides an approval asks one of them first. A `PendingConfirmation` carries the `selectionId` of the `TurnSelection` whose turn held the calls, an opaque string that the caller resolves again when the owner confirms; the core stores it and never reads it |
| `recentTranscript(conversation, limit)` | The latest messages, for the owner's and the dashboard's views of a conversation; the built-in runtime gives none of a history recorded, or a session opened, for someone else than the conversation serves now |
| `contextUsage?(conversation)` | How full the conversation's context is, `{ tokens, contextWindow }`; leave it out and the team status shows no context bar |
| `preflight?()` | Runs after every plugin's preflight, before anything starts; a throw stops the boot |
| `dispose?()` | Runs when the host stops the runtime plugin's `runtime` service |

A request has the turn's `channel`, `selection` (its tools), `text`, `attachments`, `speaker` (required: the person the turn is for, at whose tier it runs; the built-in runtime refuses a request without one with an `AgentRunError` before asking the model, and a plugin that starts a turn on someone's behalf gets theirs from `IDENTITY.speakerFor`), `conversation` (`TurnConversation`: `private` to a `principalId`, or `shared`, as `context.turns` records it; shared when absent), flags (`steerable`, `interactive`, `byMessage`: a person's message started the turn, so only such a turn spends a late approval's release, which a message path sets and a schedule, report or agent-message turn leaves out; `confirmed`: the speaker's message approved the conversation's held calls, which the runtime releases for the speaker, except those that [name approvers](#a-hold-that-names-its-approvers) the speaker is neither among nor an owner of, which stay held), and `interim`, where the turn may post the text it writes before its final answer ([interim text](#interim-text-what-a-turn-writes-before-its-final-answer)).
An agent's turn also has `agent`, the agent's scope, whose `session` is the conversation's key.
Other turns use `kind` to name the conversation's persona, defaulting to `"owner"` when absent.

<!-- example: examples/echo-runtime.ts -->
```ts
import {
	AgentRunError,
	type AgentRuntime,
	type ChannelKey,
	definePlugin,
	type PendingConfirmation,
	type RuntimeDeps,
	type RuntimeFactory,
	type TranscriptEntry,
	type TurnRequest,
	type TurnResult,
} from "pi-roundtable";

/**
 * A runtime runs the conversations of the agent server and of every claim that calls
 * `context.turns.run`: one conversation per channel key, its history, and its held actions.
 * This one answers with the text it was given, and keeps each conversation's transcript in memory.
 */
export class EchoRuntime implements AgentRuntime {
	readonly #deps: RuntimeDeps;
	readonly #transcripts = new Map<ChannelKey, TranscriptEntry[]>();

	constructor(deps: RuntimeDeps) {
		this.#deps = deps;
	}

	async runTurn(request: TurnRequest): Promise<TurnResult> {
		// An agent's turn carries the agent's scope, and its conversation is the scope's session.
		const conversation = request.agent?.session ?? request.channel;
		const prompt = this.#promptOf(request);
		if (prompt === undefined)
			return {
				ok: false,
				error: new AgentRunError(
					`no persona for the conversation kind "${request.kind}": a plugin adds one with \`personas\``,
				),
			};
		const text = `[${prompt}] ${request.text}`;
		const transcript = this.#transcripts.get(conversation) ?? [];
		transcript.push(
			{ role: "user", text: request.text },
			{ role: "assistant", text },
		);
		this.#transcripts.set(conversation, transcript);
		return { ok: true, text };
	}

	/** What a model would get as its system prompt: the agent's name, or the persona of the kind. */
	#promptOf(request: TurnRequest): string | undefined {
		if (request.agent) return `agent ${request.agent.name}`;
		// Only the turn's kind picks the persona; "owner" is the kind of a turn that names none.
		const kind = request.kind ?? "owner";
		return kind === "owner"
			? (this.#deps.sessions().persona("owner") ?? "owner")
			: this.#deps.sessions().persona(kind);
	}

	/** Nothing runs long enough to take a steering message, so each waits for its own turn. */
	async steer(): Promise<boolean> {
		return false;
	}

	/** No turn outlives its `runTurn`, so there is never one to stop. */
	stop(): boolean {
		return false;
	}

	async startFresh(conversation: ChannelKey): Promise<void> {
		this.#transcripts.delete(conversation);
	}

	async deleteConversation(conversation: ChannelKey): Promise<void> {
		this.#transcripts.delete(conversation);
	}

	/** This runtime holds no actions for approval; a real one keeps them in `deps.confirmations`. */
	pendingConfirmation(): PendingConfirmation | undefined {
		return undefined;
	}

	async heldActions(): Promise<PendingConfirmation | undefined> {
		return undefined;
	}

	async recentTranscript(
		conversation: ChannelKey,
		limit: number,
	): Promise<TranscriptEntry[]> {
		return (this.#transcripts.get(conversation) ?? []).slice(-limit);
	}
}

/** The factory the agent server calls once, with what a runtime needs from the host. */
export const createEchoRuntime: RuntimeFactory = (deps) => {
	deps.logger.info("the echo runtime replaces Pi");
	return new EchoRuntime(deps);
};

/**
 * A plugin fills the `runtime` slot to replace the whole conversation runtime; without one the
 * runtime plugin builds the Pi runtime. One plugin may fill it.
 */
export const echoRuntime = definePlugin({
	name: "echo-runtime",
	providers: { runtime: createEchoRuntime },
	setup: () => ({}),
});
```
<!-- /example -->

`testPlugin` builds the runtime from the slot as the agent server does and exposes it as `harness.runtime`.
The test runs `context.turns` over that runtime and a fake surface, without Discord or Pi:

<!-- example: examples/echo-runtime.test.ts -->
```ts
import { afterEach, expect, test } from "bun:test";
import {
	definePlugin,
	PluginError,
	Roundtable,
	type RoundtablePlugin,
} from "pi-roundtable";
import { OWNER_SPEAKER, silentLogger, testPlugin } from "pi-roundtable/testing";
import { createEchoRuntime, EchoRuntime, echoRuntime } from "./echo-runtime.ts";
import { FakeSurface } from "./fake-surface.ts";

/** One host runs per process, so each test stops its own. */
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown("test");
});

function host(plugins: RoundtablePlugin[]): Roundtable {
	const roundtable = new Roundtable({ logger: silentLogger() }, plugins);
	hosts.push(roundtable);
	return roundtable;
}

test("the harness builds the runtime from the slot, the way the agent server does", async () => {
	const harness = await testPlugin(echoRuntime);
	expect(harness.runtime).toBeInstanceOf(EchoRuntime);
	await harness.stop();
});

test("a turn run through context.turns goes through the plugin's runtime, and the answer goes out through the surface", async () => {
	const surface = new FakeSurface();
	const harness = await testPlugin(echoRuntime, { surfaces: [surface] });
	const result = await harness.turns.run({
		channel: "fake:room",
		kind: "owner",
		text: "hello",
		speaker: OWNER_SPEAKER,
	});
	expect(result).toEqual({ ok: true, text: "[owner] hello" });
	expect(surface.replies).toEqual([
		{ channel: "fake:room", reply: { chunks: ["[owner] hello"] } },
	]);
	// The surface showed typing and the stop control while the turn ran.
	expect(surface.typing).toEqual(["start fake:room", "stop fake:room"]);
	expect(surface.stops).toEqual(["show fake:room", "hide fake:room"]);
	expect(harness.events.map(({ name }) => name)).toEqual([
		"turnStarted",
		"turnEnded",
	]);
	await harness.stop();
});

test("an agent's turn carries its scope, and its conversation is the scope's session", async () => {
	const harness = await testPlugin(echoRuntime);
	const { runtime } = harness;
	if (!runtime) throw new Error("the plugin fills the runtime slot");
	const result = await runtime.runTurn({
		channel: "fake:agent-room",
		selection: { id: "agent", tools: [], groups: [] },
		text: "status?",
		speaker: OWNER_SPEAKER,
		agent: {
			name: "infra",
			session: "fake:agent-room",
			home: "fake:agent-room",
		},
	});
	expect(result).toEqual({ ok: true, text: "[agent infra] status?" });
	expect(await runtime.recentTranscript("fake:agent-room", 10)).toEqual([
		{ role: "user", text: "status?" },
		{ role: "assistant", text: "[agent infra] status?" },
	]);
	await runtime.startFresh("fake:agent-room");
	expect(await runtime.recentTranscript("fake:agent-room", 10)).toEqual([]);
	await harness.stop();
});

test("a turn of a kind nobody wrote a persona for fails with the fix, and the surface says so", async () => {
	const surface = new FakeSurface();
	const harness = await testPlugin(echoRuntime, { surfaces: [surface] });
	const result = await harness.turns.run({
		channel: "fake:room",
		kind: "quiz",
		text: "hello",
		speaker: OWNER_SPEAKER,
	});
	expect(result.ok).toBe(false);
	expect(!result.ok && result.error.message).toContain("`personas`");
	expect(surface.replies).toHaveLength(1);
	await harness.stop();
});

test("the host resolves the slot to the plugin's factory", async () => {
	let filled = false;
	const probe = definePlugin({
		name: "probe",
		setup: ({ providers }) => {
			filled = providers.filled.has("runtime");
			expect(providers.runtime).toBe(createEchoRuntime);
			return { services: [{ name: "probe" }] };
		},
	});
	await host([echoRuntime, probe]).run();
	expect(filled).toBe(true);
});

test("only one plugin may fill the runtime slot", async () => {
	const another = definePlugin({
		name: "another-runtime",
		providers: { runtime: createEchoRuntime },
		setup: () => ({}),
	});
	const error = await host([echoRuntime, another])
		.run()
		.then(
			() => undefined,
			(failure: unknown) => failure,
		);
	expect(error).toBeInstanceOf(PluginError);
	expect(String(error)).toContain(
		"provider slot runtime is already filled by plugin echo-runtime",
	);
});
```
<!-- /example -->

### `preflight`: refuse to start with a bad setting

`preflight` also sits on the plugin.
It runs once every plugin is set up and linked, before any command is registered or any service starts.
A throw stops the boot, so a missing setting is caught before Discord connects.
Plugins' preflights run in plugin order.
Once every one has finished, the host runs the runtime's own `preflight` (the `RUNTIME` service's), which for Pi's runtime builds throwaway sessions and checks the model and the required tools.
So tools a plugin fills in during its preflight, such as MCP servers it resolves there, are in those sessions, and a required tool still missing stops the start before any service starts or any listener opens.
`Roundtable.check()` runs no preflight.

<!-- example: examples/preflight.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/**
 * A preflight runs once every plugin is set up and linked, before any command is registered or
 * service starts. A throw stops the boot, so a bad setting is caught before Discord connects.
 */
export function needsKey(
	name: string,
	env: Record<string, string | undefined>,
) {
	return definePlugin({
		name: "needs-key",
		preflight: () => {
			if (!env[name]?.trim())
				throw new Error(`${name} is empty. Set it in .env.`);
		},
		setup: () => ({ dashboard: [`Uses ${name}`] }),
	});
}
```
<!-- /example -->

### Slash commands: `commands.add`

The Discord plugin composes every plugin's slash commands under one root command, `/roundtable` by default or the name in `discord.rootCommand`.
It registers them with Discord as it connects.
Add commands from `setup` with `context.services.get(DISCORD).commands.add(...)`, importing `DISCORD` from `pi-roundtable/discord`.
Subcommands go under the root command.
The `module` answers Discord interactions and returns `true` for those it handled.
Its `commands()` returns its own top-level commands, excluding the root.
A plugin that only adds commands can return `{}` because reading a service in `setup` counts as a contribution.

The Discord plugin composes commands in its `preflight`, before any service starts.
Duplicate command names or subcommands, or a module that registers the root itself, stop startup with a `PluginError` before reaching Discord.
Call `commands.add` from `setup`; after preflight it throws `commands can be added only while plugins set up`.
Use `services.find(DISCORD)` if your plugin can work without Discord.
When the service is absent, the rest of your plugin can run without commands.

Build a feature's part of the root command with `ownerCommandModule(guard, handlers)` from `pi-roundtable/discord`; only the owners may use it, it defers interactions, and supplies a failure panel.
That entry also exports `groupOption` for subcommand groups, the panel helpers (`ownerPanel`, `ownerPanels`, `ephemeralPanel`, `replyWithPanels`, `plain`, `OwnerFacingError`), and `agentPanel({ guard, agents })` for an agent's profile panel.
`DISCORD.guard` is the `CommandGuard`; `await guard.allows(actor)` is whether the actor is an owner now: the primary owner by user id, and every other owner principal by their Discord identity, checked through `IDENTITY` each time, so an owner granted or revoked with the CLI is seen at once and a stranger is never resolved. It accepts an interaction or anything with `user.id` (a `DiscordActor`), so a test needs no cast.
`guard.isOwner(actor)` is deprecated until 1.0: it is the primary owner only, by user id, so a component handler that still asks it refuses the other owners.
`commandGuard({ ownerId, identity?, root, logger, refusalHint? })` makes one; without `identity` the primary owner is the only owner.
The connection's `ownerChannel()` and `notifyOwner(text)` are deprecated until 1.0: they reach the primary owner alone. Reach a person through `context.directChannels` instead, where the Discord plugin's provider finds their direct messages by a Discord identity of theirs.
`DiscordOptions.refusalHint` (`discord.refusalHint` in the configuration) is appended unchanged to the refusal a non-owner gets.

<!-- example: examples/interactions.ts -->
```ts
import { definePlugin } from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";

/**
 * Slash commands belong to the Discord plugin: a plugin adds its own from setup with
 * `commands.add`. A subcommand goes under the one root command (`/roundtable` by default); the
 * module answers the interactions Discord sends and returns true for the ones it handled.
 */
export const ping = definePlugin({
	name: "ping",
	setup: ({ services }) => {
		services.get(DISCORD).commands.add({
			rootOptions: [
				{ type: 1, name: "ping", description: "Check that the bot answers" },
			],
			module: {
				commands: () => [],
				handle: async (interaction) => {
					if (!interaction.isChatInputCommand()) return false;
					if (interaction.options.getSubcommand(false) !== "ping") return false;
					await interaction.reply("pong");
					return true;
				},
			},
		});
		return {};
	},
});
```
<!-- /example -->

A test gives the plugin `fakeDiscord()` from `pi-roundtable/testing`: `testPlugin(ping, { services: [discord.service] })` records what the plugin added (`discord.added()`), and `discord.compose()` returns the tree Discord would get, composed the way the Discord plugin composes it.

### `http`: routes on the bot's listener

The configuration's `http` block opens a listener named `public`, which serves the agents' avatars.
`http.publicUrl` is its internet address, required with Discord; a host without Discord may leave `http` out and opens no listener.
A route names the listener, a path (`{ exact }` or `{ prefix }`), optionally the methods, and a handler that gets a `Request` and returns a `Response`.
Two routes that could take the same request are refused, so a route cannot shadow the avatars.
This listener is reachable from the internet, so check a secret in the handler before taking action.
The [web package source][web-source] is a complete owner-console implementation built on these HTTP routes.
A handler that throws, or returns a rejected promise, answers `500 Internal Server Error` with that fixed body, and the listener keeps serving.
The host logs one error line with the route's `name` and its `listener`; it never logs the request URL, since a path may hold a secret.

A listener serves on a TCP port or, when `http.socketPath` is set, a unix socket that a tunnel or proxy reaches.
The socket file's permission bits are `http.socketMode`, `0o660` by default: only its owner and group can connect.
Widen it (`0o666`) only when the proxy runs as a user outside that group.
More listeners than `public` come from `defineRoundtable`'s `listeners` override, each `{ id, socketPath, mode? }` or `{ id, port, hostname? }`, and a route attaches to one by its `id`.

A listener takes request bodies up to 128 MiB (`DEFAULT_MAX_REQUEST_BODY_BYTES`, Bun's own default, set explicitly); a larger body is answered `413` before any handler runs. A route that takes bigger bodies, such as an upload endpoint, sets `maxRequestBodyBytes` on the `HttpRoute` (a positive integer: its upload limit plus the multipart overhead), and the listener opens with the largest value among its routes, a route that says nothing counting as the default. The host can fix the limit itself with `maxRequestBodyBytes` on a `ListenerConfig`, which then decides over the routes. The limit is per listener, not per route: a request to another route of the same listener may be as large. The same value holds a unix socket listener. A value that is not a positive integer is refused when the host starts, naming the route or listener.

A route that also declares `websocket` takes WebSocket upgrades on its path; every other request still reaches `handle`, and its `methods`, when listed, must include `GET`.
An upgrade is a `GET` with `Upgrade: websocket`; one without `Sec-WebSocket-Key` or with a `Sec-WebSocket-Version` other than `13` gets `400`, and any other method goes to `handle` as usual.
An upgrade request first passes the Origin check: `origins` lists the `scheme://host[:port]` values a browser may connect from, exactly as a browser sends them, such as `https://chat.example.com` or `chrome-extension://<id>` (a lowercase scheme and no path, trailing slash, query, fragment, or user; another form, and `"null"`, is refused at startup), and a request with another Origin, or none, gets `403` without reaching the route. `"any"` skips the check, for clients that are not browsers.
A route holds at most `maxConnections` sockets at once (256 by default), counting upgrades still in `accept`; one more gets `503` before `accept` runs.
Then `accept` authenticates and authorizes the request before any socket opens: it returns `{ data }`, which every handler reads as `socket.data`, or a `Response` such as `401` or `403` that refuses the upgrade. An `accept` that throws answers `500` like a failing `handle`.
Browsers cannot set headers on a WebSocket, so a browser client proves itself with a ticket: one-time and short-lived in the query, so a ticket that leaks from a log or the history opens nothing, or carried in `Sec-WebSocket-Protocol`, which `accept` answers by returning the chosen protocol in `headers`.
Never combine `origins: "any"` with cookie authentication: the browser sends the cookie from any site, so any page its user opens could take over their socket (cross-site WebSocket hijacking).
Each message reaches `message` as it arrives. A message over `maxMessageBytes` (64 KiB by default) closes the socket with `1009`, and more than `rate.messages` in `rate.perMs` (120 a minute by default) closes it with `1008`.
`socket.send` answers `"sent"`, `"queued"` when the client reads slower than the route sends, or `"dropped"`. `maxBufferedBytes` (1 MiB by default) is checked before each `send`: once that many bytes wait for a client that stopped reading, the next `send` answers `"dropped"` and the host cuts the socket without a close frame, so the client and the route's `close` both see `1006`. A `send` that finds fewer waiting goes out whole, so a single message larger than the limit still reaches a client that reads, and the bytes waiting can reach the limit plus one message. A `send` on a closed socket answers `"dropped"` too, and an empty message is `"sent"`.
Every limit (`maxMessageBytes`, `maxBufferedBytes`, `maxConnections`, `rate.messages`, `rate.perMs`) must be a positive integer; another value is refused at startup with an error naming the route and field.
The handlers' return values are ignored and a returned promise is awaited, so `message: (socket, message) => socket.send(message)` is a complete echo.
A handler that throws or rejects closes only its own socket, with `1011`, and logs the route and listener like a failing `handle`.
When the host shuts down, every open socket is closed with `1001`, and the shutdown waits up to five seconds for the routes' `close` handlers before it stops the services.

<!-- example: examples/http.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/** A route answers requests on a listener the host runs; "public" is the one the configuration's `http` block opens. */
export const health = definePlugin({
	name: "health",
	setup: () => ({
		http: [
			{
				name: "health-check",
				listener: "public",
				path: { exact: "/healthz" },
				methods: ["GET"],
				handle: () => new Response("ok"),
			},
		],
	}),
});

/**
 * A route with `websocket` also takes upgrades. The Origin check and `accept` run before any
 * socket opens, so a browser on another site, or a client without a ticket, never connects.
 * A ticket opens one socket: `accept` spends it, so one that leaks from a log or the browser's
 * history opens nothing. Whoever issues the tickets should also let them expire within seconds.
 */
export const echo = (tickets: Set<string>) =>
	definePlugin({
		name: "echo",
		setup: () => ({
			http: [
				{
					name: "echo",
					listener: "public",
					path: { exact: "/echo" },
					methods: ["GET"],
					handle: () => new Response("Upgrade Required", { status: 426 }),
					websocket: {
						origins: ["https://chat.example.com"],
						accept: (request) => {
							const ticket = URL.parse(request.url)?.searchParams.get("ticket");
							return ticket && tickets.delete(ticket)
								? { data: { since: Date.now() } }
								: new Response("Unauthorized", { status: 401 });
						},
						maxMessageBytes: 4096,
						rate: { messages: 20, perMs: 10_000 },
						maxBufferedBytes: 64 * 1024,
						maxConnections: 50,
						message: (socket, message) => {
							// "dropped" means the client stopped reading and the host cut it; an echo has nothing to resend.
							socket.send(message);
						},
					},
				},
			],
		}),
	});
```
<!-- /example -->

### `dashboard`: lines on the dashboard message

The agent server keeps a dashboard message pinned in Discord that shows the team's state.
Each string here is added under its title, in plugin order.

<!-- example: examples/dashboard.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/** Dashboard lines are shown under the title of the agent server's dashboard message, in plugin order. */
export const links = definePlugin({
	name: "links",
	setup: () => ({
		dashboard: ["Docs: https://example.com/docs"],
	}),
});
```
<!-- /example -->

### `agentSelection`: tools every agent carries

`agentSelection` runs before each turn, keeping the selection current as the process runs.
It names tools and tool groups; a tool still has to pass the speaker's tier.

<!-- example: examples/selection.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/**
 * The selection names tools every agent turn carries besides its own, read before each turn so
 * a set that changes while the process runs stays current.
 */
export function alwaysOn(tools: () => string[]) {
	return definePlugin({
		name: "always-on",
		setup: () => ({
			agentSelection: () => ({ tools: tools(), groups: [] }),
		}),
	});
}
```
<!-- /example -->

### Chat-only agents: no shell, file, or workspace tools

By default an agent's turn carries Pi's shell and file tools (`bash`, `read`, `edit`, `write`) and works in a shared workspace on the host.
A host whose agents only talk, such as one that serves a team through a web app and has no use for a shell, switches them off:

```ts
export default defineRoundtable({
	// ...
	agentServer: { tools: "chat-only" },
});
```

The agent server stays, with its team, rooms, memory, schedules and the tools plugins add; `agentServer: false` still leaves it out, and a key left out keeps the full tools.
Plugins read the mode as `context.env.agentTools` (`"full"` or `"chat-only"`), and `ResolvedConfig.agentTools` and `RoundtableOptions.environment.agentTools` carry it for a host that builds its own options.
With `"chat-only"`:

- No turn is offered `bash`, `read`, `edit` or `write`: the agent team's selection leaves them out, an agent's system prompt says it has no shell, file tools or workspace, its sessions get no workspace (no `attach_file`, no shell scratch dir) and its held-action gate judges none.
- The host refuses to start with a plugin that declares `hostAccess: true` (`pi-roundtable-coding` does), with a `ConfigError` that names the plugin, and with a plugin whose `agentSelection` names one of the four tools. `roundtable doctor` prints `agent tools: chat-only (no shell, file or workspace tools)` and fails for a registered `hostAccess` plugin; with the full tools it prints `full`.
- A selection that names one of the four tools anyway, whatever built it (a turn run through `context.turns` with its own `selection`, a plugin that grants tools at run time), is refused at the one place where `SessionFactory` turns a selection into active tools (`toolsFor` and `taskTools`): the turn fails closed with a `ConfigError`, which is logged as the turn's failure, and no session runs it.
- `pi-roundtable-webchat` stops at start when a persona's own `selection` names one of the four tools.

The mode is the host's decision, not a permission: it does not change who may use which tool (`toolTiers`), and an MCP server or other plugin that reaches the machine in a way it does not declare is outside what it can see.
A plugin whose tools reach the host declares `hostAccess`, so that the one flag decides.

### Conversation retention: `conversations.keepDays`

The conversations run through `context.turns` are recorded (`CONVERSATIONS`).
`conversations.keepDays` deletes the idle ones of a kind after a number of days, so a host that must not keep a kind of conversation for ever, such as support threads, does not:

```ts
export default defineRoundtable({
	// ...
	conversations: { keepDays: { support: 365, chat: 30 } },
});
```

The key is a conversation's kind (`ConversationRecord.kind`) and the value a whole number of days from 1 up, counted from the conversation's last activity.
A sweep runs when the host starts and once a day after: for each recorded conversation of a listed kind past its days, it calls `ConversationPort.deleteConversation`, which its claim carries out, and then forgets the record (`ConversationRegistry.remove`, optional on a hand-built registry).
A conversation with a turn running or waiting (`"busy"`) is skipped and tried again at the next sweep; one whose claim cannot delete it is logged and kept.
A kind not listed, and a host without the key, keeps its conversations as before.

A conversation can be wanted for longer than its kind's days, such as a support conversation whose ticket is still open.
`conversations.keep(record)` is asked for each conversation past its days, before it is deleted; answering `true` keeps it for now, and it is asked again at the next sweep, so the conversation goes once the host stops wanting it.
A `keep` that throws or rejects keeps the conversation for this sweep and is logged.

```ts
conversations: {
	keepDays: { support: 365 },
	keep: async (conversation) => (await tickets.isOpen(conversation.key)),
},
```
The agents' own channels are not recorded conversations and are not touched.

### `piPackages`: Pi extensions every session loads

List npm packages whose Pi extensions every conversation session should load, and install them in your project (`bun add pi-web-access`).
Two plugins that name the same package load it once.
Sessions load only these packages: the Pi packages in the host's own Pi settings, and its extension folders, stay out.

Loading a package registers its tools, but a turn uses only the tools it selects, so list them in [`agentSelection`](#agentselection-tools-every-agent-carries) too, and in `requiredTools` so startup fails when a package version drops one.
A tool no plugin gives a tier is the owner's alone; the operator lowers it with `toolTiers` in `roundtable.config.ts`.
Give a package's tools a tier in the plugin only when no other plugin does: the built-in `modules` plugin already gives `web_search`, `fetch_content`, and `get_search_content` the member tier, and a second plugin naming them is a `PluginError`.

`roundtable add package <spec>` writes such a plugin for you.
It accepts a registry name, optionally scoped and versioned (`pi-web-access`, `@scope/name@1.2.3`), and refuses before installing when the config cannot take the plugin or `plugins/<name>.ts` exists.
After `bun add`, it refuses a package whose `package.json` lists no extensions under `pi` and that has no `extensions` folder, and a package whose extensions fail to load; the package stays installed, and the message names the `bun remove` command.
The plugin it writes lists every tool the package registers when it loads, gives none a tier, and its test checks that every listed tool is selected.
A tool a package registers later, such as after a connection, is not found; add it to the list by hand.

The built-in delegation worker also loads `pi-web-access` to search and read the web.
`pi-roundtable` lists it as a peer dependency (`>=0.35.0 <0.41.0`), so `bun add pi-roundtable` installs it for you.
If your project depends on its own build, such as a fork, both the worker and `piPackages` use that copy without an `overrides` entry.
A project that has none installed stops at the `modules` plugin's setup with a `PluginError` that names the command to run.

<!-- example: examples/packages.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/**
 * Pi packages are npm packages whose Pi extensions every session loads; install each one in your
 * project first. Loading a package registers its tools, and a turn uses only the tools it
 * selects, so the plugin selects them too. `roundtable add package <name>` writes this for you.
 */
const WEB_TOOLS = ["web_search", "fetch_content", "get_search_content"];

export const webSearch = definePlugin({
	name: "web-search",
	setup: () => ({
		piPackages: ["pi-web-access"],
		agentSelection: () => ({ tools: WEB_TOOLS, groups: [] }),
		requiredTools: WEB_TOOLS,
	}),
});
```
<!-- /example -->

### `toolTiers`: who may use your raw session tools

`toolTiers` maps the name of each tool a `sessionTools` extension registers to the lowest tier that may use it: `{ toolTiers: { notes_search: "member", notes_edit: "admin" } }`.
A tool built with `defineTool` already carries its tier; this is the same for the raw form.
The operator's `toolTiers` setting wins, and tools with no tier assigned require the owner.
If two plugins name the same tool, the host throws a `PluginError` naming both.
The built-in addons use it: each declares the tiers of its own tools.

### `sessionTools`: the raw form of `tools`

A session tool is a Pi extension placed in every conversation session by its phase: `tools`, `compaction`, or `mcp`.
Use it for tools that `defineTool` cannot express, such as a set that changes while the process runs (bump `revision`) or a tool that depends on the session.
Each extension needs a unique name; the core reserves `read-attachment`, `confirmation-gate`, `ask-user`, `self-compact-guard`, `private-memory`, and `active-tools`.
A runtime of your own pins the active tools the way the core does: `activeToolsExtension(() => tools)` from `pi-roundtable/kit` is the extension the core places last, so its handler runs after every other extension's.
At most one plugin may add a `compaction` extension, and it must name the `engine` its compactions record.
In a shared conversation the core's wrapper hands it the history to summarize as `summaryProjection` gives it, without anyone's private memory, the prompt states, or the turns' reasoning, and Pi's own summary reads the same, since a summary outlives the turns it covers and every later speaker reads it. A compactor that reads the history otherwise, outside `session.compaction.wrap` or in a runtime of your own, must summarize a shared conversation's history the same way: call `privateCompaction(event.preparation, branchMessages)` from `pi-roundtable/kit` before reading it, passing the message entries of `event.branchEntries` so exchanges split across the kept boundary are paired too.

The factory gets the session's `SessionContext`, fixed when the session is made:
- `kind`, `homeChannel`, `turnChannel`, and `agent` say what the session is for and where its turns run.
- `conversation` (`SessionConversation`) says whom it serves: `{ visibility: "private", principalId, principal? }` for one person's conversation, with their name and pronouns when the host has a record of them, or `{ visibility: "shared" }`. An agent's session is always shared. Otherwise it is as the turn's `TurnRequest.conversation` names it, else as the conversation registry recorded it, else shared; it is never the owner's by default. The runtime reads this again at every turn, the registry included, falling back to whom the open session or its recorded history served when nothing names the conversation, and refuses a turn of someone else in a conversation private to its person before the session is touched. A session's history records whom it served: when the conversation serves someone else, another principal or the other visibility, the session is made anew with nothing held for it, and its earlier history is archived rather than replayed, after a restart too; a history from before 0.9, which records no one, carries on. Changed session tools or skills rebuild a session with its history.
- `addressee` is whom tool descriptions should name: the primary owner exactly as configured in their own private conversation, another person by their name and pronouns (their name alone when they gave none), and `THE_SPEAKER` in a shared conversation, or a private one of someone the host knows by no name yet.
- `memory` is `"none"` for a persona that declares it, and `"speaker"` otherwise; a memory tool of your own loads nothing for `"none"`. A task the session runs with `runTask` keeps its conversation's `memory`.
- `speaker()` is the running turn's speaker, undefined between turns; a tool reads it when it runs, never when the session is made, since a session outlives the turn it is built in.
- `client()` is what the client that started the running turn can do for its tools, as `TurnRequest.client` says, and undefined between turns and for a turn whose transport gives none; it is optional on the type so a context built before 0.9.11 still type-checks.
- `origin()` is where the running turn's request came from, as `TurnRequest.origin` says, and undefined between turns and for a turn whose transport gives none; read it when the tool runs, like `speaker()`. It is optional on the type so a context built before 0.9.10 still type-checks.

The core's Jev compactor is one such extension:

```ts
sessionTools: [
	{
		name: "jev-compaction",
		phase: "compaction",
		engine: JEV_COMPACTION_ENGINE,
		snapshot: () => ({
			revision: 0,
			factory: (session) =>
				session.compaction.wrap(jevCompactionExtension({ logger })),
		}),
	},
],
```

<!-- example: examples/session-tools.ts -->
```ts
import { definePlugin } from "pi-roundtable";
import { Type } from "typebox";

/**
 * A session tool is a Pi extension added to every conversation session: the raw form of `tools`,
 * for what defineTool cannot express. The factory returns null for a session it does not apply
 * to, and a new `revision` rebuilds open sessions on their next turn.
 */
export const clock = definePlugin({
	name: "clock",
	setup: () => ({
		sessionTools: [
			{
				name: "clock",
				phase: "tools",
				snapshot: () => ({
					revision: 0,
					factory: () => (pi) => {
						pi.registerTool({
							name: "clock_now",
							label: "clock_now",
							description: "Tell the current UTC time.",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: new Date().toISOString() }],
								details: undefined,
							}),
						});
					},
				}),
			},
		],
	}),
});
```
<!-- /example -->

### `channels`: conversations of your own

A claim makes the plugin the owner of the conversations in some channels.
The router asks claims by descending `priority`, then plugin order; the first that owns a channel decides everything there, and a message its `admit` returns nothing for is dropped.
The built-in agent server already owns the agents' channels, so most plugins need no claim.

A channel key is `<surface>:<id>`: the surface names the chat network (`discord`), and the id is that network's own, which may contain colons.
`parseChannelKey(key)` splits a key at its first colon into `{ surface, id }` and throws for a key without a surface; `channelKey(surface, id)` builds one.
A claim's `owns(channel, space)` receives the channel and the message's server or workspace id as `space`, using the surface's own ids.
`space` is absent for direct messages or when the router asks about a channel alone.
The agent server uses it to own every channel of its Discord server.
Use `parseChannelKey` to read a key, and check the surface in `owns`: `parseChannelKey(channel).surface === "mcp"` for `mcp:` keys, or `"discord"` for Discord.

The built-in agent server claims `discord:` keys with `AGENT_SERVER_PRIORITY` (100), the highest claim priority.
It owns the agents' channels and every other channel in its Discord guild.
It leaves those other channels silent for the owner's notes, preventing other claims from answering there.
Of any other surface it claims only the [agent rooms](#agent-rooms-on-any-surface) of a surface that declares `agentRooms: true`, `<surface>:agent.<name>` and `<surface>:group.<name>` for an agent or group the team has; every other key of that surface stays for your own claims.
Your Discord claim won't receive messages from that guild at any priority below 100, including `priority: 10`.
Claims on other surfaces, such as the example's `echo:` keys, don't compete with the agent server.

Before a claim's `admit` sees a message, the router resolves its author through `IDENTITY` and sets `message.speaker`: their `id` on the surface, `name`, `tier`, and `principalId`, the principal whose memory, schedules, and conversations are theirs.
It is undefined when the access rules serve no one by them, and for bots and integrations, which are not resolved; a `speaker` the surface set is dropped.
A claim that serves only the people the host serves answers only when `speaker` is set.
The router records the author, such as linking them at their first contact, only once a claim admits the message, so messages no claim takes link or make no one.
One exception: an author already linked whom the access rules now refuse is recorded as seen at no tier when the message is resolved, whether or not a claim takes it, at most once every few minutes, so their background turns stop with them.
When that record finds the author someone else than the claim admitted, such as linked to another principal meanwhile or refused now, or cannot be made, the router drops the message: a turn admission's optional `dropped()` is called instead of `run`, so the claim frees what it holds for it, and a background admission's `unanswered` hears it skipped.

A claim may also hear that a message it owns changed, through `onMessageDeleted(channel, messageId)` and `onMessageEdited(message)`, which a surface reports with the second argument of its `start` (`{ deleted, edited }`, a `SurfaceMessageEvents`). Discord reports both, including for a message the bot had not cached; a surface that cannot tell never calls them. The router delivers each as it comes, to the claim that owns the channel and no other, outside the channel's queue, so a running turn does not hold it up; a throw or rejection is logged and never fails the router. A delete carries only ids, and Discord's delete event does not say who wrote the message, so the claim hears the deletion of the bot's own messages too and ignores an id it does not know. An edit carries the message as it reads now, as an `InboundMessage`, without `speaker` or `peerBot` because nobody is resolved or admitted for it; the bot's own edits are not reported, nor is a change that leaves the text, the embeds and the attachments as they were, such as a pin. A bulk delete is reported as one delete per message.

A claim may have `stop(channel)`, which stops the channel's running turn and returns whether one was running; the Stop button, `conversations.stop`, and every other stop go through it.
The router calls only the owning claim's `stop`, returning `false` when that method is absent.
Give `stop` to a claim whose conversations run turns that can be interrupted.

For a claim with its own conversations, return the conversation's kind from `startFresh`.
Run turns with [`context.turns`](#personas-and-contextturns-conversations-of-a-kind-of-your-own), which handles typing, the stop control, events, and replies.
The [sandbox package source][sandbox-source] is a complete guest-only channel claim backed by a no-network Docker agent and a host-side broker.
Its container runs a minimal Chat Completions loop rather than a Pi session.

<!-- example: examples/channels.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/**
 * A channel claim makes a plugin the owner of the conversations in some channels. The router
 * asks claims by descending priority; the first that owns a channel decides everything there,
 * and a message its `admit` returns nothing for is dropped.
 */
export const echo = definePlugin({
	name: "echo",
	setup: () => ({
		channels: [
			{
				name: "echo-channels",
				priority: 10,
				owns: (channel) => channel.startsWith("echo:"),
				admit: (message) => ({
					kind: "turn",
					run: async () => {
						console.log(`echo: ${message.text}`);
					},
					failure: "an echo turn failed",
				}),
				startFresh: async () => "The echo channel has nothing to start over.",
			},
		],
	}),
});
```
<!-- /example -->

### `observe`: hearing messages without owning them

`context.observe(filter, observer)` hears inbound messages whichever claim owns their channel, without admitting, blocking or delaying any of them. A plugin that only listens, such as one that decides whether to offer help in a channel another claim owns, uses it instead of tapping each claim's `admit`.

```ts
const stop = context.observe({ surface: "discord", space: guildId }, (message) => {
	remember(message.channel, message.messageId, message.text);
});
```

The filter narrows by `surface` (the key prefix; naming a surface is also how you opt in to the rooms it hosts, below), `space` (the server or workspace id), and `channels` (channel keys); an empty filter hears every message the router considers. The observer gets what the router would consider and no more:

- Messages in a channel some claim owns. A channel nobody owns is not heard.
- People's messages, those of a bot the host lists as a peer (`discord.peerBots`) even when its rounds in the channel are used up (observing does not count a round), and an integration's, such as a webhook's, with `integration` set (`integration.own` says whether the assistant posts through it). Never an unlisted bot's, and never the assistant's own, which no surface delivers.
- Guild and workspace messages only. A direct message is private to its two sides, so it is heard only when the filter says `includeDirect: true`.
- Not the rooms of a surface that hosts agent rooms (`agentRooms: true`, such as a web app's agent and host rooms): they are one person's or one team's, so a filter that does not name that surface in `surface` does not hear them. Name the surface to opt in; the observer then answers for keeping that text private to its people.

The observer is called on a later tick with its own frozen copy of the message, so it cannot change what a claim or another observer sees, and routing does not wait for it. A throw or rejection is logged by the error's name, never with the message, and affects nothing else. The message has no `speaker` and no `peerBot`: no one is resolved for an observer, and no contact is recorded. A message that cannot be copied is dropped for the observers, with the error's name logged, and never reaches routing.

Observers see other people's untrusted text. Keep it out of logs, hold it no longer than the purpose needs, never act on instructions in it, and treat it as private to the people who wrote it. The returned function removes the observer. An observer cannot answer or admit a message; to answer, own the channel with a claim.

### `personas` and `context.turns`: conversations of a kind of your own

A conversation has a kind: the string its claim returns from `startFresh`, such as `"owner"` or `"study"`.
Your plugin names its claims' kinds; the host treats them as opaque strings.
A `Persona` supplies the system prompt for every non-agent conversation of one kind: `{ kind, prompt(), memory? }`.
`memory: "none"` leaves memory out of its conversations: no memory tools and no memory in the prompt; `"speaker"`, the default, reads as the next list says.
The runtime reads `prompt()` when it creates the conversation's session, so message catalog text uses the host's language.

- A plugin contributes `personas` with the kinds it owns; `sessions().persona(kind)` is the linked lookup a runtime uses.
- Two personas of one kind are refused, naming both plugins, and so is the kind `"agent"`, which the agent server keeps for its agents.
- The kind `"owner"` is the default for a conversation whose claim names none.
  The plugin that owns the owner's conversations contributes its persona; without one, those conversations start with an empty system prompt.
- List tools your plugin needs in `requiredTools`; startup builds a session and refuses to run if any listed tool is unregistered.
  The host merges every plugin's list and keeps each name once.
- A turn whose kind has no persona is refused with an error naming `personas`.
  The Pi runtime refuses when it makes the session; a runtime of your own does the same, as the example's does.
- With the memory addon on, the conversation decides whose memory the system prompt carries and the memory tools change, by principal and never by tier: a private conversation's person's, whoever speaks in it; in a shared conversation, each turn's speaker's (`speaker.principalId`), so a second owner reads their own and not the primary owner's; and no one's in the host's own turns (`SYSTEM_PRINCIPAL`) in a shared conversation.
  The primary owner's memory keeps its 0.8 heading and rows: their principal is 0.8's owner id.
- A shared conversation's history never hands one person's memory to another. Each memory tool's result records whose memory it holds (`details: { privateTo: <principalId> }`), and before every model request the Pi runtime shows a result of someone other than the turn's reader, the host's own turns included, as `(another person's private memory, hidden)`, and a memory result that does not say whose as a placeholder too, one recorded before results said whose or a failed call's, such as one whose arguments were refused (a memory tool whose store fails still records whose memory the call was for, so its person reads their own failed exchange); the call that result answers, matched by its id, keeps its id and name but reads its arguments as `{ hidden: <the same placeholder> }`, so what the model copied from that memory into the call is not sent either; the prompt states Pi recorded in the history collapse into the current prompt alone, so an earlier speaker's memory section is not sent either, and the answers of earlier turns go without their reasoning (thinking, encrypted reasoning, tool calls' thought signatures, and the thought signature Gemini puts on an answer's text; OpenAI's signature of an answer's message, which names its id and phase, is no reasoning, but the message and call item ids OpenAI's Responses paired with the removed reasoning go with it, while each call keeps the id its result answers and each message its phase), which may restate the memory their turn read; the running turn keeps its own. What people wrote, and the assistant's replies, stay shared. A tool of your own whose result holds someone's private data returns the same `details.privateTo` principal id, including an error that repeats private input: both its arguments and result are hidden, regardless of the tool name.
  A hidden result also drops private payload in its `details` and nested-call records, retaining only its ownership marker.
  A host building an independent shared Pi session applies `memoryProjection` on `context_with_system` and `privateCompaction` before summarizing; the optional surrounding-history arguments of `summaryProjection` and `privateCompaction` preserve redaction across split exchanges. In the opt-in sandbox Pi protocol, return `PiToolResponse.privateTo` and pass the admitted `author.principalId`; the worker records `details.privateTo` and applies those projections itself. The runtime does it for you when the tool's `session.runTask` worker loaded the reader's memory: that call's result, and those of the calls it runs within (the outer call of a nested call, the call whose worker's task started it), record the reader as whose it is, while a call merely running beside it keeps its result public. The runtime knows which call started a task from the call its session tools' `execute` runs within; a task started from outside every tool call, such as an event handler's, cannot say, so every call running then records the reader. The guarantee, then, covers memory exchanges: a memory tool's call and result, and a call whose worker loaded the reader's memory and its result, each pair hidden from every other speaker and from compaction summaries, and the reasoning of earlier turns. Anything else the model writes, into another tool's arguments or into its reply, is public, and whatever it repeats there of someone's memory reaches everyone in the conversation. This holds for the requests the core sends; a provider that replays history of its own bypasses it. Each turn records its actual reader and whether its request carried private prompt memory, a memory exchange, or a memory-loaded worker. Before any provider call and on agent model switches too, claude-bridge checks the raw branch, including compacted reader records, and refuses a turn whose history carried another reader's private memory or an inaccessible explicit exchange. This refuses reasoning replay across readers even without memory tool calls. A recorded turn without private memory never blocks another reader merely for speaking; malformed, truncated and unanswered memory calls belong to their recorded turn reader, so its own reader can continue. For this core check only SYSTEM counts as primary owner, including modern exchanges/reasoning; SYSTEM can read that raw owner memory and repeat it publicly, despite per-request projection loading no personal memory for SYSTEM. Pre-0.9 untagged memory results before the first scope record retain owner attribution; later unowned exchanges without reader records fail closed. Disabling future memory does not bypass recorded private history. In Pi sandbox mode, party-wide prompt blocks must explicitly set `memory.visibility: "shared"` (default private), and the worker capability handshake fails private turns closed on an old image. Admission of other principals warns at startup and in doctor rather than failing boot. Public replies, untagged custom tools and old summaries remain possible disclosure paths: see the [bridge guard](migration-0.9.md#claude-bridge-guard).
- A conversation 0.8 recorded through `context.turns` without `conversation` stays shared: whether such a room was one person's cannot be told, and adopting it for someone would refuse everyone else's turns. Its memory is each speaker's, as before, and its tools name the speaker. A plugin whose 0.8 conversations were one person's adopts them with `CONVERSATIONS.adopt`, as remote-mcp does.

Call `context.turns.run(input)` inside your claim's queue task to run a turn in a conversation it owns.
It shows typing and the stop control on the channel's surface, runs the turn, and emits `turnStarted` and `turnEnded` with the turn's `kind`.
It catches runtime errors as failed results and posts the answer, failure notice, or stopped notice through the surface.
Supply `reply(result)` to handle the reply yourself.
`input` has `channel`, `kind`, `text`, `speaker`, and optionally `origin` (where the request came from, as your claim's transport knows it, such as a connection's browser origin; tools read it as `turn.origin`, so never fill it from message text), `client` (a `ClientPort` for what the client that started the turn can do, which tools read as `turn.client`; only your transport provides one), `attachments`, `selection` (by default the plugins' `agentSelection`), `steerable`, `interactive`, `byMessage` (the speaker's message started the turn; set it only for a turn a person's message started, since it lets the turn spend the speaker's late approval), `confirmed` (the speaker's message approved the held calls; calls that [name approvers](#a-hold-that-names-its-approvers) the speaker is neither among nor an owner of stay held), `reply`, and `conversation`.
It rejects with `NotLinkedError` during `setup`, and with a `PluginError` on a host whose runtime plugin has not provided a runtime.

Before each turn runs, `context.turns.run` records its conversation in the host's registry, `CONVERSATIONS`: at the first turn its key, surface, kind, visibility, owner, and title, and at every later turn only that it was active.
`conversation: { visibility: "private" }` records it as the speaker's own (its `principalId` is `speaker.principalId`); without it the conversation is `shared`.
Only its person speaks in a private conversation: a turn whose speaker is another principal is refused before it starts, except the host's own turns (`SYSTEM_PRINCIPAL`), such as a report's.
Neither a later turn nor another plugin changes what the first turn recorded, with one exception for data from before 0.9: `adopt(key, principalId)` makes a conversation recorded `shared` with no principal, as 0.8 recorded every turn run without `conversation`, private to that principal.
It is for a plugin migrating what its own 0.8 version left, such as remote-mcp giving each session 0.8 opened to the primary owner; it never changes a private conversation or one with a principal, and repeating or racing it is safe.
Adopting a conversation that 0.9 or later recorded is outside its contract: a shared conversation recorded since then is shared on purpose, and a later version may refuse to adopt it.
`conversation.title` names it at its first turn; `setTitle(key, title)` renames it later.
The runtime is told who the conversation belongs to as the registry keeps it, in `TurnRequest.conversation`, so a private conversation's prompts stay its person's at every later turn; a host without the registry passes the turn's own `conversation`, if it gives one.
A turn whose conversation cannot be recorded does not run, and the call rejects.
The registry records and never refuses: who may speak in a conversation stays your claim's decision, which may read `get(key)` to check the owner.
`list({ principal })` gives one principal's conversations and `list()` every one, the most recently active first; the web console lists them too.
A conversation from before the registry is recorded at its next turn.
Register a private conversation before the first direct runtime call, transcript reads included, rather than relying on a current speaker to define the session.
Never change visibility to reuse history: when the effective private principal or visibility changes, the runtime archives history, drops held actions, and starts isolated, after a restart too.

<!-- example: examples/study-room.ts -->
```ts
import { definePlugin, parseChannelKey } from "pi-roundtable";

/** The kind of a study room's conversations: the string `startFresh` returns, and the persona's kind. */
const STUDY = "study";

/**
 * A conversation kind of its own. The persona is the system prompt of every `study` conversation,
 * the claim owns the channels of the study rooms, and `context.turns` runs each message as a turn
 * of that kind on whatever runtime the host has, and posts the answer through the channel's
 * surface.
 */
export const studyRoom = definePlugin({
	name: "study-room",
	setup: ({ turns }) => ({
		personas: [
			{
				kind: STUDY,
				prompt: () =>
					"You are a patient tutor. Ask one question back before you give the answer.",
			},
		],
		channels: [
			{
				name: "study-rooms",
				priority: 10,
				// The id of a room starts with `study-`, on whichever surface carries it.
				owns: (channel) => parseChannelKey(channel).id.startsWith("study-"),
				admit: (message) => {
					const speaker = message.speaker;
					if (message.authorIsBot || !speaker) return undefined;
					return {
						kind: "turn",
						run: async () => {
							await turns.run({
								channel: message.channel,
								kind: STUDY,
								text: message.text,
								speaker,
							});
						},
						failure: "a study turn failed",
					};
				},
				// What the conversation was, so a host picks the right persona when it starts over.
				startFresh: async () => STUDY,
			},
		],
	}),
});
```
<!-- /example -->

The test uses the fake surface and echo runtime from [the runtime slot](#the-runtime-slot-replace-pi):

<!-- example: examples/study-room.test.ts -->
```ts
import { expect, test } from "bun:test";
import { IDENTITY } from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import { createEchoRuntime } from "./echo-runtime.ts";
import { FakeSurface } from "./fake-surface.ts";
import { studyRoom } from "./study-room.ts";

/** The plugin over the fake surface and the echo runtime, with nothing else: no Discord, no Pi, no database. */
async function studying() {
	const surface = new FakeSurface();
	const harness = await testPlugin(studyRoom, {
		surfaces: [surface],
		providers: { runtime: createEchoRuntime },
		services: [
			servicePair(IDENTITY, {
				resolve: async (facts) => ({
					id: facts.subject,
					name: facts.name,
					principalId: "student",
					tier: "member",
				}),
			}),
		],
	});
	return { surface, harness };
}

async function until(done: () => boolean): Promise<void> {
	for (let waited = 0; !done() && waited < 1000; waited += 5)
		await Bun.sleep(5);
	expect(done()).toBe(true);
}

test("a message in a study room runs as a turn of the study kind, with the tutor's persona", async () => {
	const { surface, harness } = await studying();
	surface.say("fake:study-algebra", "What is a group?");
	await until(() => surface.replies.length > 0);
	expect(surface.replies).toEqual([
		{
			channel: "fake:study-algebra",
			reply: {
				chunks: [
					"[You are a patient tutor. Ask one question back before you give the answer.] What is a group?",
				],
			},
		},
	]);
	// The plugins' turn events carry the kind and no agent.
	const started = harness.events.find(({ name }) => name === "turnStarted");
	expect(started?.turn).toMatchObject({
		kind: "study",
		channel: "fake:study-algebra",
		speaker: { principalId: "student", tier: "member" },
	});
	expect(started?.turn?.agent).toBeUndefined();
	await harness.stop();
});

test("a channel that is not a study room is not the claim's", async () => {
	const { surface, harness } = await studying();
	surface.say("fake:lounge", "hello");
	await Bun.sleep(30);
	expect(surface.replies).toEqual([]);
	await harness.stop();
});

test("starting a room over says it was a study conversation", async () => {
	const { harness } = await studying();
	expect(await harness.conversations.startFresh("fake:study-algebra")).toBe(
		"study",
	);
	await harness.stop();
});

test("an author with no resolved tier never starts a study turn", async () => {
	const surface = new FakeSurface();
	const harness = await testPlugin(studyRoom, {
		surfaces: [surface],
		providers: { runtime: createEchoRuntime },
	});
	try {
		surface.say("fake:study-algebra", "hello");
		await Bun.sleep(30);
		expect(surface.replies).toEqual([]);
		expect(harness.events).toEqual([]);
	} finally {
		await harness.stop();
	}
});

test("the persona is the plugin's and belongs to the study kind only", async () => {
	const { harness } = await studying();
	const [persona] = harness.contribution.personas ?? [];
	expect(persona?.kind).toBe("study");
	expect(persona?.prompt()).toContain("patient tutor");
	await harness.stop();
});
```
<!-- /example -->

### Channel context: what was said around an addressed message

In a Discord server channel, people talk among themselves and address the assistant now and then.
Channel context lets the turn for an addressed message also read what was posted there since the assistant last posted, mentions or not.
The agent server reads it for every turn in an agent's channel; a group's round does not, since it already carries what was said since the group's last turn.
A plugin's claim opts in by calling `DISCORD.channelContext(message, options?)` from `pi-roundtable/discord` inside its turn's `run`, and appending the result with `withChannelContext(text, context, imagesKept?)`, as `withReference` adds the replied-to message.

The same call works on any surface. A chat surface a plugin contributes implements the optional `ChatSurface.channelContext(message, options?)`, and `CHANNEL_CONTEXT.read(message, options?)` (from the main entry) picks the surface by the prefix of the message's channel key, as `THREADS` does, and returns what that surface returns; a surface without the method, a channel no surface serves and a message with nothing new all give `undefined`. A support inbox whose rooms are email threads, say, answers with the customer's messages since the assistant last replied, each marked `external: true` (see below). `DISCORD.channelContext` is the Discord surface's own answer to the same call, so a claim that reads either sees the same context. `ChannelContext`, `ChannelContextOptions`, `ChannelContextMessage`, `withChannelContext`, `withChannelContextImages` and `formatChannelContext` stay in the `pi-roundtable/discord` entry, which a plugin for another surface imports from too; `CHANNEL_CONTEXT`, `ChannelContexts`, `ChannelContextSource`, `ChannelContextSourceAttachment` and `ChannelContextVerdict` are in the main entry.

It reads Discord, not the host's history, so it survives restarts:

- It fetches the `fetch` messages before the addressed one (default 50, at most 100) and keeps those after the assistant's latest post there: its bot user's, or one of its application's webhooks, such as an agent's voice. Any post of the assistant ends the window, including the divider the core posts when a conversation starts over (see `discord.freshMarker`) and a notice that it did; a fresh-start reply must be a public post, not an ephemeral one, to cut the window.
- It leaves out the assistant's own posts, the addressed message, empty messages, and every message it handed over before or that addressed it before in that channel, remembered in memory per channel, so a restart can repeat at most what came since the assistant's last post.
- Other bots and integrations are kept and marked as bots; the host's owners (the primary owner and every other owner's Discord identities) are marked as owners.
- Consecutive messages of one author at least `similarity` alike (default 0.8, by their longest common run of text) count as one, the later kept.
- It keeps the newest `keep` (default 15), oldest first. Mentions read as names, and stickers and files as text with their names and links; by default nothing is downloaded or shown to the model as an image (see `attachments` below). A message is cut at `messageChars` (default 500), another bot's at `botMessageChars` (default 80).
- It never fails the turn over Discord: a Discord error, such as a channel the bot cannot read, is logged and the turn runs without context.

A plugin may mirror an outside chat into a channel through a webhook of its own, created by the bot, so that the application owns it; by default such a post counts as the assistant's own, which ends the window and is left out, and the people mirrored never reach a turn. `foreignWebhook(webhookId)` changes that for the webhooks it returns true for: a post through one is another author's, kept like another bot's (`bot: true`, `authorName` the post's username, `authorId` the webhook's id) and no longer ends the window, which then ends only at the assistant's own posts: its bot user's and every webhook `foreignWebhook` returns false for, such as an agent's voice. It may also return `"skip"` for a webhook that is neither, such as one the plugin posts its own status notices through: a post through it is dropped from the context and does not end the window, as if it were not in the channel, so notices between two mirrored posts neither appear as someone's words nor cut the window, and they are not counted among the messages delivered. Any answer other than `true` and `"skip"` reads as false. A skipped post is still one of the `fetch` messages read, so it uses the budget the window is chosen from. The host sets it as `discord.channelContext.foreignWebhook` and a call overrides it for that call; being a function, it can be set only in code. `authors(message)` is the same decision for any surface and any message, not only a webhook's: it receives the fetched message (`ChannelContextSource`: `id`, `authorId`, `authorName`, `bot`, `own`, `webhookId?`, `external?`, `attachments?`, `at`, `text`) and answers `"keep"` (another author's, which does not end the window; `foreignWebhook` returning `true`), `"skip"` (dropped as if it were not in the channel, without ending the window; `"skip"` of `foreignWebhook`), `"end"` (the assistant's own, which ends the window and is left out; `foreignWebhook` returning `false` for an application webhook) or `undefined`, which leaves the default: the assistant's own posts end the window and everything else is kept. Where it answers, it wins over `foreignWebhook`; it is a function, so it can be set only in code, as a host default (`discord.channelContext.authors`) or per call. Posts through a webhook that `foreignWebhook` returns true for are merged as near repeats only when the poster's name is the same too, since one webhook carries many people; every other message merges by author alone, as before. An edited message reads as Discord now holds it.

A message a surface knows to come from outside the people the host serves, such as a customer whose email a support inbox mirrors, is marked `external: true` (`ChannelContextMessage.external`, `ChannelContextSource.external`): it is never an owner, and the block labels it `role="external"`, the model's cue that its text is untrusted. Discord marks none.

Every returned message has `attachments` (`ChannelContextAttachment`: `name`, `contentType`, `size`, `url`, `messageId`), whether or not anything was fetched. With `attachments: { images, maxBytes }` (`ChannelContextAttachmentOptions`; default none) a call also fetches up to `images` (at most 4, a turn's limit) PNG, JPEG, GIF or WebP images of the kept messages, the newest first, each at most `maxBytes` (default 10 MiB, at most 25 MiB), and returns them as `context.images`, prepared as a turn's own images are (large ones are scaled down) and kept in memory by this call and never logged; once a turn is given them they are in its session history like the turn's own images, and stay there. Pass them on with `withChannelContextImages(attachments, context)`, which returns `{ attachments, kept }`: the turn's attachments with the context's images after the turn's own, within the four a turn carries, and how many of them fitted (a turn that already carries four keeps none, and an image crowded out is not noted anywhere). Give `kept` to `withChannelContext(text, context, kept)`: above zero it adds a line that pictures are shown among the turn's images, and it adds none otherwise, so the block never claims images the turn does not have. The image is sent as the type its bytes show (PNG, JPEG, GIF or WebP), not as Discord's guess from the file name, and bytes of none of them are skipped as `unsupported type`. Up to two images are downloaded at once, within 20 seconds for the whole call; the images still to be fetched when it passes are skipped as `download failed`. An image that is not a type the model takes, is over `maxBytes`, cannot be downloaded or cannot be decoded is skipped, and its message's text says `[image not attached: <name>: <reason>]`, the reason being `unsupported type` (by Discord's type or by the bytes), `too large`, `download failed` or `could not be decoded`; skipped images do not count toward `images`, but at most twice that many are tried. An image of a message already handed over is not fetched again, since its message is not returned again.

`DISCORD.channelContext` resolves undefined in a direct message, on another surface, when nothing new was said, and when the host's `discord.channelContext` is `false`, which turns it off for the agent server and every claim.
The configuration's values are the host's defaults, and a call's `options` override them for that call.
Call it once per answered message: what it returns is remembered as handed over.
A call's `options` are validated like the configuration (`fetch`, `keep`, `messageChars` and `botMessageChars` positive integers, `similarity` from 0 to 1, `foreignWebhook` a function of a webhook id returning `true`, `false` or `"skip"`, `authors` a function of a message returning `"keep"`, `"skip"`, `"end"` or `undefined`, `attachments.images` an integer from 0 to 4, `attachments.maxBytes` an integer from 1 to 25 MiB); an invalid one makes the call reject, a programming error, so `keep: 0` is not "none" (skip the call for that).
It remembers what it handed over and what addressed the assistant, not every message that ran a turn: a post a claim answered some other way, such as a webhook report turn or a steered message, can also come in the context of a later turn if the assistant has not posted since.

What it returns is public channel text, visible to everyone in the channel; it is not private memory, carries no `privateTo`, and goes into the turn's text, so it lives in the conversation's history, not in the system prompt.
The turn's reader stays the person who addressed the assistant.
People the access rules give no tier are included as channel text, as everyone there sees them, but they do not become speakers: they are not resolved, linked, or recorded, and the turn does not run as them.
Only server channels are read, never direct messages, and only messages the bot can read.

The window ends at the assistant's last public post, so a conversation started over must end it too, and the owner's reply to the command is ephemeral.
When any claim's conversation is started over in a server channel or thread, through `conversations.startFresh` (the agent server's channels, a plugin's claim such as a party, an owner channel), the core posts one short divider there as the bot, after the claim's `startFresh` succeeded, and the next turn reads nothing from before it.
It is not posted in a direct message or on another surface, and a failed post is logged as a warning: the restart still counts and the ephemeral reply still goes out.
The text is `discord.freshMarker` (default `─── new conversation ───`); `false` posts none.
A surface a plugin contributes may implement the optional `ChatSurface.markFresh(channel)` for the same job.

Discord does not render Markdown tables, so the Discord surface tells the model about it: every turn that replies in a Discord channel gets a short guidance text appended to its system prompt, after the persona.
The default says that Markdown renders except tables, that bullet lists or `key: value` lines replace them, that headings, bold, lists, quotes, inline code, fenced code blocks and `-#` small text work, and that a reply over 2,000 characters is split.
`discord.formatting` replaces the text; `false` tells the model nothing.

The block gives each author as a name, their id and a role (`owner`, `bot`, `external` or `member`) in separate attributes, and says the messages were not addressed to the assistant. A name loses the characters `"`, `'`, `=`, `<`, `>`, `(`, `)` and `,`, so it cannot imitate another author, an attribute or a role, and every `<` (also the full-width `＜`) in a message's text is replaced by `‹`, so a message can neither close the block nor open a message of its own.
`ChannelContext` is `{ messages, text, images? }`: `messages` are `ChannelContextMessage`s (`id`, `authorId`, `authorName`, `bot`, `owner`, `external?`, `text`, `at`, `attachments`), oldest first, `text` is the block, and `images` the fetched images (see above).
`ChannelContextOptions` holds the options above, and `CHANNEL_CONTEXT_DEFAULTS` their defaults.
`formatChannelContext(messages)` is the function that writes `ChannelContext.text`, exported so a host can test what the model sees without reaching into the core: it takes `ChannelContextMessage`s (only `authorId`, `authorName`, `bot`, `owner`, `external` and `text` are read) and returns the block, headed and delimited by `<channel-context>`. Each message is a `<message from="…" id="…" role="owner|member|bot|external">` line whose author is in the attributes, never in the text, and every `<` of a name or text (plain or full-width) is replaced by `‹`, so no message can pass as markup. It does not fetch, cut or select anything, and it is the same function the reader calls, so a block it returns is the block a turn carries.
In a test, `fakeDiscord({ channelContext })` answers `DISCORD.channelContext` as the test says; by default with no context.

<!-- example: examples/channel-context.ts -->
```ts
import { definePlugin, parseChannelKey } from "pi-roundtable";
import { DISCORD, withChannelContext } from "pi-roundtable/discord";

/** The kind of the tavern's conversations. */
const TAVERN = "tavern";

/**
 * A claim that opts in to channel context: in the Discord channels it owns it answers only the
 * messages that mention the assistant or reply to it, and each turn also reads what the others
 * said there since the assistant last posted. The context is public channel text appended to the
 * turn's text; the people who wrote it do not become speakers.
 */
export function tavern(channelIds: readonly string[]) {
	return definePlugin({
		name: "tavern",
		setup: ({ turns, services }) => {
			const discord = services.get(DISCORD);
			return {
				personas: [
					{
						kind: TAVERN,
						prompt: () =>
							"You keep the tavern's table. Answer the person who addressed you.",
					},
				],
				channels: [
					{
						name: "tavern",
						priority: 10,
						owns: (channel) => {
							const { surface, id } = parseChannelKey(channel);
							return surface === "discord" && channelIds.includes(id);
						},
						admit: (message) => {
							const { speaker } = message;
							if (message.authorIsBot || !speaker) return undefined;
							if (!message.mentionsBot && !message.repliesToBot)
								return undefined;
							return {
								kind: "turn",
								run: async () => {
									// Once per answered message, inside `run`: what it returns is not returned again.
									const around = await discord.channelContext(message, {
										keep: 20,
									});
									await turns.run({
										channel: message.channel,
										kind: TAVERN,
										text: withChannelContext(message.text, around),
										speaker,
									});
								},
								failure: "a tavern turn failed",
							};
						},
						startFresh: async () => TAVERN,
					},
				],
			};
		},
	});
}
```
<!-- /example -->

### Peer bots: answering other bots

Every bot's message is ignored by default, so two bots in one channel never talk to each other.
A host opts in by listing the other bots it answers, by user id, in `discord.peerBots` (or the host option `peerBots`):

```ts
discord: {
	// ...
	peerBots: {
		// Explicit ids only: there is no wildcard and no "all bots". Left out, no bot is answered.
		allow: [
			"800000000000000001",
			{ id: "800000000000000002", guilds: ["900000000000000001"], channels: ["700000000000000001"] },
		],
		maxRounds: 3, // default 3
	},
},
```

An id that is not a Discord id (17 to 20 digits) stops the start with a `ConfigError` that names its place in the list.
The router, not each claim, applies the list: for a message from a listed bot it sets `InboundMessage.peerBot` and resolves a `speaker` for it through the identity service as for a person, so the host's `access` rules still decide whether that bot is served and at which tier (`discord:<id>` under `access.members` or `access.admins`, or `everyone` and `provisioning: "admitted"`); a bot the rules do not serve gets no turn. A peer is served through its identity and `everyone` only: the Discord roles it holds are not read, so a role rule meant for people never lifts a bot. A webhook is never a peer, and a surface's own `peerBot` is dropped.
A channel answers at most `maxRounds` of the listed bots' messages in a row, counted when a claim takes the message; a person's message in the channel starts the count over, and the messages after the cap are ignored (logged at info).
Channel context is unchanged: its window still starts after the assistant's last post and other bots' messages are still cut at `botMessageChars`.

The agent server answers a peer that mentions the agent or replies to it, like a guest. A listed peer's `speaker` is resolved like a person's, so a claim that checks only `speaker` answers it too. A claim of your own opts in where it once checked `!message.authorIsBot`, with `answersAuthor(message)` from `pi-roundtable/kit`, which is true for a person and for a flagged peer that mentions the bot or replies to it:

```ts
import { answersAuthor } from "pi-roundtable/kit";

// A status-board claim: people and the listed build bot may ask for the latest run.
const statusClaim: ChannelClaim = {
	name: "status-board",
	priority: 50,
	owns: (channel) => channel === "discord:700000000000000001",
	admit: (message) =>
		answersAuthor(message) && message.speaker
			? { kind: "turn", run: () => answer(message), failure: "status turn failed" }
			: undefined,
	startFresh: async () => "status-board",
};
```

A reply that contains `<@id>` of a peer pings it, since replies allow user mentions; without that the peer's `mentionsBot` stays false.
In a test, `testPlugin({ peerBots: { allow: [...] } })` puts the same list on the test router.

### Posting through `DISCORD.poster`

`DISCORD.poster` (`DiscordPoster`, from `pi-roundtable/discord`) is Discord's REST API for a plugin's own posts, over the Discord plugin's own client.
A host has one REST queue for the whole process, so the poster and the gateway client share Discord's rate-limit state, which Discord keeps per bot token.
It is usable from a service's `start` on; do not call it from `setup`, which `Roundtable.check()` also runs. Making it sends nothing, so the check never reaches Discord.
There is no factory: a host that has no Discord has no poster.

```ts
import { DISCORD } from "pi-roundtable/discord";

const { poster } = services.get(DISCORD);
const posted = await poster.post(channelId, { webhook: "relay", username: "Ann", content: "Hello" });
await poster.edit(channelId, posted.messageId, { content: "Hello again" }, ["relay"]);
await poster.remove(channelId, posted.messageId, ["relay"]);
```

What it covers: webhook posts under names you choose (`post`, `edit`, `remove`, `webhookIds`, `setAvatar`, `onWebhookMade`), cards posted through such a webhook (`postCard`, `editWebhookCard`), the bot's own messages and cards (`say`, `sayCard`, `editCard`, `deleteAsBot`), direct messages (`sendDirect`), pins, reading (`message`, `recentMessages`, `botUserId`, `channelGuild`, `canView`, `memberName`), text channels (`createTextChannel`, `textChannels`, `deleteChannel`, `renameChannel`) and threads (`startThread`, `setThreadArchived`, `threadState`, `threadCloser`).
Use `DISCORD.connection.channelInfo(channelId)` to read what a channel is called now: it comes from the gateway's cache.

The rules the poster keeps, so a plugin does not rediscover them:

- **Webhooks are named by the plugin.** `post` finds the bot's webhook of that name in the channel, or makes it on first use; a same-named webhook someone else made is never used. A plugin that needs several voices keeps one name per voice, so the `webhookId` on a message tells them apart. A webhook name, and a post's `username`, are 1 to 80 characters without "discord" or "clyde" in any case (full-width letters too); a username is not "everyone" or "here" either. Anything else is refused as `invalid` before a request is sent. `edit` and `remove` take the names to ask, in order, since a webhook changes only its own messages; they make no webhook. `remove` falls back to deleting as the bot (Manage Messages) for a message an earlier webhook of the same name posted.
- **Nothing pings by accident.** Every post, edit, card and direct message sends `allowed_mentions` with `parse: []` and, for a post, the `mentions` users you list (at most 20). `@everyone`, roles and users merely named in the text never ping.
- **Cards are Components V2 messages.** A card carries no `content`. Three lessons: every `editCard` re-sends the Components V2 flag (without it Discord answers a 400); a message posted by `say` cannot be edited into a card (`rejected`: delete it and post a card, which changes the message id); and a pin makes Discord post a system notice (type 6) as the bot, which `recentMessages` lists, `deleteAsBot` deletes, and nothing can edit (`rejected`, Discord's 50021), so skip it when looking for your own message.
- **A card can carry a picture.** `thumbnail: { url, description? }` makes the heading a Section with a small picture beside it; `image: { url, description? }` puts a Media Gallery of one picture under the text sections and above the quiet last line. Both take an `https` address of at most 2,048 characters and an alt text of 1 to 1,024 characters, else `invalid`; `editCard` and `editWebhookCard` keep them when you send them again, and a card without them is sent exactly as before. Discord fetches the address itself, so it must be reachable from the internet.
- **A webhook can post a card.** `postCard` takes the same `webhook`, `username` and `avatarUrl` as `post` plus a `card`, and sends it with `with_components=true`, which Discord allows for the bot's own (application-owned) webhooks; a button or menu on it reaches your interaction handler like one on a bot card, and the colour bar stays. `editWebhookCard(channelId, messageId, card, webhooks)` asks each named webhook in order, as `edit` does: `message_gone` when none posted it, `rejected` for a message that is not a card. The webhook's token is never logged or put in an error.

```ts
await poster.postCard(channelId, {
  webhook: "alerts",
  username: "Build alerts",
  avatarUrl: "https://assets.example.org/alerts.png",
  card: {
    accent: 0xcc3333,
    title: "Build failed",
    sections: ["`main` failed at the test step."],
    thumbnail: { url: "https://assets.example.org/failed.png", description: "A red cross" },
    image: { url: "https://assets.example.org/graph.png", description: "Failures over the last week" },
    links: [{ label: "Open the run", url: "https://ci.example.org/runs/42" }],
  },
});
```

- **A channel is renamed twice in ten minutes.** Discord answers a third with a wait of minutes. `renameChannel` does not queue it: after ten seconds it fails as `unavailable`, and the held request is aborted, never sent later.
- **Threads.** `startThread` makes a public thread on a message that archives itself after a week and wakes on the next post. The bot needs no Manage Threads to archive or open a thread it started; a locked thread needs it to open again (`forbidden`). `threadCloser` reads the guild's audit log (View Audit Log, else `forbidden`): a person's id, the bot, or `unknown` for Discord's own auto-archive. An archive counts only if its entry is within two minutes of the thread's `archive_timestamp`. It reads the newest 50 `THREAD_UPDATE` entries, so on a busy guild an old close may have left the log and read as `unknown`.
- **Errors.** Every failure is a `DiscordPosterError` with a `kind`: `invalid` (refused before sending), `channel_gone`, `message_gone`, `forbidden` (a missing permission), `rejected` (Discord refused; asking again fails again) and `unavailable` (Discord or the network failed, or a rate limit held the call; `retryable`). `reason` says more for a full category (`category_full`), a channel that is no category (`not_category`) and one in no guild (`wrong_guild`). A webhook deleted by hand is found or made again once. A person who takes no direct messages is the answer `"closed"`, and a user who is not a member is `false` from `canView` and `undefined` from `memberName`, not failures. A message never holds a URL, a webhook token or the bot token.

`DISCORD_LIMITS` (frozen) holds the limits the poster checks: 2,000 characters a post, 80 for a username, 10 files and 10 MiB a post, 1 MiB for an avatar, 20 mentions, 250 pins, 100 characters for a channel name, 3,800 characters of card text, 5 card buttons and 25 menu choices.

In a test, `fakeDiscordPoster()` is a `DiscordPoster` in memory and `fakeDiscord({ poster })` or `testHost({ discord: { poster } })` gives it to the plugin; see [Testing a plugin](#testing-a-plugin). The real poster and the fake run the same scenarios, the real one over a local emulation of Discord's HTTP API.

### `backgroundTargets`: whose turn a schedule or delegated task is

Schedules and delegated tasks return later as turns without a new message in the channel.
A `BackgroundTarget` says whose turn that is: a `name` that the schedule or job stores, a `label(locale)` that lists such as `/<root> schedule` show, and the limits that apply to it.
`schedules` (`perChannel`, `promptChars`, `aheadDays`, and optionally `perPrincipal`) bounds what `schedule_create` accepts, and `delegation` (`maxRunning`, and optionally `maxRunningPerPrincipal`) bounds how many delegated tasks may run in one channel; a target without one of them may not schedule or delegate at all. `perPrincipal` and `maxRunningPerPrincipal` hold each person to that many of the target's schedules, or running tasks, across all their conversations. A schedule store counts a person's schedules for `perPrincipal` in `createWithin`, which must count and store as one step for that person, so creates at once in several conversations stay within the limit; the built-in store does it in one transaction under a lock on the creator.
The claim that answers the target serves it in its `background(turn)`, where `turn.target` is the name, and skips every target it does not serve.
A channel's claim runs turns only for its own target, keeping the owner's tools out of channels open to many people.

A turn is someone's: `turn.author.principalId` is the principal who set up the work, `turn.author.id` and `name` how they are shown, and `turn.tier` the tier it asks for, all required.
The router checks the author as the turn starts, in its place in the channel's queue, and hands the claim `turn.speaker`, the speaker to run it as: the principal at the lower of `turn.tier` and their tier now.
It skips the turn, with the reason, when the principal does not exist, is disabled, holds no tier, or holds one only from what a surface reports and was last seen more than `access.backgroundStaleDays` ago, and when the turn names no principal or tier; it never runs one as the owner's by default.
A turn naming the system principal (`SYSTEM_PRINCIPAL`) runs only when the host itself started it.
A schedule stores its creator's principal as `createdById` and runs as them; a delegated task's report runs as the person whose turn delegated it.
In a turn nobody is named for, the schedule and delegation tools refuse.

- Contribute `backgroundTargets` alongside the claim that serves them; read one with `context.conversations.target(name)` from a service or handler.
- Two targets with the same name are refused, naming both plugins.
- The core's `modules` plugin contributes `PERSONAL_TARGET` (name `"owner"`, exported from the main entry; `OWNER_TARGET` is a deprecated alias) on every host, for every person's conversations whose claim answers background turns, such as the agents' and an app's owner conversation.
  The agent server's claim answers that target and skips all others, so a turn for another target never runs with the owner's tools.
  Its limits are 0.8's, and it holds no one to a number of schedules or running tasks across their conversations unless the host's configuration says so: `background: { perPrincipal: { schedules: 20, delegations: 2 } }` sets its `perPrincipal` and `maxRunningPerPrincipal`. A host that serves many people sets both.
- The built-in schedule and delegation tools make `PERSONAL_TARGET` work, and a session has them only where it can run: when the claim that owns its conversation has `background`, or, for a conversation no chat surface carries, when its creator has a direct channel, as a provider knows without the network.
  Such a conversation has the tools only when the registry records it private: its person is whom the work runs for. One recorded shared, or not recorded, has neither tool, whoever speaks in it, because a session outlives the turn it is built in.
  A plugin that calls the runtime directly records its no-surface conversation as private before the session is built.
  Creation reaches the speaker's own direct channel and checks that its claim takes background turns, refusing when either is absent; it never falls back to the primary owner's messages.
  In a private conversation, as the host's conversation registry records it, `schedule_list`, `schedule_update`, and `schedule_cancel` see only the speaker's own schedules.
- A turn for a target no plugin contributes is skipped with the reason `no plugin contributes the background target "<name>"`.
  It never falls back to the owner's target; a recurring schedule keeps the reason as its last status and runs again once a plugin contributes the target.
  A one-time schedule is spent when it fires.
- A schedule keeps its target's name in its row, so renaming a target orphans the schedules made for it.

<!-- example: examples/support-desk.ts -->
```ts
import { type BackgroundTarget, definePlugin } from "pi-roundtable";

/**
 * Whose turn a schedule or a delegated task asks for. The target sets what may be scheduled or
 * delegated for it, so a desk open to many people is held tighter than the owner's own agent.
 */
const SUPPORT: BackgroundTarget = {
	name: "support",
	label: () => "Support desk",
	schedules: { perChannel: 3, promptChars: 500, aheadDays: 30 },
	delegation: { maxRunning: 1 },
};

/**
 * A plugin that answers the turns nobody wrote in its channels. The router skips a turn whose
 * target no plugin contributes, and this claim skips the targets it does not serve, so another
 * target's schedule never runs here.
 */
export const supportDesk = definePlugin({
	name: "support-desk",
	setup: () => ({
		backgroundTargets: [SUPPORT],
		channels: [
			{
				name: "support-desks",
				priority: 10,
				owns: (channel) => channel.startsWith("support:"),
				admit: () => undefined,
				background: async (turn) =>
					turn.target === SUPPORT.name
						? { status: "ran" }
						: {
								status: "skipped",
								reason: `the support desk does not serve "${turn.target}"`,
							},
				startFresh: async () => "support",
			},
		],
	}),
});
```
<!-- /example -->

### `directChannels`: reaching a person on their own

A plugin whose chat network gives each person a conversation of their own, such as direct messages or a web inbox, contributes a `DirectChannelProvider` for it:

```ts
setup: ({ services }) => ({
	directChannels: [
		{
			name: "inbox",
			label: "a notice in the web chat's inbox",
			reaches: async (principalId) => inboxOf(principalId),
			deliver: async (principalId, text) => postNotice(principalId, text),
		},
	],
}),
```

| Field | What it is |
|---|---|
| `name` | Unique across every plugin; a second provider of one name is a `PluginError` naming both plugins |
| `label` | How the `notify` tool names a notice sent through it, completing "Send Ada …", such as `a direct message on Discord` |
| `reaches(principalId)` | The person's own conversation here, as a channel key, or `undefined` when they have none here. It may reach the network and throw |
| `knows(principalId)` | Optional: whether the person has a conversation here, from the host's own records such as their linked identities, without the network. A session asks it when it decides whether to offer `notify` or the schedule and delegation tools, so an outage then does not take them away; without it the host asks `reaches` |
| `deliver(principalId, text)` | Optional: sends the notice itself. Without it the host posts the text in the channel `reaches` names, through the surface that serves it |
| `mirror(principalId, text)` | Optional: echoes a notice another provider delivered, such as a web app pushing to a phone that Discord's direct message already reached. `notify` calls it on every provider but the one that delivered, only after a delivery; a failure is logged and never changes the result |

The host reaches a person through the first provider, in contribution order, that reaches them.
`context.directChannels.reach(principalId)` resolves that provider and channel, or `undefined`; `known(principalId)` resolves the first provider that knows the person without the network; `notify(principalId, text)` sends a notice there and resolves `false` when no provider reaches the person.
The Discord plugin contributes one named `discord`: it finds a principal's Discord identities through `IDENTITY` and reaches the first one's direct messages, the primary owner's configured identity first, so a single owner is reached in the same direct messages as in 0.8.

The `notify` tool, 0.8's `notify_owner`, sends such a notice. A session has it only when a provider is contributed, and a private conversation only when a provider knows its person; the channel itself is reached when a notice is sent.
It notifies the conversation's person in a private conversation and the turn's speaker in a shared one, and refuses when no provider reaches them or when the speaker is not the private conversation's person; the host's own turns, such as a report's, notify the conversation's person in a private conversation and the primary owner elsewhere, as `notify_owner` did.
Its description names the channels that can reach the person, so a host with only Discord reads `Send Ada a direct message on Discord. …` as 0.8 did.
In a shared conversation it names the primary owner while only they can receive a notice (the host has no other owner, and only owners may use it), and "the speaker" otherwise; this is checked again before each turn, so an open session follows an owner granted or revoked meanwhile.
Until 1.0 the name `notify_owner` still selects it in a selection or a profile and names it in a task's `exclude` and a plugin's `requiredTools`, and an operator's or a plugin's `toolTiers` entry for `notify_owner` applies to `notify` unless `notify` has its own.
Using the old name logs a deprecation warning once per logger, whether in a selection or in `toolTiers`.

### `surfaces`: a chat network of your own

A chat surface connects the host to one chat network: it reports what people write, and it posts what the conversations answer.
The host ships Discord's; a plugin contributes another with `surfaces`, and its claims answer on it through `context.surfaces`.
All surfaces share one conversation router.
The surface delivers messages; the channel's owning claim decides what happens to them.

A surface serves the channels whose key starts with its `surface` prefix: `surface = "fake"` serves `fake:<id>` keys, and only those reach its methods.
The prefix is one non-empty word without a colon or a space, unique per host: two surfaces with one prefix stop the start, naming both plugins.
The agent server claims `discord:` keys, and, only on a surface that declares `agentRooms: true`, the `<surface>:agent.<name>` and `<surface>:group.<name>` rooms of agents and groups the team has; it claims no other key of your surface, so claims on your surface's other channels don't compete with it.

| Method | What the surface does | Without it |
|---|---|---|
| `surface` | The key prefix | (required) |
| `start(deliver)` | Connects, and calls `deliver(message)` for every incoming message; the host passes its conversation router | (required) |
| `sendReply(channel, reply)` | Posts an `OutboundReply`: a thinking line, a card, text chunks, then files; a reply with `intercom` is a message between agents, which a surface may draw as a small card in place of its chunks | (required) |
| `stop()` | Disconnects when the host stops | nothing to stop |
| `agentRooms` | `true` makes the surface host [agent rooms](#agent-rooms-on-any-surface): a conversation with each agent and group of the team, as `<surface>:agent.<name>` and `<surface>:group.<name>` | no rooms; the agent team answers only in Discord |
| `threads` | A `SurfaceThreads` that hosts [dispatch threads](#dispatch-threads-on-any-surface): a background dispatch started in one of the surface's channels opens its thread there, and the thread is the conversation `<surface>:<id>` | the dispatch posts in the channel as before |
| `readAttachment(channel, ref)` | Returns the content of an attachment this surface made, such as an upload to a room, as `Promise<AttachmentContent>`: the bytes, `{ path }` of a file on the host, or a stream, the last two stored without holding them whole; the agent server's claim reads the refs of the surface's messages here and never fetches them over the network, and a rejection fails that file. A claim of your own passes the same function as `read` to `attachmentsOf`, or its refs are downloaded | the refs' URLs are downloaded, up to 25 MB each |
| `maxAttachmentBytes` | The most bytes of one attachment a turn takes from this surface, for a ref, a file, a stream or a download alike; a positive integer, so a surface that keeps large uploads can raise it past 25 MiB. See [files from outside a turn](#contextattachments-files-from-outside-a-turn) | 25 MiB, as Discord's |
| `formatting` | A short English text on how a reply renders here, such as "no Markdown tables"; the runtime appends it to the system prompt of every turn that replies on this surface, after the persona | nothing is appended |
| `startTyping(channel)` | Shows a typing indicator until the returned function is called | none is shown |
| `showStop(channel)` | Shows the owner a stop control until the returned function is called; using it calls `conversations.stop(channel)`. A group's round shows it for the whole round, and stopping ends the round: the member speaking is stopped and the members still waiting do not speak | none is shown |
| `react`, `unreact` | Adds or removes the bot's reaction on a message | no marks on queued or steered messages |
| `prompts(channel, scope?)` | How those the turn's `PromptScope` names approve a held action or answer `ask_user` inside a running turn, as `Prompts`: `confirm` and `ask`, and, where the surface declares `asks`, `questionnaire` ([several questions on one card](#several-questions-on-one-card-questionnaire-and-asksupport)); without a scope, the owners | the action is held until a message approves it |
| `interim(channel, as?)` | Where a running turn posts the text it writes before its final answer, as `InterimPosts`: `post(text)` sends one message of at most 2000 characters and resolves to an `InterimMessage` whose `edit(text)` changes it in place. `tools: false` leaves the tool line out of the progress message, for a surface that shows tool use elsewhere. `as` is a `PostAuthor` (`{ name, agent? }`) when an agent of the team speaks, as `OutboundReply.author` is for the final reply | only the final reply is posted |
| `progress(channel, event)` | Shows a turn run through `context.turns` as it goes, such as a live preview in a web chat. `event` is a `TurnProgress`: `{ type: "text", delta }` (the reply's text, joined over 250 ms and always sent before a tool event, never the thinking), `{ type: "tool_start", id, tool, preview? }` (a one-line preview of the arguments, at most 80 characters, never their full text), or `{ type: "tool_end", id, tool, ok, refused? }` (`refused`, only on a failed end that a hold refused, says how: `declined` on its approval card, `expired` when a card was shown and went unanswered, `pending` while the card stays open, or `held` when no card could be shown (no one may approve it, or it could not be posted); it is absent for a success and for a real failure). The final reply still comes through `sendReply`; a rejection is logged and the turn goes on | only the final reply is shown |
| `groupRound(channel, round)` | Shows where a group room's round stands: a `RoundProgress`, `{ id, state, current?, next, spoken, replies, limit, ended?, queued? }`, with `id` the group message that opened the round, `state` `running` or `ended`, `current` the member speaking, `next` those still to speak in order (a handoff appended), `spoken` those who replied, `ended` (once it ended) `done`, `limit` or `stopped`, and `queued` the owner's messages waiting for the next round. Called when the round is planned, before and after each member's turn, and when it ends; each call carries the whole state. Called for the room keys of a surface that hosts rooms, never for a Discord channel; a rejection is logged and the round goes on | the surface shows no rounds |

#### Agent rooms on any surface

A surface that declares `agentRooms: true` hosts a room for each agent and group of the agent team: `<surface>:agent.<name>` and `<surface>:group.<name>`, built with `agentRoomKey(surface, agent)` and `groupRoomKey(surface, group)` and read with `roomOf(key, roomSurfaces)`, which answers `{ kind, name }` for a key of that exact shape on one of the surfaces and `undefined` for any other, Discord's keys included.
A room is a conversation of its own, apart from the agent's or group's Discord channel, and the same team answers in it: the same agents with the same prompt, model, notes and schedules.
A room has its own session and held actions, so a card or an approving message in the web room does not touch the Discord channel's.
A group's room keeps its own log, `<group>@<surface>`, with the seats `agentgroup:<surface>.group.<group>.<agent>`; the Discord channel's log and seats are untouched.
A schedule an agent sets from a room belongs to the room, and the agent's own `schedule_list`, `schedule_update` and `schedule_cancel` reach it from every other conversation of that agent (its Discord channel and each room, `AGENTS.team.roomsOf(name)`); `schedule_list` says where each one fires. Only the agent's own schedules: another agent's are still read by name with `agent`, never changed.
`message_agent` delivers into the target's most recent conversation, the one it last ran a turn in (kept in the table `agent_latest_conversation`, so a restart keeps it), whether that is its Discord channel or a room. An agent that has run no turn yet is reached on the sender's surface: a room's message stays among the rooms. The optional `conversation` chooses another: `"discord"`, `"web"` (the one surface that hosts rooms, or that surface's name), or one of the conversation keys `agent_get` lists. The answer, and the follow-up turn it wakes, return to the conversation the sender wrote from, wherever the target answered. The sender's conversation shows the exchange as cards, through `sendReply` with `OutboundReply.intercom` (an `IntercomCard`: `kind` `sent`, `answered` or `failed`, the agent the request went to as `peer`, and the whole `text`): the request under the sender's name when it is sent, then the answer, or why none came, under the target's. A surface that shows cards draws a small card that opens to the text; `chunks` carry the card's heading and the text for one that does not. An empty answer posts no card, and no thread is opened.
Starting a room over resets that room's session (or a group room's seats) alone.
Archiving an agent or group clears the schedules and sessions of every key `AGENTS.team.roomsOf(name)` lists: its Discord channel, when it has one, then its room on each surface, and the room stops being owned: `AGENTS.team.owns(room)` is `undefined`, the agent server's claim no longer takes its messages, and a surface should refuse them (the web disables the composer) instead of delivering them to a room nobody answers in.

The team replies in a room through `context.surfaces.sendReply(room, reply)` with `OutboundReply.author` set to a `PostAuthor`, `{ name, agent? }`: the agent's display name and its stable name.
Its interim posts go through `surfaces.interim(room, author)`.
Neither goes through a Discord webhook.
A surface shows the author as it likes; Discord's own surface ignores `author`.
`context.surfaces.roomSurfaces()` lists the surfaces that declare `agentRooms`, once the plugins are linked.

Messages in a room are admitted by the agent server's claim like those in a Discord channel: an owner's message runs a turn, a group's round follows, and `speakers: "owners"` still applies.
The claim reads the attachments of a room's message through the surface's `readAttachment`, so a ref the surface made is never fetched over the network; a surface without it has its refs downloaded from their URLs.
`AGENTS.team.owns(key)` answers for a room too, only while its agent or group is active, and `AGENTS.team.coordinator()` names the coordinator, the agent in the entry channel, or on a host without Discord the one `coordinator` names.

#### Routing: where work no person started lands

An agent has a *place* on each surface that holds one: its Discord channel, and its room `<surface>:agent.<name>` on a surface with `agentRooms`. Its *primary place* is where its unprompted work lands. `AGENTS.routes` (`RoutingTable`) answers, and the configuration's `routing` block sets it; without the block every answer is what the host did before the block existed:

| Call | Answers |
| --- | --- |
| `primary(agent)` | The primary place: the surface the rules name, and with `auto` the agent's Discord channel when it has one, else its room on the first surface that hosts rooms. Undefined for an unknown agent. |
| `placeOn(agent, surface)` | The agent's place on a surface (`web` for the one surface that hosts rooms); undefined when it has none there. |
| `of(agent, "integration", origin)` | Where the report turn of a foreign webhook's post made in `origin` runs; `origin` itself by default, and also when the destination has vanished. |
| `of(agent, "agentMessage", from)` | The conversation a `message_agent` call that names none reaches: by default the agent's latest, never out of a room into Discord. Throws `AgentError` when the agent has no place. |
| `of(agent, "opening", origin?)` | Where an opening task runs: by default the agent's place on the surface `origin` is on, else its primary place; undefined when it has no place at all. |
| `place("ops")` | A named place of the host: the conversation, or the primary place of the agent it names while that agent is active. |

Work a person started, or that waits on a person (a message, a card, a late answer, a schedule's firing place, a message exchange's answer back), is never routed: it stays in the conversation the person sees. A plugin that posts an agent's unprompted work asks the table instead of choosing Discord first.
`SurfacePort.names()` lists every registered surface by name, after link; the agent server uses it to refuse a `routing` key that names one nobody registered, naming the key and the registered surfaces.
`mirror` (a read-only copy of a primary place's posts) and an answerer per surface are defined terms with a position in the block, but they are not built: setting either stops the start.

#### Temp knights: helpers an agent makes for one task

A knight (an agent) can make *temp knights*, helper agents for one self-contained task that can run on its own, and clear them when they are done.
It calls `helper_create { display_name, prompt, task, name?, class?, color?, model?, thinking?, skills? }` once per task and ends its turn; each temp knight starts at once and its answer returns to the knight's conversation as a new turn, as a `message_agent` answer does.
It merges the answers and calls `helper_end { names }`, where `names` is a list of its own temp knights or `"finished"`.
Both tools are on the `member` tier and are offered to every agent that is not itself a temp knight.

A temp knight is a real agent: an ordinary row of the agent table with a nullable `parent` and `finished_at` (the migration `agents-helpers`, additive), its own prompt, picture and sessions, and a name that defaults to `<parent>-<n>`.
Its model and thinking level are its knight's unless the call names others.
It has no group seat, and no agent, group, archive, channel-arrange or schedule tools.
It follows its knight's routing rules, and whether it counts as a long-running conversation follows the conversation that made it.

| Rule | What happens |
|---|---|
| Place | On Discord a temp knight lives in a thread under its knight's channel, whose posts go through the channel's webhook under the temp knight's own name and picture; a knight with no Discord channel gives it a room on a surface that hosts rooms. Archiving a temp knight archives and locks its thread, and restoring it unarchives the thread. |
| Finished | Derived, never set by the knight: nothing runs, nothing is queued, no card waits for the owner and no message from its knight is still unanswered. `Agent.finishedAt` carries the stamp. |
| Limits | `helpers.perParent` (default 4) and `helpers.perHost` (default 12) count active temp knights; depth is one, so a temp knight cannot make one. At a limit the knight's oldest finished temp knight is archived to make room, and the call is refused only when every one of them is busy. |
| Cleanup | `helper_end`, the owner's clearing in a surface, a knight's own archive (which archives its temp knights first), and, after `helpers.archiveFinishedAfterHours` (default 24), an hourly sweep. An archived temp knight keeps its history and comes back with `restoreHelpers`. Deleting an archived knight deletes its temp knights. |

`AgentTeam` offers `helpersOf(parent)`, `finishedHelpers(parents?)`, `archiveHelpers(names, by)`, `restoreHelpers(names)` (only a name that is still an archived temp knight of an active knight is restored) and `onHelpersEnded(listener)`, which hears a knight's own `helper_end` and nothing else, so a surface can offer the owner an undo.
`isHelper(agent)` tells a temp knight, for a surface that lists agents; a group never takes one.
The `helpers` block of the configuration turns the limits and the sweep; `helpers: false` offers neither tool, and a value out of its range, or a `perParent` above `perHost`, stops the start with a `ConfigError`:

```ts
defineRoundtable({
	helpers: { perParent: 4, perHost: 12, archiveFinishedAfterHours: 24 },
});
```

#### Dispatch threads on any surface

A background dispatch (a coding task, a delegated task) gets a thread beside the channel that started it: one start line in the channel, then the dispatch's progress and report inside the thread.
A surface hosts them with `threads`, a `SurfaceThreads`:

| Method | What the surface does |
|---|---|
| `open(parent, name, line)` | Posts the start line in `parent` and opens a thread from it. `line(mention?)` gives the start line's text: call it with no argument for the first post and with the thread's `mention` once the thread exists, so a surface that can edit its post shows the link. Resolves to `{ id, mention }`, or `undefined` when `parent` cannot host a thread, such as a direct message or a thread; rejects when the surface refuses, and no thread is made. The `id` is the surface's own and unique among its threads (the web's are `thread.<uuid>`); `mention` is how text names the thread (`<#id>` on Discord) |
| `post(thread, text)` | Posts text in the thread |
| `send(thread, text)` | Optional. Posts one message of at most 2000 characters and resolves to an `InterimMessage` whose `edit(text)` changes it in place; the dispatch's `DispatchThread` then carries `interim`, so a coding worker's progress edits in place. Without it the thread has none |
| `close(thread)` | Archives the thread, and locks it where the surface allows |

The thread is the conversation `channelKey(surface, id)` (`app:thread.<uuid>` on a surface `app`): its owner cards, held actions and posts through `sendReply` use that key.
`THREADS.open(origin, title, intro?)` picks the surface by the prefix of `origin`, and the thread lives on that surface; a channel whose surface has no `threads`, a channel that cannot host one, a failed creation, and a channel whose claim keeps reports in place (`postsInPlace`, such as an open channel) get none, and the dispatch posts in the channel as before.
The `DispatchThread` it returns has `id`, `channel`, `mention`, `post(text)`, `interim?` and `close(report?)`, which posts the report and archives the thread once.

The host keeps a ledger of the threads still open, `dispatch-threads.json` in the data directory, keyed by each thread's channel key.
Once every service has started after a restart, it closes the threads the last run left open through their surfaces, with a restart notice; a thread whose surface no longer hosts threads stays in the ledger with a warning and is retried at the next start.
A ledger written before 0.23, keyed by Discord thread id, is read as `discord:` threads.

The Discord surface implements `SurfaceThreads` through its current connection, and `DISCORD.threads` is the same instance as `THREADS`, so a plugin that reads either sees no change.
`ThreadHost`, the Discord-only port `DispatchThreads` took before 0.23, is deprecated until 1.0: pass `surfaces` instead of `host` to `new DispatchThreads(...)`.
`fakeThreads()` from `pi-roundtable/testing` is dispatch threads over a fake Discord host.

A surface tells the model how its replies render with `formatting`: a short English text, kept under about 400 characters, which the runtime appends to the system prompt of every turn that replies on the surface, after the persona and everything appended before it, for the channel the turn replies in.
One persona can answer on several surfaces, so the guidance comes from the surface and never from the persona.
A turn whose channel has no surface, and a surface without `formatting`, add nothing.
The built-in values: Discord says that Markdown renders except tables, which show as raw pipes, so the model writes bullet lists or `key: value` lines instead; the `line` surface says it shows plain text only; the web chat says full Markdown renders, tables included.
A host overrides or removes a built-in value through that surface's options (`discord.formatting`, `line({ formatting })`, `webChat({ formatting })`): a text replaces it, and `false` tells the model nothing.
A custom runtime provider reads the same lookup as `RuntimeDeps.formatting(channel)`.

Each message a surface delivers says who wrote it in `actor`, the `ActorFacts` the identity service resolves: `provider` and `subject`, such as `discord` and the user id, `name`, `roles` written `<surface>:role:<name>` (left out where the surface does not know them, such as a Discord DM, which is not the same as none), and `legacyId`, the speaker id 0.8 gave the person, so someone carried over keeps their principal.
A surface that leaves `actor` out has it read from `authorId`, `authorName`, and `authorRoleIds` with its prefix as the provider, and the host warns once that this goes away in 1.0.

The host starts each surface as `surface:<prefix>` at the contributing plugin's place in the order, before that plugin's own services.
It stops surfaces in reverse order, like other services.
The host logs and drops messages whose prefix differs from the delivering surface's, since claims can't identify which surface they belong to.
`context.surfaces` picks the surface by the key's prefix.
Its `sendReply` rejects with a `PluginError` naming the prefix when no surface serves it.
`startTyping`, `showStop`, `react`, and `unreact` do nothing when a channel has no surface or its surface omits those methods.
If `prompts` is unavailable, it returns `undefined` and held actions wait for a message that approves them.
`of(channel)` returns the surface, or `undefined`.
The runtime asks for approvals through `context.surfaces.prompts`, so a surface that gives `prompts` gets them in its own channels.

#### Who answers a prompt: `PromptScope`

The runtime makes each interactive turn's `PromptScope` from its speaker and its conversation: `principalId` and `speakerId` (the speaker's principal and the identity that spoke), `tier`, and `escalate`.
A conversation `context.turns` records as `private` gives `escalate: "none"`; a shared one, and a turn that names no conversation, `"owners"`.
A surface's prompts keep these rules:

- The speaker's principal answers their own question on any of their identities the surface knows, and approves a call when their tier is at least its `minTier` (the owner tier when absent) and, for an owner-tier call, the principal is an owner; a surface that can check their tier again when they answer does.
- Where the scope escalates to the owners, every owner may answer too, and an approval above the speaker's tier is the owners' alone.
- Where it escalates to no one, nobody else answers, and an approval above the speaker's tier resolves `unavailable` at once, shown to no one: the call stays held. (`expired` is for a card that was shown and went unanswered; a surface that cannot tell the two may answer `expired` for both.)
- Anyone else is refused, even at the same tier as the speaker.
- Without a scope, as for a turn with no speaker, the prompts are the owners'.
- An approval that names [approvers](#a-hold-that-names-its-approvers) (`ApprovalOptions.approvers`, which `confirm` receives beside the scope) is theirs **instead of the speaker's**, where the scope escalates to the owners: each named principal answers on any of their identities the surface knows, at the tier it needs, checked again when they answer; the speaker does not answer it unless named, and an owner still does. When none of the named has an identity on the surface, or none is named, it is the owners' alone. Where the scope escalates to no one, the person alone answers, and only when they are named or an owner: for anyone else the approval resolves `unavailable` at once, shown to no one. The runtime also refuses such a call before it asks, whatever the surface does.

- An approval that is the [speaker's alone](#a-hold-that-makes-its-card-the-speakers-alone) (`ApprovalOptions.speakerOnly`) is theirs without the owner escalation, whatever the scope says: the speaker's principal answers on any of their identities the surface knows, at the tier it needs, checked again when they answer, and no owner does. Without a scope, or when the speaker is below the tier or has no identity on the surface, it resolves `unavailable` at once, shown to no one.

On Discord a card for named approvers mentions every Discord identity of every named principal that has one, in a thread, and refuses anyone else with a line that says it is for the people it names and the owners.
The web chat shows prompts to the conversation's person only. The runtime never asks it about a call that names approvers the person is neither among nor an owner of, and the person is the approver of one that names them.

On Discord the owners are every owner with a Discord identity, and the primary owner always; a card in a thread mentions the identity that spoke when it is theirs and one of the principal's Discord identities, every Discord identity of the principal when the speaker is none of them, and the owners when it goes to them, so a single owner's cards read as they did in 0.8.
A principal with no Discord identity, such as the reporter of a background report, answers nothing there, so their card goes to the owners; so does an owner-tier call of a turn whose tier defaulted to owner when its principal is not an owner.
The web chat shows prompts to the conversation's person only: its owners are not on it, so an approval above that person's tier comes back `unavailable` at once whatever the scope says.

#### An approval as data: `ApprovalDetails`

`confirm(title, message, signal?, minTier?, wait?, details?, options?)` takes the approval twice: `message` is the card as markdown text, and the optional `details` (`ApprovalDetails`: `{ action, tool, input, files? }`) is the same held call as data, with its whole input (the web chat cuts it only past 256 KiB and says so with `truncated`), and each file it sends by path as `{ path, bytes? }`.
The confirmation gate and a coding worker's cards pass both.
`options` (`ApprovalOptions`) says who else may approve the call and hears who did: `approvers`, the principal ids that approve it instead of the speaker (see [who answers a prompt](#who-answers-a-prompt-promptscope)), `speakerOnly`, true when the card is the speaker's alone and no owner may answer it (see [a hold that makes its card the speaker's alone](#a-hold-that-makes-its-card-the-speakers-alone); a surface that cannot honour it resolves `unavailable` instead of showing the card to the owners), and `approvedBy(by)`, which a surface that knows who answered calls with `{ principalId, speakerId, name, owner? }` (`ApprovedBy`; `owner` when they approved as an owner) before `confirm` resolves `approved`. `approvedPrompt(prompt)` is called, likewise before `confirm` resolves `approved`, with the id of the card that approved the call, for `ToolTurn.approvedPrompt`; a surface whose cards have no stable id leaves it uncalled. A surface may ignore all three for a call that names no approvers. For one that does, the runtime accepts the approval only from a surface that calls `approvedBy` with a named principal or an `owner`, so a surface that cannot say who answered must not offer such a call to a shared conversation.
A surface that shows text, such as Discord, uses `message` and reads only `details.copy` (below); the web chat sends `details` to the client as the prompt frame's `approval`, beside the unchanged `title` and `message`.
A surface or a `Prompts` of your own may ignore it: nothing requires reading it.

`details.copy` (`{ label?, text }`) is a text the approval offers to copy, such as a command or a message the call would send; whoever builds `details` for a `confirm` of their own sets it.
It is informational and never an answer: using it does not approve, decline or otherwise settle the prompt, and a surface that cannot show it ignores it, as the web chat's own client does (the frame carries it as `approval.copy`, left out when it would not fit beside the call's `input` in the frame's 256 KiB: the input is never cut for it).
On Discord the card gets a third button (`label`, default "Copy", or its Traditional Chinese equivalent on a host in that language) that any member who can see the card may press, any number of times, also after the card has ended; it replies ephemerally with the text in a code block, or as a `copy.txt` file when the text does not fit a message (2,000 characters) or holds a code fence. The button's custom id holds the card's id, never the text: the text is kept under that id in `card-copies.json` in the host's `dataDir`, in plain text and readable by the host's user only, so the button works after a restart even though the card itself no longer answers; a card whose text is gone says so. `discord.cardCopies` (`{ keepDays?, keep? }`, default the newest 100 cards for 30 days) sets how long and how many; `false` keeps the texts in memory only, with the same limits, so they are gone at a restart. The file is written in the background, one write at a time, so a card is not held up by it. A text past `keepDays` leaves the file too, not only memory: when the host starts or a button finds one expired, and on an hourly sweep that does not keep the process alive. The attachments' `retention` and discarding a conversation do not remove the texts: they age out, or set `cardCopies` to `false` on a host that wants none on disk: the host then deletes an existing `card-copies.json` when it starts. A text over 20,000 characters gets no button, and a warning is logged.
Because anyone who can see the card can copy the text, it holds nothing they may not read.
`confirm` resolves `approved`, `declined`, `expired` (a card was shown and went unanswered), `unavailable` (no card could be shown: no one may approve the call, the speaker is below its tier, or the card could not be posted), `cancelled` (the turn stopped, or the plugin that held the call withdrew it through `ApprovalOptions.supersede`), or `pending` (with a `wait`). Both `expired` and `unavailable` leave the call held for the owner's next message; the turn's progress reports them as `refused: "expired"` and `refused: "held"`.

#### A prompt that outlives its turn: `PromptWait`

`confirm(title, message, signal?, minTier?, wait?)` and `ask(title, question, signal?, wait?)` take an optional `PromptWait`, whose `late(answer)` hears a `LateAnswer` (`{ kind: "approval", approved, by, approvedBy?, prompt? }`, `approvedBy` naming the approver where the surface knows them and `prompt` the id of the card that was answered, `{ kind: "question", answer, by }`, or `{ kind: "questionnaire", answer: QuestionnaireAnswer, by }`, `by` naming who answered; only a `questionnaire` call can produce the last) and returns the text of the turn that tells the conversation, or undefined for none.
Given one, a surface may stop the turn's wait after a grace period: `confirm` then resolves `pending` and `ask` resolves `"pending"`, the prompt stays open, and when it is answered later the surface starts a turn in the prompt's conversation with that text, as a message from whoever answered, so the conversation's claim answers it as theirs.
Without one, a prompt waits for its answer, or for its turn's stop; a surface that cannot start a turn ignores `wait` and waits too.
A stop cancels a prompt only while its turn still waits on it; after that the prompt belongs to the conversation.

The runtime gives both of its prompts a `wait`.
`ask_user` then tells the model the person has not answered yet and to end its turn saying it is waiting, without asking again, and the late answer's turn carries the question and the answer.
A held action's call is blocked as awaiting the approval, and is not held for a later message; a late approval lets that exact call (same tool, same canonical input) run once, and its turn tells the model to make it now and report the result, so the call runs under the gate and tier rules every call does. The release is the approval of one call, so it is spent only by that call: in a turn whose speaker is the person who approved on the card (or an owner; a surface that does not say who approved leaves it to any speaker), and only when that person's message started the turn (`TurnRequest.byMessage`, set by the core's message paths: an owner's message in an agent channel, a group round, a web chat or remote MCP message). A schedule's, agent-message (follow-ups included), report, webhook or error-report turn never spends it, whoever its speaker is and whatever their tier, and the system principal never does; they show the card again, within an hour of the answer (`LATE_RELEASE_TTL_MS`), and not after the identical call has run without a hold, which is the run the person approved, so it is dropped then. A release nobody spends in that time is gone, and the same call is held again for a card; a late refusal starts a turn that says so.
A coding worker's cards give no `wait`, since nothing could resume a worker: it waits for the answer, and the waiting does not count against its time.

On Discord the grace period is `discord.cardGraceSeconds` (default 120), and the cards carry no countdown.
A card answered late is edited to show the answer with its controls disabled, as one answered in time is; a second press finds it answered.
Every question card, single or several questions, has a **Cancel** button beside its answer controls, for the same audience as the answers. Pressed while the turn still waits, `ask` and `questionnaire` resolve `"declined"`, and `ask_user` tells the model the person cancelled the question without answering, not to ask it again, and to go on without the answer or end its turn if it cannot. Pressed after the turn stopped waiting, it only closes the card: no turn starts and nothing stays pending. Either way the card shows "❌ Cancelled, not answered." with its controls disabled, and a second press finds it ended.
Open cards live in memory: after a restart, pressing one replies, to the presser alone, that it is no longer valid and to ask again.

#### Several questions on one card: `questionnaire` and `AskSupport`

`ask_user` takes one to four questions in one call (`questions`; a whitespace-only question is refused), each with an optional short `header`, options with an optional `description` and markdown `preview`, `multi`, and `allow_other` (true by default in this form, so every question takes a written answer too), and the person may add a note on the whole set. The older single-question arguments (`question`, `options`, `multi`, `allow_other`) still work and read as one question with `allow_other` false; double-encoded `questions` and `options` values are decoded. A call that breaks `QUESTIONNAIRE_LIMITS` (the table of every limit: four questions, a header of 30 characters, 25 options, 100 characters for a label or description, 1,500 characters for a lone question and 3,000 for the questions and headers of a set, 1,200 characters per preview and 10,000 in all, 1,000 for an answer of their own or the note) is refused to the model with the reason and posts no card. `validateQuestionnaire` gives the reason. Since 0.20 the same option label twice in a question, or the same question twice in a call, is refused for every call; 0.19 accepted both.

A surface says what it can show with `Prompts.asks` (`AskSupport`: `{ questions, previews, note }`) and, when it declares it, implements `Prompts.questionnaire(title, questionnaire, signal?, wait?)`, which resolves with a `QuestionnaireAnswer` (`answers`, one per question in order and `undefined` for one left blank, and `note`), `"pending"`, or `undefined` as `ask` does. Both members are optional: a `Prompts` without them is the 0.19 contract (`SINGLE_QUESTION`: one question, no previews, no note) and keeps working unchanged. The runtime gives `questionnaire` a set already shaped for `asks` (`shapeFor`), so a surface renders only what it declared:

| The surface lacks | What the core does |
|---|---|
| room for the questions (`asks.questions`, or no `asks` at all) | asks them one at a time through `ask` and stops at the first one that does not come back answered; the model is told which were not asked |
| `previews` | appends each preview to its question as `**label**` and a fenced block (a longer fence when the preview holds one), cut to the question limit with `…` |
| a `header` (a surface that takes one question) | drops it; the tool description already asks that each question read on its own |
| `note` | shows no note control, and the answer carries no `note` |

One question without previews always goes through `ask` and returns the same text as 0.19. `checkAnswer` and `checkQuestionnaireAnswer` check that an answer is one the questions allow (offered labels only, one unless `multi`, text of their own only where `allowOther`); a surface that takes answers from a network uses them rather than its own rules. `describeSurfaceContract` runs the questionnaire checks (answered, blank question kept blank, closed on stop, a stranger's answer ignored) for a subject that gives `answerQuestionnaire(prompt, answer, questionnaire)`; a subject that gives it must declare `asks`, and the contract fails it otherwise.

On Discord the whole set is one card (`asks` is four questions, previews and a note): a menu per question with its options (an option can be cleared again, and the menus show the draft), `Submit`, a button that opens one form with a field per question that takes written text plus the note, and, when an option has a preview, a `Previews` button that replies ephemerally to whoever presses it and answers nothing. A short footer outside the container says how many questions are answered. The draft is one per card, shared by everyone who may answer and visible to everyone who sees the card; the last write wins and the submitter is reported. Presses are checked against the same audience as any question each time (menus, form and Submit). `Submit` needs at least one answer or the note, and a partial answer is allowed. Every limit Discord enforces is counted in UTF-16 units, so an emoji weighs two: the core's refusal of an over-long set counts them too. With a `wait`, each draft edit restarts the grace period, and a `Submit` after the turn stopped waiting starts the late turn with a `questionnaire` `LateAnswer`. A single question keeps its 0.19 card (a menu answers at once; "Other…" opens the form, or, with 25 options plus `allow_other`, an `Answer…` button does), with a `Previews` button when an option has a preview. Open cards live in memory, as before.

On the web chat the support is the least of the person's connections that declared theirs (`prompt_features`), so the assistant only sends a set a tab can show, and a person whose tabs all lack it is asked one question at a time. A questionnaire that no connection can show expires after 60 seconds: it settles unanswered, the model is told, and if it asks again it gets the one-at-a-time fallback. See the web chat package's README for the frames.

#### Interim text: what a turn writes before its final answer

A model often writes text in an assistant message that then calls tools, such as a proposal before it asks `ask_user` "go with this version?".
On a surface that gives `interim`, and in the agent server's channels through the agents' webhooks, the host posts that text as the turn goes, sorted in two:

- **Primary** text is posted as ordinary messages as soon as its assistant message ends: text of 400 characters or more, or written with a Markdown heading, list, table or code fence.
- **Secondary** text, short narration between tool calls, goes to one progress message per run of tool-calling messages, in Discord's small text (`-# ` per line): each text as a line, then the tools called in the run, such as `-# bash ×3 · read · web_search` (names only). It is edited in place at most every 1.5 seconds, its last state always lands, and it stays inside 2000 characters by dropping its oldest lines behind `-# …`. A primary post or a card starts a new progress message. Posts that set `InterimPosts.tools` to `false`, as the web app's rooms do because their progress pane shows the tools, get the narration without the tool line, and a run that wrote no narration posts nothing; Discord keeps the line.

Before any card, an `ask_user` question or an approval, the host posts the pending text and brings the progress message up to date, so what the model wrote before the card shows above it.
The final reply is posted at the end as before, with its thinking line; an intermediate message is never the final one, so nothing is posted twice, and a steered run keeps its final text.
A failed interim post or edit is logged and never fails the turn.
Turns with nowhere to post, such as transient tasks and turns of a claim that passes its own `reply` to `context.turns.run`, post only their final reply.
A coding worker posts the same way into its dispatch thread, under the name its report uses, when the thread's surface can edit its posts (`SurfaceThreads.send`, which the Discord surface has; a `DispatchThread` then carries `interim`): its approval cards come after the text it wrote before them, and its report is posted once, at the end.
A runtime that fills [the `runtime` slot](#the-runtime-slot-replace-pi) receives the place to post as `TurnRequest.interim` and may use it or not.

The config's `interimText: "off"` posts only the final reply (default `"on"`), and `interimPrimaryChars` sets the length of primary text (default 400).

The Discord plugin collects [slash commands](#slash-commands-commandsadd); the host doesn't compose them or pass them to surfaces on other networks.

This in-memory chat surface records everything the host asks of it.
Its plugin adds a claim that answers through `context.surfaces`:

<!-- example: examples/fake-surface.ts -->
```ts
import {
	type Approval,
	type ApprovedBy,
	type ChannelKey,
	type ChatSurface,
	definePlugin,
	type InboundMessage,
	type OutboundReply,
	type PromptScope,
	type Prompts,
	parseChannelKey,
	TIERS,
	type Tier,
} from "pi-roundtable";

/** A prompt the surface showed, open until someone it is for answers it. */
interface Asked {
	id: string;
	channel: ChannelKey;
	title: string;
	open: boolean;
}

/** Who may answer an open prompt and what happens when they do. */
interface Answering {
	/** The principals who may answer it: the speaker, or the approvers the call named. */
	principals: readonly string[];
	owners: boolean;
	/** The lowest tier an answer needs, when the principals are the approvers'. */
	minTier?: Tier;
	/** Hears who approved it. */
	approved?(by: ApprovedBy): void;
	settle(answer: Approval): void;
}

/**
 * A chat surface connects the host to one chat network. This one is an in-memory chat: its
 * channels are the keys that start with `fake:`, and it records what the host asks of it. A real
 * surface talks to its network in `start` and `sendReply`, and skips the optional methods it
 * cannot do.
 */
export class FakeSurface implements ChatSurface {
	readonly surface = "fake";
	readonly replies: { channel: ChannelKey; reply: OutboundReply }[] = [];
	readonly typing: string[] = [];
	readonly stops: string[] = [];
	readonly asked: Asked[] = [];
	/** Who may answer each open prompt, and how it settles. */
	readonly #answering = new Map<string, Answering>();
	#deliver: ((message: InboundMessage) => void) | undefined;

	/** The host hands over its router; every message the network reports goes to it. */
	async start(deliver: (message: InboundMessage) => void): Promise<void> {
		this.#deliver = deliver;
	}

	async stop(): Promise<void> {
		this.#deliver = undefined;
	}

	/** Someone writes in a channel. */
	say(channel: ChannelKey, text: string): void {
		this.#deliver?.({
			channel,
			messageId: `m${this.replies.length}`,
			authorId: "1",
			authorName: "Ada",
			authorIsBot: false,
			isDirect: true,
			mentionsBot: false,
			repliesToBot: false,
			text,
			attachments: [],
		});
	}

	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		this.replies.push({ channel, reply });
	}

	startTyping(channel: ChannelKey): () => void {
		this.typing.push(`start ${channel}`);
		return () => void this.typing.push(`stop ${channel}`);
	}

	showStop(channel: ChannelKey): () => void {
		this.stops.push(`show ${channel}`);
		return () => void this.stops.push(`hide ${channel}`);
	}

	/**
	 * How a turn asks to approve a held action or answers a question. The scope names who may
	 * answer: its speaker when their tier holds the call, and the owners unless the conversation
	 * is private, where a call above the speaker's tier goes to no one and comes back `unavailable` at once.
	 * Where the call names approvers and the conversation is shared, they answer it instead of the
	 * speaker, at the tier it needs. A private conversation's person alone answers it, and only if
	 * named or an owner; for any other the call comes back `unavailable` at once.
	 */
	prompts(channel: ChannelKey, scope?: PromptScope): Prompts {
		return {
			confirm: async (
				title,
				_message,
				signal,
				minTier = "owner",
				_wait,
				_details,
				options,
			) => {
				const owners = scope?.escalate !== "none";
				const named = options?.approvers;
				// Alone with the bot, the person answers for themselves, if the call is theirs to approve:
				// they are named, or an owner.
				if (
					named &&
					!owners &&
					scope?.tier !== "owner" &&
					!named.includes(scope?.principalId ?? "")
				)
					return "unavailable";
				const shared = owners ? named : undefined;
				const theirs =
					scope !== undefined &&
					TIERS.indexOf(scope.tier) >= TIERS.indexOf(minTier);
				const principals = shared ?? (theirs ? [scope.principalId] : []);
				if (principals.length === 0 && !owners) return "unavailable";
				return this.#ask(channel, title, [signal, options?.supersede], {
					principals,
					owners,
					...(shared ? { minTier } : {}),
					...(options?.approvedBy ? { approved: options.approvedBy } : {}),
				});
			},
			ask: async () => undefined,
		};
	}

	/**
	 * Someone answers an open prompt; it settles only when it is theirs to answer. `name` and
	 * `speakerId` say who they are to a call that asks who approved it.
	 */
	answer(
		id: string,
		who: {
			principalId: string;
			owner?: boolean;
			tier?: Tier;
			name?: string;
			speakerId?: string;
		},
		approved: boolean,
	): void {
		const open = this.#answering.get(id);
		if (!open) return;
		// An answer that does not say its tier is not accepted where a tier is needed.
		const tierOk =
			!open.minTier ||
			(who.tier !== undefined &&
				TIERS.indexOf(who.tier) >= TIERS.indexOf(open.minTier));
		const theirs = open.principals.includes(who.principalId) && tierOk;
		if (!theirs && !(who.owner && open.owners)) return;
		if (approved)
			open.approved?.({
				principalId: who.principalId,
				speakerId: who.speakerId ?? who.principalId,
				name: who.name ?? who.principalId,
				...(who.owner ? { owner: true as const } : {}),
			});
		open.settle(approved ? "approved" : "declined");
	}

	#ask(
		channel: ChannelKey,
		title: string,
		// The turn's stop and the plugin's withdrawal of the call both close the prompt as cancelled.
		closers: (AbortSignal | undefined)[],
		audience: Omit<Answering, "settle">,
	): Promise<Approval> {
		if (closers.some((closer) => closer?.aborted))
			return Promise.resolve("cancelled");
		const asked = {
			id: `q${this.asked.length + 1}`,
			channel,
			title,
			open: true,
		};
		this.asked.push(asked);
		return new Promise((resolve) => {
			const settle = (answer: Approval) => {
				this.#answering.delete(asked.id);
				asked.open = false;
				resolve(answer);
			};
			this.#answering.set(asked.id, { ...audience, settle });
			for (const closer of closers)
				closer?.addEventListener("abort", () => settle("cancelled"), {
					once: true,
				});
		});
	}
}

/**
 * The plugin contributes the surface, and a claim that owns the channels of its prefix and
 * answers through `context.surfaces`, which picks the surface by the prefix of the channel's key.
 */
export function fakeChat(surface: FakeSurface) {
	return definePlugin({
		name: "fake-chat",
		setup: ({ surfaces }) => ({
			surfaces: [surface],
			channels: [
				{
					name: "fake-channels",
					priority: 10,
					owns: (channel) => parseChannelKey(channel).surface === "fake",
					admit: (message) => ({
						kind: "turn",
						run: async () => {
							const stopTyping = surfaces.startTyping(message.channel);
							try {
								await surfaces.sendReply(message.channel, {
									chunks: [`echo: ${message.text}`],
								});
							} finally {
								stopTyping();
							}
						},
						failure: "a fake chat turn failed",
					}),
					startFresh: async () => "The fake chat has nothing to start over.",
				},
			],
		}),
	});
}
```
<!-- /example -->

A test boots a host with the plugin, writes through the surface, and reads what came out (`examples/fake-surface.test.ts` does this with `Roundtable` and `silentLogger`, and also covers the refusals above).

### `adapters`: the chat networks the host talks through

`adapters` lists the chat networks the host talks through, each made by its adapter's factory.
Today the one adapter is Discord: `discord()` from `pi-roundtable/discord` takes the same settings as the top-level `discord`, and a host configured either way assembles the same plugins in the same order.
The top-level `discord` stays the form `roundtable init` writes; configure Discord once, in one place or the other.
A chat network that comes as a plugin, such as pi-roundtable-webchat's `webChat()`, stays in `plugins`.

<!-- example: examples/discord-adapter.ts -->
```ts
import type { RoundtableConfig } from "pi-roundtable";
import { discord } from "pi-roundtable/discord";

/**
 * Discord as an adapter: `discord()` takes the same settings as the top-level `discord`, and the
 * host assembles the same plugins in the same order. Configure Discord in one place, not both.
 */
export function withDiscordAdapter(
	env: (name: string) => string,
	dataDir: string,
): RoundtableConfig {
	return {
		access: {
			owners: [
				{
					name: env("OWNER_NAME"),
					principal: env("OWNER_ID"),
					identities: [`discord:${env("OWNER_ID")}`],
				},
			],
		},
		adapters: [
			discord({
				token: env("DISCORD_TOKEN"),
				guild: env("DISCORD_GUILD_ID"),
				entryChannel: env("DISCORD_ENTRY_CHANNEL_ID"),
			}),
		],
		database: { url: env("DATABASE_URL") },
		dataDir,
		model: env("MODEL"),
		http: { publicUrl: env("PUBLIC_URL") },
	};
}
```
<!-- /example -->

`examples/discord-adapter.test.ts` checks that both forms assemble the same plugins.
`roundtable doctor` reads a Discord adapter's settings as it reads the top-level `discord`.
The types are `AdapterConfig` and `DiscordConfig` from `pi-roundtable`, and `DiscordAdapterConfig` from `pi-roundtable/discord`.

### A host without Discord

Leave `discord` out of `roundtable.config.ts` and the host runs without it: no Discord plugin, and no tool that needs Discord. With no `agents` there is no agent server, no agent and no skills either; with `agents`, [the team runs without Discord](#an-agent-team-without-discord).
The runtime plugin still builds the runtime, so every claim that runs turns through `context.turns` works, over the surfaces your plugins bring.
`http` is optional too; without it the host opens no listener, and a route then names a listener that is not configured.

What needs Discord is refused or left out rather than failing later:

- `ops.agent` is a configuration error, and so are `skills` (anything but `false`) without `agents`, and an agent seed's `channelId`. `ops: { conversation: "<surface>:<id>" }` needs a chat surface that serves it and a claim that owns it and takes background turns, or the host does not start. Webchat declares `takesSystemReports: false` and takes no system error reports.
- `notify` is not registered unless a plugin contributes a [direct channel](#directchannels-reaching-a-person-on-their-own), since there is nowhere to send a notice.
- `schedule_*` and `delegate_task` are registered only in a conversation whose claim takes background turns: their runs are turns of the [background target](#backgroundtargets-whose-turn-a-schedule-or-delegated-task-is) `PERSONAL_TARGET`, named `owner`, which the core contributes on every host. A conversation of a claim without `background` has neither; a no-surface conversation needs a registered private principal known to a direct channel, as [background targets](#backgroundtargets-whose-turn-a-schedule-or-delegated-task-is) describes.
- `roundtable doctor` skips the Discord checks.

Pi's runtime still needs the `compact_session` tool in every session, from the Pi package pi-self-compact: load it from a plugin with `piPackages: ["pi-self-compact"]`, as the `plugins/self-compact.ts` of a project `roundtable init` creates does, or the preflight stops the start and says so.
`roundtable init --adapter web` creates a host without Discord around the [web chat](#web-chat-pi-roundtable-webchat).
A host that keeps Discord may write it as an adapter instead, as [`adapters`](#adapters-the-chat-networks-the-host-talks-through) describes.

#### An agent team without Discord

`agents` and `skills` work without `discord`. The host then assembles the agent server and the skills addon whenever `agents` is not empty: the same team, with the same prompts, models, notes, schedules and skills, whose agents and groups have no Discord channel and are reached only through [rooms](#agent-rooms-on-any-surface) of a surface that declares `agentRooms: true`, such as `pi-roundtable-web`.

- `coordinator` names the agent that coordinates the team; it must be one of `agents` and defaults to the first. With `discord` the agent in `discord.entryChannel` is the coordinator, and `coordinator` is a `ConfigError`. The coordinator cannot be archived. `AGENTS.team.coordinator()` answers with either.
- The team's id is `LOCAL_TEAM_ID`, `"local"`, where Discord's is the guild's id; the rows are stored under it as under the guild's, and `AGENTS.team.guildId` is it.
- The start fails, naming the fix ("agents need a surface that hosts their rooms, such as pi-roundtable-web"), when no installed surface declares `agentRooms`: without Discord channels the agents could never be spoken to. The check runs when the plugins are linked, so a surface added by any plugin counts.
- No channel is made, checked or arranged, and the dashboard (a Discord message) does not exist. `channel_arrange` and `channel_read` answer that the host has no Discord channels. `agent_create` and `group_create` make no channel, and a new agent starts its opening task in its room on the first surface that hosts rooms. Archiving an agent or group stops its rooms from answering.
- An agent's pictures have no public address unless `http.publicUrl` is set: `AGENTS.avatars.url(hash)` is then the path `/avatars/<hash>.png`, which the surface serves itself through `AGENTS.avatars.serve(pathname)` under its own origin, as the web console does. With `http.publicUrl` they are served on the `public` listener as with Discord.
- `AgentTeam.channelOf(name, near?)` answers with the agent's room on the surface of `near` (the asker's own conversation) when that surface hosts rooms, so `schedule_list` from a room reads the room's schedules; for an agent with no Discord channel it falls back to its room on the first surface that hosts rooms. The status the dashboard and the web read counts an agent's schedules, waiting turns and context use across its Discord channel and its rooms.
- A surface that lets the owner edit the team uses the same operations the agent tools do, from outside any agent turn: `AgentTeam.createAgent(speaker, input)` (the fields of `agent_create`, plus `model` and `thinking`, which are checked before anything is made; without a `task` the agent only exists, and `openIn` names the surface whose room runs the opening task instead of the Discord channel), `archive(undefined, name)` (an owner has no calling agent, so only the coordinator is protected), `restore(name)`, `remove(name, cleanup?)` (an archived agent or group only, and never an agent the host's seeds name, which the next start would seed again; it runs `cleanup`, your surface's part of the delete, after its checks and before deleting anything, so a cleanup that throws leaves the target in place to try again; then it frees the name, detaches the agent's skills, clears its group cursors and makes the runtime forget the conversations the name kept, and leaves a Discord channel under Archive), and `createGroup` and `updateGroup`. All of them throw `AgentError` with the reason, and fire the team's change signal.
- Breaking: `AgentGroup.channelId` is optional (`string | undefined`), and so is `GroupStatus.channelId`; a plugin that reads them handles a group without a Discord channel. The `agent_groups.channel_id` column drops its `NOT NULL` in a migration of the agent server (`agent-groups-channel-optional`), and `AgentServerOptions.guildId` and `entryChannelId` are optional, with `coordinator` added. `AvatarStudioOptions.publicUrl` is optional.

<!-- example: examples/headless.ts -->
```ts
import { definePlugin, type RoundtableConfig } from "pi-roundtable";
import type { FakeSurface } from "./fake-surface.ts";
import { studyRoom } from "./study-room.ts";

/** A plugin that brings a chat network and nothing else; the study room's claim answers its rooms. */
export function chatNetwork(surface: FakeSurface) {
	return definePlugin({
		name: "chat-network",
		setup: () => ({ surfaces: [surface] }),
	});
}

/**
 * A host without Discord: no `discord` key, so no Discord plugin, no agent server, no agents and
 * no skills; and no `http`, so no listener opens until a plugin needs one. Conversations come
 * through the plugins' own chat surfaces, and `context.turns` runs them on the host's runtime,
 * Pi's unless a plugin fills the `runtime` slot.
 */
export function studyHall(
	surface: FakeSurface,
	where: { databaseUrl: string; dataDir: string },
): RoundtableConfig {
	return {
		name: "Study Hall",
		access: {
			owners: [{ principal: "owner", name: "Ada" }],
			// Admit the fake surface's authors explicitly, not in the claim.
			members: { everyone: ["fake"] },
		},
		database: { url: where.databaseUrl },
		dataDir: where.dataDir,
		model: "anthropic/claude-sonnet-5-5",
		plugins: [chatNetwork(surface), studyRoom],
	};
}
```
<!-- /example -->

`examples/headless.test.ts` boots this configuration over PostgreSQL with the echo runtime in place of Pi, and a study room answers through the fake surface.
`testHost({ discord: false })` boots the same kind of host for a plugin's tests.

### Web chat: pi-roundtable-webchat

[pi-roundtable-webchat][webchat-package] is a chat network that comes as a plugin.
`webChat({ verifier, personas, origins })` adds a chat surface whose conversations have keys `web:<conversation>`, the claim that runs each message as a turn of its conversation's persona through `context.turns`, and a REST API and a WebSocket under `/chat` on the host's `public` listener.
People an OpenID Connect provider signs in open private conversations, see each turn's text and tools as it runs, and answer its approval cards.
It needs no Discord: a host whose configuration has no `discord` and lists `webChat(...)` in `plugins` is a web-only assistant.

#### `roundtable init --adapter web`

`roundtable init --adapter web` writes a project without Discord around it: no `agents.ts` and no shared persona, a `roundtable.config.ts` that lists `webChat(...)` with an `oidcJwtVerifier`, an access map whose members and admins come from the token's roles, in top-level `access`, and one persona, `assistant`, whose prompt is `persona/assistant.md`.
The persona's `selection` names its tools (the hello plugin's), so tools a later plugin adds, such as pi-web-access's, stay out until you add them by name.
`package.json` pins pi-roundtable-webchat at the core's version and pi-self-compact, and `.env.example` asks for `OWNER_NAME`, `DATABASE_URL`, `MODEL`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`, `CHAT_MEMBER_ROLES`, and `CHAT_ORIGINS`, with no Discord variable.
The host listens on `127.0.0.1:3000`; serve it over HTTPS through a reverse proxy.
`--adapter discord` is the default and writes the Discord project.

#### Protocol

A browser asks for a one-time ticket with `POST /chat/tickets` and `Authorization: Bearer <token>`, then opens `/chat/socket` offering the subprotocols `roundtable.webchat.v1` and `ticket.<ticket>`; another client sends the bearer token on the upgrade.
The token never travels in a URL.
Each WebSocket message is one JSON object with a `type`: the client sends `auth`, `send`, `stop`, `approval`, `answer`, `answers`, `prompt_features`, `client_hello`, and `client_result`; the server answers with `ready`, `accepted`, `typing`, `stoppable`, `progress`, `reply`, `failed`, `prompt`, `prompt_closed`, `notice`, `reauth`, `client_call`, `client_cancel`, and `error`. The [package README](https://github.com/wayne930242/pi-roundtable/blob/master/packages/webchat/README.md) lists each frame with its fields.
`progress` carries the turn's [`TurnProgress`](#surfaces-a-chat-network-of-your-own) events, never the thinking and never a tool's full arguments; `reply` carries the answer in full markdown.
The REST API lists a person's conversations, opens one, reads its messages, and lists and acknowledges private inbox notices from `notify`.
Tickets, quotas, connections, and approvals follow `principalId`; refreshing a token to another principal closes the socket with 4403.
The package README documents every frame, error code, close code, and limit.

#### Security model

- A conversation belongs to the person who opened it: the claim checks the [conversation registry](#services-what-plugins-provide-to-each-other) inside the conversation's queue before every turn, and only that person may list, read, write in, stop, or answer it.
- Tokens are checked on every REST call, every upgrade, and every `auth` frame. By default only a person's access token passes: a token without a scope or app roles, or an app-only token, is refused. A socket closes when its token expires.
- `origins` is required, and checked on every upgrade and every browser request.
- Each person has bounded sockets, tickets, conversations opened per hour, and turns running or queued at once; frames are bounded in size and rate.
- An approval card goes to the conversation's person only, at the tier the held call needs.
- No token claim makes anyone the owner; list their linked identity in top-level `access.owners` or grant a lasting role through the CLI.
- The old webchat `access` option is removed; prefix roles as `<surface>:role:<name>` and scope old `everyone: true` to `everyone: ["<surface>"]`.

#### Provider settings

The verifier is generic; what makes it safe is how it is pointed at your provider.
The README's [provider settings][webchat-provider-settings] explain, with Microsoft Entra ID as the example, why to name people by a claim that stays the same across app registrations (`subjectClaim`), pin the tenant in `check`, accept access tokens only, refuse app-only tokens, merge issuers of one tenant only (`speakerIssuer`), and mind the guests `everyone` admits.

The web chat takes files people upload to their conversation and then name in a message (see the README's [attachments][webchat-attachments]), built on [`context.attachments`](#contextattachments-files-from-outside-a-turn).
It takes no system error reports (`takesSystemReports: false`), so `ops.conversation` cannot name it.
It accepts `PERSONAL_TARGET` background turns only for the private conversation's principal; include `schedule_*`, `delegate_task`, and `notify` in a persona's selection only deliberately, adjusting their tiers if needed.
Leave out `web_search` and `fetch_content` unless people may make the host fetch any address, internal ones included.

[webchat-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/webchat/README.md
[webchat-provider-settings]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/webchat/README.md#provider-settings
[webchat-attachments]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/webchat/README.md#attachments

### The owner app: pi-roundtable-web

[pi-roundtable-web][web-package] is the owner's web app, and the reference surface for [agent rooms](#agent-rooms-on-any-surface).
`webConsole(options)` adds a chat surface (prefix `app` unless `surface` says otherwise), a page, a WebSocket and a REST API under `/console` on the host's `public` listener, an installable manifest and service worker, and Web Push.
It needs no Discord: with `agents` in the configuration and no `discord`, the team lives in the app's rooms (see [an agent team without Discord](#an-agent-team-without-discord)), and Home is the coordinator's room.
Its README documents the app, every option, the protocol and the threat model; this section says which seams of the core it stands on, for a plugin that wants the same from another network.
The page is in English, and `presentation: { locale: "zh-TW" }` switches it to the package's built-in Traditional Chinese (Taiwan) wording; `presentation.messages` words individual keys over it, and any other locale is worded entirely by the host.

| The app uses | For |
|---|---|
| `ChatSurface.agentRooms`, `agentRoomKey`, `groupRoomKey`, `OutboundReply.author`, `surfaces.interim(room, author)` | A room for each agent and group, with replies and live text shown under the agent's own name |
| `ChatSurface.prompts` (its owner desk), `PromptScope`, `PromptWait`, `ApprovalOptions.purpose` | Approval, question, questionnaire and time-limit cards in the room, visible to every open page of every owner; a card the turn stopped waiting on stays open for a day and a late answer starts a turn |
| `ChatSurface.threads` | Dispatch threads as read-only rooms nested under the room that started them |
| `ChatSurface.readAttachment`, `maxAttachmentBytes`, `AttachmentContent` | Uploads of any kind up to `uploadMaxBytes`, handed to the agent as a stored file's path, never held whole in memory |
| `MODES`, `autonomy`, `ApprovedBy.auto`, `MODES.onAutoApproved` | The yolo and long-running switches of a room, and the line in the room for each call yolo approved |
| `DirectChannelProvider` with `mirror` | A notice to the owner lands in Home and is pushed to their devices; a notice another channel delivered is pushed too |
| `context.listener(id)` | `auth: { mode: "none" }` refuses a listener that reaches beyond the machine |
| `identities` with `token:web-console` | `none` and `password` speak for the primary owner (or `auth.principal`) without an `access.owners` entry |

The app has three ways to know who is asking, chosen with `auth`: `{ mode: "verifier" }` (a request verifier such as `cloudflareAccess(...)`), `{ mode: "password" }` (a login page and a signed cookie) and `{ mode: "none" }` (whoever reaches the listener).
**Only a verifier resists an agent on the host.**
The agents' shell runs as the service user and inherits its environment, so with `none` an agent can call the app's socket as the owner, approve its own held actions and turn yolo on, and with `password` it can read the password and the session key.
Choose `none` or `password` for a host whose agents have no shell or run as another user, and keep a signing proxy for one whose agents run commands; the README's threat model has the details.

The app requires `AGENTS` for the panes that show the team (and for the Files pane's default places, `AGENTS.workspace`), `MODES` for Rooms and `SCHEDULES` for Schedules, and the `memory` addon for Notes.
A host that lists a pane the services cannot back does not start, and says which service is missing.

### What plugins do not extend

A plugin adds slash commands through the Discord plugin's registrar and never receives the composed commands (see [slash commands](#slash-commands-commandsadd)).

The following fields and parts from 0.1.0 were removed because only built-in plugins used them.
`definePlugin` or startup refuses plugins that use them and names the replacement:

| Removed | Use instead |
|---|---|
| `RoundtablePlugin.useCommands(composed)` | `context.services.get(DISCORD).commands.add(...)` from `setup` |
| The `interactions` part of a contribution | The same: `commands.add({ module, rootOptions })` |
| `ChatSurface.useCommands(composed)` | Nothing calls it any more; a surface that has it is refused |
| The host option `commands` (`RoundtableOptions.commands`) | `discord.rootCommand` in the configuration; the Discord plugin composes under it |
| `RoundtablePlugin.agentServer()` and the `agentServer(outcome)` event | A service with `startInBackground`, and the `serviceStarted` event handler |
| `RoundtablePlugin.stopTurn(channel)` | `stop(channel)` on the `ChannelClaim` that owns the channel |

## Characters: composed pictures for agents

`pi-roundtable/characters` draws an agent as a small character built from parts, so a look is data (a few ids and three colors) instead of a picture that has to be generated.
The entry has no dependencies and imports nothing from Node, `canvas` or the core, so the same code runs in the server, in a browser bundle and in a plugin; a test holds it to that.

```ts
import { composeSvg, resolveCharacter } from "pi-roundtable/characters";

const look = resolveCharacter({ class: "knight", palette: "teal" });
const svg = composeSvg(look, { look: "camelot-dark", frame: "shield", size: 256 });
```

### The look: `CharacterSpec`

A `CharacterSpec` is a complete look: `v: 1`, a `class`, and the parts `outfit`, `hat`, `prop`, `hair`, `beard` (or `"none"`), `accessory` (or `"none"`), the `build` (`slim`, `regular` or `stout`), a `skin` tone `0`–`5`, a `hairColor`, and `colors` (`primary`, the agent's accent; `secondary`; `trim`), each a lowercase `#rrggbb`.
`palette` names the preset the colors equal, and is absent when they are custom.
The parts are medieval: the clothes, hats and gear of an agent are what a late-medieval town or court would know, so a `goggles` hat is a pointed cap, `wrench` a pair of dividers and `telescope` an astrolabe, and the ids stay the same. A class is a preset of parts, not a body, so a new class is an outfit and gear: the 24 are `wizard`, `knight`, `scholar`, `smith`, `ranger`, `bard`, `alchemist`, `healer`, `steward`, `navigator`, `seer`, `scribe`, `engineer`, `druid`, `innkeeper`, `sentinel`, `envoy`, `rogue`, `monk`, `falconer`, `shipwright`, `jester`, `paladin` and `archivist`.
`CATALOG` lists them with their `label`, the `jobs` they suit and the `keywords` that suggest them (English and zh-TW), and lists every outfit, hat, prop, hair, beard, accessory, the eight palettes (`azure`, `gules`, `vert`, `purpure`, `amber`, `sable`, `teal`, `rose`), the six skin tones and the hair swatches. The catalog is frozen.

| Function | What it does |
|---|---|
| `resolveCharacter(input, base?)` | The look an input describes. It starts from `base`, or from the class preset when there is no `base` or the input names another class, then applies the fields: `palette` sets all three colors, `colors` changes some, and the result's `palette` is set exactly when the colors equal a preset. Throws `CharacterError` for an unknown field or id or a bad color |
| `parseCharacter(value)` | A complete spec from outside the process, checked strictly: an unknown key or id, a missing field, `skin: 6`, or a color that is not `#rrggbb` throws `CharacterError`. Colors are lowercased. Use it for an API body and for what a page receives |
| `readCharacter(value)` | A spec from a stored row, read leniently and never throwing: a field this version does not know (written by a newer one) takes the class preset's value, an unknown key is ignored, and `undefined` comes back only when the value is not an object or names no known class |
| `suggestCharacter(agent, taken?)` | A look for an agent that has none. Each class is scored by its keywords: the display name and the name count 3 each, the first 600 characters of the prompt 1. A tie or no hit is broken by a hash of the name among the classes `taken` does not use. `skin` and `build` come from separate hashes of the name, so a skin implies no body type, and the palette is the one `taken` uses least |
| `composeSvg(spec, options?)` | The picture as an SVG string, see below |
| `accentOf(spec, on)` | `colors.primary` as a UI accent: shaded until it reads at 3:1 on the page. `on` is a scheme (`light`: white, `dark`: `#0d1018`) or a look (`modern-light`, `modern-dark` as the schemes; `camelot-light`: the darkest parchment `#e3d2a9`, `camelot-dark`: the lightest night blue `#243557`) |
| `characterCss()` | The text of `characters.css` |
| `checkSkins(value, field?)` | A host's skin tones checked: exactly six `#rrggbb` colors, returned lower-cased and frozen; otherwise a `CharacterError` whose `field` is `field` (default `skins`) or the place in the list. The host's configuration and `composeSvg` call it |
| `EAST_ASIAN_SKINS` | Six light East Asian skin tones, from very fair porcelain to light beige (`#fbebe0`, `#f8e1d2`, `#f5d8c5`, `#f1cfb8`, `#edc6ac`, `#e9bf9f`), warm pink to peach and never green or yellow, with the face lines reading on each at 5:1 or better. A frozen constant for a host's `characters.skins` |

`CharacterError.field` is the path of the offending field (`hat`, `colors.primary`).

### The picture: `composeSvg`

`ComposeOptions` are all optional: `expr` (one of the 13 `EXPRESSIONS`, by default the one `STATE_EXPRESSION` gives the state), `state` (one of the seven `AVATAR_STATES`: `idle`, `thinking`, `working`, `waiting`, `done`, `error`, `sleepy`), `look` (`modern-light` by default, `modern-dark`, `camelot-light` or `camelot-dark`, which change only the background and ring), `frame` (`disc` or `shield`), `bare` (no frame or background), `still`, `uid`, `size`, `label` and `skins` (six `#rrggbb` skin tones that `CharacterSpec.skin` indexes, in place of `CATALOG.skins`; anything but six valid colors throws a `CharacterError` whose `field` is `skins` or `skins[3]`).

- The output has literal colors only. It has no `style` attribute, variable, `<style>`, script, text, image, link, event handler or `<foreignObject>`, so a page whose content security policy forbids inline styles can inject it, and `canvas` rasterizes it as it is. It is at most 8 KB and the same for the same input. The root is `<svg class="av" data-expr>` and the layers are `<g class="NAME" data-part="NAME">` in a fixed order (`frame`, `ch` holding `back`, `body`, `head`, `hat`, `eyes-brows`, `mouth`, `fx`, `acc`, `prop`, then `state`); the prop group carries `data-prop`.
- `composeSvg` checks the spec again with `parseCharacter`, so a spec cast from untrusted data throws instead of reaching the markup. `uid` (`/^[a-z0-9]{1,16}$/`, default `a`) ends every clip path id, so each avatar on a page needs its own `uid`: two with the same one share clip path ids and one clips the other. The server-side renders pass an explicit one. `size` (an integer up to 4096) adds `width` and `height`, which `canvas` needs. `label` (at most 200 characters) becomes `aria-label` with `<>"'=()&` written as entities; without it the figure is `aria-hidden`.
- A live figure carries every state overlay and leaves the motion to the stylesheet. With `still: true` only the `state`'s overlay is drawn and the figure has class `av static`, for files, PNGs and 3D textures; an `error` state turns the ring red in both.

### Host skins: the `characters.skins` option

A host picks the six skin tones its agents are drawn with. The catalog's own (`CATALOG.skins`, light to dark) stay the default, so a host that says nothing sees no change.

```ts
import { EAST_ASIAN_SKINS } from "pi-roundtable/characters";

export default defineRoundtable({
  // ...
  characters: { skins: EAST_ASIAN_SKINS },
});
```

- `characters.skins` is exactly six `#rrggbb` colors, in the order a look's `skin` index (`0` to `5`) picks them. A list of another length or a color that is not `#rrggbb` is a `ConfigError` that names `config characters.skins` (or the place in the list), and the host does not start. A host that builds `RoundtableOptions` itself gives the same list as `environment.characterSkins`, which is checked at start the same way.
- A stored look keeps its index, so existing agents wear the new tones with no migration. The Discord pictures are PNGs stored by content hash, and render again with the host's skins whenever an agent's look is saved; to bring every agent up to date at once, turn on [`characters.refreshAvatars`](#refreshing-the-pictures-the-charactersrefreshavatars-option).
- Every render path follows it: plugins read `context.env.characterSkins` (always six colors, the catalog's when the host chose none) and pass it as `composeSvg`'s `skins`; the agent server's studio (`AvatarStudio.render`, so the Discord pictures) and `pi-roundtable-web`'s page (the characters, the creator's skin swatches and the round table) already do. The web console receives them as `characterSkins` in `GET api/config`.

### Refreshing the pictures: the `characters.refreshAvatars` option

An agent's Discord picture is rendered when its look is saved, so an agent nobody saved since a redraw of the parts or a change of `characters.skins` keeps its old picture on Discord while the web console shows the new one. `characters: { refreshAvatars: true }` renders them all again when the agent server starts. It is `false` by default, and a host that says nothing sees no change.

- After the team has started and its agents without a look are dressed, the agent server renders every active agent that has a character with the host's skins and stores the PNG by content hash. When the hash differs from the one stored for the agent, the agent's picture is set to it, and Discord shows the new one on the agent's next post; an agent whose hash is the same is skipped, so a restart with nothing changed sets nothing. Agents without a character are left alone.
- It runs in the background, one agent at a time, and does not hold the start back or the team's readiness. It makes no Discord request of its own: the picture is the avatar URL of the agent's webhook posts, which go through the poster's usual rate limits.
- One summary line is logged: `avatars refreshed: re-rendered n, unchanged m, skipped s, failed k`, at warning level with the agents and reasons that failed when `k` is not 0. A failed agent keeps its picture and the others still render; a failure never stops the start. An agent archived or given another look while it rendered is counted as skipped and keeps the newer picture: the write checks the look inside the store's write queue. Stopping the agent server ends the refresh, with no further render, write or log.
- It overwrites the picture of an agent that still wears an old hand-drawn one (deprecated since 0.23), because the look decides the picture. A non-boolean value is a `ConfigError` that names `config characters.refreshAvatars`.

### Motion: `characters.css`

Import `pi-roundtable/characters.css` once. It breathes, tilts, bobs, leans, pops and shakes the figure by `data-state`, which you set on the `<svg>` or, so the markup does not change with the state, on a wrapper with class `av-host`. It moves only `transform` and `opacity`, keeps the pivots in selectors (`.ch`, `.eyes`, the badges and one rule per `[data-prop=<id>]`) since the markup carries no inline style, stops for `prefers-reduced-motion`, and stops on `.av.static`. The file is generated from `characterCss()` by `bun scripts/build-character-css.ts`, and a test fails when they differ.

### Agent characters

Every agent of the agent server is a composed character. `Agent.character` is its resolved `CharacterSpec`, absent only on a row read before the team dressed it; `characterOf(agent)` returns it, or the look `suggestCharacter` gives its role. The spec is stored in the nullable `agents.character` jsonb column, which a migration of the agent server adds (`agents-character`), and `avatarHash` points at the PNG rendered from it, so Discord shows the character at `/avatars/<hash>.png`.

- `AgentSeed.character` (and `agents[].character` in the configuration) is a `CharacterInput` resolved over the look the role suggests: `{ class: "navigator", palette: "amber" }`. A bad field is a `ConfigError` that names it; a plugin seed with a bad `character` is a `PluginError` that names the plugin, the seed and the field. `avatarPrompt` is optional, deprecated and ignored; it is removed in 1.0.
- At every start the team dresses each active agent that has no character: the seed of that name gives it, otherwise the suggestion for its role, spread over the palettes the team already wears. The picture is rendered and replaces the agent's old one, so **every existing agent's Discord picture changes at the first start of this version**. A failure is logged for that agent, which keeps its picture until the next start. A second start changes nothing.
- A new agent's character is the `character` of its `agent_create` call over the suggestion for its role, and it is rendered before the agent is stored, so a render failure fails the create.
- `AgentTeam.dress(name, input)` changes a look: the input is resolved over the agent's current character, rendered, and stored with the new picture in one update. A new `class` alone keeps the agent's colors; give a `palette` or `colors` to change them. A bad field is an `AgentError` that names it, as is an unknown or archived agent.
- `AvatarStudio.render(spec)` renders a character as a 512 px PNG (the idle face on the modern light disc), stores it by content hash and returns the hash; the same spec gives the same hash. A plugin that implements `AvatarStudio` adds it. `draw`, `edit`, `fallback` and `canDraw` are deprecated until 1.0.
- `renderCharacterPng(spec, options?)` (`pi-roundtable/kit`) does the same rasterization and returns the bytes. It needs `canvas` with SVG support (librsvg); the agent server renders a probe character at start and refuses to start when it cannot: the start fails as a `PluginError` whose `cause` is a `ConfigError` ("the agent server needs canvas with SVG support").
- The agent tools and the Discord profile panel choose looks: `agent_create` takes `class` and `color`, `agent_avatar { name, class?, color?, parts? }` calls `AgentTeam.dress` on every host, and `/profile` has a class select (24) and a color select (8). `AgentTeam.redrawAvatar` and `AvatarMode` are deprecated, not removed; use `dress`. An old panel's redraw buttons answer that the panel is out of date.
- Each avatar on one page needs its own `uid` in `composeSvg`; the server renders pass an explicit one.

## Official plugins

The package ships three plugins you can copy into a project and change.
`roundtable add plugin codex-images`, `roundtable add plugin dice`, and `roundtable add plugin release-notice` write `plugins/<name>.ts` and `plugins/<name>.test.ts`, import the plugin in `roundtable.config.ts`, and list it in `plugins`.
You can edit the copied files; `add plugin` refuses to overwrite existing ones.
The three names are reserved for these copies.
Inspect the ready-made implementations in the [codex-images][codex-images-template], [dice][dice-template], and [release-notice][release-notice-template] templates.

The [pi-roundtable-mcp][mcp-package] workspace, published separately on npm, adds two more plugins, `mcpConnectors` and `remoteMcp`.
The first lets the owner add MCP servers such as Notion or a calendar from Discord and gives your code the list; the second lets an agent outside Discord reach your agent.
Install it with `bun add pi-roundtable-mcp`.

Eight official packages live in this repository as Bun workspaces and publish as separate npm packages, versioned in lockstep with the core.
The [site guide source files][package-guides] describe installation, requirements, configuration, and security considerations:

- [pi-roundtable-drawing][drawing-package]: [site guide source][drawing-guide] · local relationship maps, magic circles, sigils, sacred geometry, and card spreads.
- [pi-roundtable-coding][coding-package]: [site guide source][coding-guide] · repository shelves and owner-approved Pi coding workers.
- [pi-roundtable-web][web-package]: [site guide source][web-guide] · the owner app: rooms with the agent team on the web, approval cards, yolo and long-running modes, an installable PWA with Web Push, and a console for conversations, transcripts, and memory notes; see [the owner app](#the-owner-app-pi-roundtable-web).
- [pi-roundtable-sandbox][sandbox-package]: [site guide source][sandbox-guide] · sealed guest channels on native Linux Docker with a host-only credential broker and allow-listed tools.
- [pi-roundtable-mcp][mcp-package]: [site guide source][mcp-guide] · MCP connectors through a gateway and remote MCP endpoints for agent turns and owner-granted Discord channel tools.
- [pi-roundtable-browser][browser-package]: [site guide source][browser-guide] · `browser_task`, a worker that drives agent-browser in a Docker container with no route to the host's private networks, and a `BrowserDriver` for another browser.
- [pi-roundtable-webchat][webchat-package]: [site guide source][webchat-guide] · a WebSocket chat for people an OpenID Connect provider signs in, with private conversations, live progress, and approval cards; see [web chat](#web-chat-pi-roundtable-webchat).
- [pi-roundtable-line][line-package]: [site guide source][line-guide] · a LINE Messaging API transport: a signed webhook, an allowlist of chats, one consumer, and pushes sent under a sender name, a retry key, and a quota check.

[drawing-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/drawing/README.md
[coding-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/coding/README.md
[web-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/web/README.md
[sandbox-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/sandbox/README.md
[mcp-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/mcp/README.md
[browser-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/browser/README.md
[line-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/line/README.md
[package-guides]: https://github.com/wayne930242/pi-roundtable/tree/master/site/src/content/docs/plugins/
[drawing-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/drawing-package.mdx
[coding-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/coding-package.mdx
[web-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/web-package.mdx
[sandbox-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/sandbox-package.mdx
[mcp-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/mcp-package.mdx
[browser-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/browser-package.mdx
[line-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/line-package.mdx
[webchat-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/webchat-package.mdx
[coding-source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/coding
[sandbox-source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/sandbox
[web-source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/web
[drawing-source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/drawing
[browser-source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/browser
[mcp-source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/mcp
[codex-images-template]: https://github.com/wayne930242/pi-roundtable/blob/master/templates/official/codex-images/plugin.ts
[dice-template]: https://github.com/wayne930242/pi-roundtable/blob/master/templates/official/dice/plugin.ts
[release-notice-template]: https://github.com/wayne930242/pi-roundtable/blob/master/templates/official/release-notice/plugin.ts

Install only the packages your host uses; the core does not depend on these workspaces.

| Plugin | What it does | What it needs |
|---|---|---|
| `codex-images` | Fills the [`images` slot](#providers-replace-a-part-the-core-runs-on), so agents can draw avatars from a prompt and reference pictures | A login to the `openai-codex` provider; setup throws a `PluginError` that says so when the host has none |
| `dice` | Adds the `roll_dice` tool for members: `2d6+3`, `4d6k3` (keep or drop the highest or lowest dice), several groups, and fate dice `dF`, answered as text such as `2d6+3: [3, 5] + 3 = 11` | Nothing; it takes at most 100 dice in all and 1000 sides per die |
| `release-notice` | After a deploy, posts once in the coordinator's channel which commits the running release added since the release last announced, and says which channels the previous shutdown cut short | A `release.json` that your deploy writes (see below); without the file it posts nothing |

`codex-images` takes the login through [`context.apiKey("openai-codex")`](#the-context).
It sends requests to ChatGPT's Codex backend using the owner's ChatGPT subscription login.
OpenAI doesn't document the backend for this use, so it can stop working without notice; the subscription's terms apply.
The copied file begins with this warning.
Its client and plugin come from `pi-roundtable/kit` (`createCodexImages`, built on `drawCodexImage`): the copied `plugins/codex-images.ts` imports them and makes the plugin you list, so a fix to the protocol arrives with an upgrade of the package, not with a new copy.
A drawing aborts with the turn that asked for it, a request stops after five minutes, and a response stream over 32 MiB is refused.
A copy made before 0.19.0 holds the whole client and keeps working as it was, without the abort and the stream limit, until you copy the template again.
To change the model, pass `createCodexImages({ model })`; the default is `CODEX_IMAGE_MODEL`.

`release-notice` listens to two [events](#events-hear-what-the-core-does).
When the agent server's team service reports `ready`, it reads the release file and posts if the release's `sha` differs from the one it last announced (`announced-release` in the data directory), or if the previous shutdown cut work short.
It records the announced `sha` only after the post succeeds, so a failed post is tried again at the next start, and a `release.json` that is not valid (not JSON, an empty `sha`, or `commits` that is not a list of strings) fails the handler with its path in the log.
At `shutdown(left)` it adds the channels in `left`, the work the drain gave up on at its limit, to `aborted-on-shutdown.json` in the data directory; the next start's announcement names them as cut short (a Discord channel key as a `<#id>` mention), and once it is posted they are removed from the file. A shutdown that arrives while a post is still in flight keeps its channels for the next announcement.
A plain restart of the same release with nothing cut short posts nothing.

The deploy writes `release.json` into the release directory, where the bot runs, before it starts the bot.
The file holds the commit the release was built from and the subjects of the commits it added over the release last announced, newest first, so that a release whose announcement failed or never ran is not skipped over:

```json
{ "sha": "abc1234", "commits": ["fix: handle an empty reply", "feat: add a notes tool"] }
```

The plugin keeps the sha it last announced in `announced-release` in its data directory, so a deploy script on the same host can read the range's start from there.
This script writes the file from the checkout, and stops the deploy when `git log` or `jq` fails; the first deploy, with nothing announced yet, gets an empty `commits` list:

```sh
set -euo pipefail
previous=$(cat data/announced-release 2>/dev/null || true)
commits='[]'
if [ -n "$previous" ]; then
  commits=$(git log --format=%s "$previous..HEAD" | jq -R . | jq -s .)
fi
printf '{"sha":"%s","commits":%s}\n' "$(git rev-parse --short HEAD)" "$commits" > release.json
```

`createReleaseNotice(options)` takes `releaseFile` (default `release.json` in the working directory), `dataDir` (default `./data`, where a new project's config keeps its data, so set it when the config's `dataDir` differs), and `announce` (default: the agent team's `announce`, which posts in the coordinator's channel and splits a long text).
The plugin you list in the config, `releaseNotice`, uses the defaults.

Each copy has a test that runs offline: `codex-images` with a fake `fetch`, `dice` with a fake random source, `release-notice` with temporary directories and its own `announce`.
Each file exports a `create...` function (`createCodexImages`, `createDice`, `createReleaseNotice`) that takes the part a test replaces, and the plugin you list in the config, built from it.

## Testing a plugin

Use `testPlugin(plugin, options?)` for most tests; it sets up one plugin against a fake context.
Use [`testHost`](#testhost-the-built-in-plugins-and-yours-over-postgresql) for tests that depend on built-in plugins or the host's setup order; it boots them alongside yours over PostgreSQL.

`testPlugin` sets one plugin up against a fake context and starts its services, with no Discord and no PostgreSQL unless you pass `{ database }`.
It resolves only its default owner unless you inject `servicePair(IDENTITY, { resolve })` for your test's actors; do not invent a speaker in a claim to bypass admission.
The [principals example](#principals-and-access) injects only the read method it exercises, and the study-room example tests router-resolved attribution and refusal.
It returns:

| Field | What it is |
|---|---|
| `contribution` | What the plugin added, as the host would collect it: `tools`, `prompt`, `seeds`, `events`, `services`, `http`, and the rest |
| `tools`, `tiers` | The tool names, and the table that says what tier each needs |
| `holds` | The plugin's `holdRules` chained as the host links them (`holdChain`): `holds(tool, input, { workspace?, scratchDir? })` returns the description of a call that must be approved first, or `undefined`; `holds.inTurn(tool, input, context, turn)` asks them as a turn does, and returns a promise when a hold looks things up |
| `runTool(name, args, { speaker, origin, client, channel, workspace }?)` | Runs a tool the way an agent's turn would, in the channel (default `test:1`) for the speaker, and returns the text the model reads; `origin` is the turn's `turn.origin`, `client` its `turn.client` (a `ClientPort` the test fakes), and `workspace` (`{ workspace, scratchDir? }`) is the session's `turn.workspace` |
| `images` | The images successful `runTool` calls returned as `ToolOutput` images, recorded as `{ channel, image: { mimeType, data } }` |
| `files` | Accepted files from `runTool`, recorded as `{ channel, file: ReplyFile }`; inject a surface with `supportsFiles: true` and pass its channel to test attachment tools |
| `events` | The events the plugin itself reported through `context.events`, and those of `context.turns` |
| `conversations`, `turns`, `surfaces` | What the plugin sees as `context.conversations`, `context.turns`, and `context.surfaces`, for a test to drive its claims |
| `runtime` | The runtime the plugin's `runtime` provider built, given stand-in dependencies; `undefined` when it fills no such slot |
| `stop()` | Delivers `shutdown`, stops the injected surfaces, and stops the services in reverse |

The harness applies the same checks as the host (a plugin that adds nothing, an unknown part, a clash of names, a tool with no tier), so a mistake fails your test with the message the start would print.
Run migrations yourself (see the [`migrations`](#migrations-and-contextdatabase-tables-of-your-own) test), call event handlers with their payloads (see [`events`](#events-hear-what-the-core-does)), and call `contribution.prompt`'s `build` to test prompt text (see [`prompt`](#prompt-text-added-to-every-agent-turn)).
The harness leaves these calls to the test.
`sessions()`, `conversations`, `surfaces`, `turns`, and `dashboard()` throw `NotLinkedError` during `setup`, as they do in the host.
After setup, `conversations` routes to the plugin's claims, `surfaces` contains its surfaces, which start with its services, and `turns` runs over the runtime and surfaces.

#### Options

| Option | What it gives the plugin |
|---|---|
| `env` | A partial `HostEnv` for `context.env`; `en` and `UTC` by default |
| `owner` | The owner the runtime's dependencies and the agent server's claim know: `{ id, name, pronouns? }`; `owner` named Owner, addressed as they, by default |
| `database` | A Bun `SQL` for `context.database()`; without one it throws `no database is configured` |
| `providers` | Provider slots filled as if another plugin filled them |
| `surfaces` | Chat surfaces besides the plugin's own, such as the fake surface of `examples/fake-surface.ts`: they are in `context.surfaces`, start after the plugin's services with the harness routing their messages to `conversations`, and stop with `stop()` |
| `services` | What the plugin reads from `context.services`: one `servicePair(KEY, { ... })` for each service, with the members you give it. `servicePair(RUNTIME, runtime)` is the runtime `context.turns` runs on, given whole; `servicePair(AGENTS, { runtime })` also works when no `RUNTIME` is given. Reading a member you did not give throws a `PluginError` that names the option to add; a service you did not give reads as absent to `find`, and `get` says to give it, except for the ones below |
| `conversations` | Methods that replace the router's, such as `stop`, for a plugin that calls them |
| `turns` | A `ConversationTurns` that replaces the default one |
| `apiKeys` | The credentials `context.apiKey(provider)` returns, by provider name: `{ "openai-codex": "key" }`. A provider not listed reads as having none, as on a host that is not logged in |
| `forwardJoinMs` | How long the router holds a bare forward for the message that follows it (the host option `conversations.forwardJoinMs`) |
| `listeners` | The addresses `context.listener(id)` reports, each `{ id, socketPath, mode? }` or `{ id, port, hostname? }`; an id not listed reads as `undefined` |

The harness supplies what the host would, so a claim or a background turn behaves as it does there:

- `BACKGROUND_TURNS` runs real background turns over the harness's router, so scheduled and delegated turns reach the plugin's claims.
  Supply your own with `servicePair(BACKGROUND_TURNS, { ... })`.
- When you give `AGENTS` and a `providers.judge`, its `approvals` uses the real confirmation judge to approve or decline held actions as the agent server does.
- Giving `AGENTS` a `team` puts the agent server's own claim in the router, for the `owner`, so the plugin's claims are tested against the agent channels as on a host; its `owner` background target comes with it.

A plugin under test that lists a key in `requires` is refused unless the `services` option gives it (or the plugin provides it), the way the host refuses a key no plugin provides.
A `services.lazy` reader answers once `testPlugin` returns, from the services you gave.

For a plugin that fills the `runtime` slot, the harness builds the runtime and puts it under `AGENTS`'s `runtime`.
It supplies a silent logger, a one-owner identity, in-memory held actions, and one stand-in agent setting.

A test for the tools example:

<!-- example: examples/tools.test.ts -->
```ts
import { expect, test } from "bun:test";
import type { Speaker } from "pi-roundtable";
import { testPlugin } from "pi-roundtable/testing";
import { notes } from "./tools.ts";

test("note_add saves a note for the speaker and refuses an empty one", async () => {
	const harness = await testPlugin(notes);
	const ada: Speaker = {
		id: "1",
		name: "Ada",
		tier: "member",
		principalId: "1",
	};
	expect(harness.tools).toEqual(["note_add"]);
	expect(harness.tiers.minTier("note_add")).toBe("member");
	expect(
		await harness.runTool("note_add", { text: "milk" }, { speaker: ada }),
	).toBe("Saved note 1 for Ada.");
	expect(await harness.runTool("note_add", { text: " " })).toBe(
		"The note is empty. Ask what to save.",
	);
	await harness.stop();
});
```
<!-- /example -->

Run every test with `bun test`, and the types with `bun run typecheck`.

### Optional database and locale fixtures

Importing `pi-roundtable/testing` works with `CI=true` and no database URL.
`describeDb` is Bun's `describe` when `ROUNDTABLE_TEST_DATABASE_URL` is set, and `describe.skip` otherwise; use it to gate a database suite.
`testDatabaseUrl` is that URL or an empty string, and `TEST_GUILD` is a synthetic guild identifier.
Both are live bindings: `describeDb` and `testDatabaseUrl` read after `usePostgresForTests()` has run show the database it started.
`requireDatabase()` gives the URL, and throws an error that says how to provide one when the run has none, for a test file that must not be skipped.
`usePostgresForTests({ binDirs?, require? })` is for a test preload: unless `ROUNDTABLE_TEST_DATABASE_URL` is already set, it starts a throwaway PostgreSQL on `127.0.0.1` (trust authentication, `fsync` off, a temporary data directory), sets the variable and `testDatabaseUrl`, and stops and removes it after the run.
It looks for `initdb` and `postgres` in `binDirs` (default `PG_BIN` and the usual Homebrew and Debian directories) and then on `PATH`; with `require: true` it throws when it finds neither, and without it the tests that need a database skip or call `requireDatabase()`.
Three lines are the whole setup: put `[test]` `preload = ["./test-support/postgres.ts"]` in `bunfig.toml`, and in that file:

```ts
import { usePostgresForTests } from "pi-roundtable/testing";

await usePostgresForTests({ require: true });
```

`openTestStore(Store, ...args)` runs the store's `migrations(...args)` or its single `migration`, calls `Store.attach`, and returns a `TestStore<T>` whose `close()` closes its own SQL pool.
Use it with your own store class in a gated database test, and close the store when the test ends.
It doesn't attach another instance of the host's stores.
Call `useTestLocale()` after a test changes the process-wide locale or time zone to reset them to English and UTC, not from a running plugin.
`testPlugin`'s options take `env` (a partial `HostEnv`) for the `context.env` the plugin sees; it defaults to `en` and `UTC`.
`OWNER_SPEAKER`, `fakeThreads`, and `silentLogger` supply neutral stand-ins for owner turns, dispatch threads, and logging.
`recordingLogger()` is a logger that keeps what it is asked to write: its `lines` hold each call's `level`, `fields` (those of a `child` included), and `message`, for a test of what the code logs.
Use `partial<Port>({ ... })` to stand in for a port your code takes as an argument.
It provides the members you give it and throws an error naming any missing member you read, so the test needs no `as unknown as Port` cast.
`fakePrecheck(name, answer, { description?, timeoutMs? })` is a precheck that answers `answer` (a `PrecheckResult`, an `Error` it throws, or a function of its context) and records each context in `calls`; `fakePrechecks(...prechecks)` is a real in-memory `PrecheckRegistry` with them registered, which a test gives a plugin as `servicePair(PRECHECKS, registry)` and reads back with `registry.get(name)`.
`fakeScriptRunner(answer, { describe?, timeoutMs? })` is a `PrecheckScriptRunner` that runs nothing and answers `answer` (a result, an `Error` it throws, or a function of the script and its context), recording each call in `calls`; give it to `registry.useScriptRunner`.
`fakeDiscord({ ownerId?, rootCommand?, channelContext?, poster? })` is the `DISCORD` service for a plugin that adds slash commands, reads channel context or posts through `DISCORD.poster`: give it as `services: [discord.service]`, read what the plugin added with `discord.added()`, and compose the tree Discord would get with `discord.compose()`; `channelContext` answers `DISCORD.channelContext`, by default with no context.
Only `commands`, `guard`, `poster` and `channelContext` are given; `discord.poster` is the poster the test passed, else a new `fakeDiscordPoster()`. A plugin that reads another member of `DISCORD` in a test gives its own with `servicePair(DISCORD, { ... })`.
`fakeDiscordPoster({ idOffset?, now? })` is a `DiscordPoster` in memory: `channels` with their messages, pins and webhook pictures, `directs`, and the knobs a test turns (`closedDirects`, `goneChannels`, `categories`, `memberNames`, `hiddenFrom`, `nonMembers`, `pinNotices`, `canReadAuditLog`, `failNext(operation, error)`, `speak`, `personCloses`, `autoArchives`, `personOpens`, `deleteWebhook`, `recreateWebhook`). `messagesIn(channelId)` lists what a channel holds. It keeps the real poster's argument checks and error kinds, a channel's two renames in ten minutes (by `now`) and the 250 pins. `idOffset` moves every id it makes, so test files that share a database never meet the same id.

### `testHost`: the built-in plugins and yours, over PostgreSQL

`testPlugin` sets up your plugin alone.
For tests that need the agent server, modules, stores, or the host's session-tool setup order, use `testHost(options?)`.
It boots `defineRoundtable` over `ROUNDTABLE_TEST_DATABASE_URL`, with stand-ins for Discord and the runtime, or without Discord; gate the suite with `describeDb`:

| Option | What it gives the host |
|---|---|
| `config` | Over a test configuration (an owner, a guild, a temporary `dataDir`, the test database, one agent): any of the `RoundtableConfig` keys, such as `skills: false` |
| `plugins` | Your plugins, placed after the built-in ones as `defineRoundtable` places them |
| `runtime` | The runtime every turn runs on; by default one that answers `""` and builds no Pi session |
| `apiKeys` | The credentials `context.apiKey(provider)` returns, by provider name; a provider not listed reads as having none, whatever login the machine holds |
| `discord` | What the stand-in Discord hands out: `agentChannels(guildId)`, `ownerChannel()`, `channelInfo(channelId)` and `poster` (what `DISCORD.poster` is; by default a `fakeDiscordPoster()`); `false` boots a [host without Discord](#a-host-without-discord), with no `discord`, `http`, or `agents` in the test configuration; give `config: { agents }` and a plugin whose surface declares `agentRooms` to boot an [agent team without Discord](#an-agent-team-without-discord) |

It returns:

| Field | What it is |
|---|---|
| `context` | The `PluginContext` of a probe plugin set up after every other: read `services`, `sessions()`, or `toolTiers` from it |
| `conversations` | The host's conversations, as a surface would drive them |
| `commands` | `added`, every slash-command contribution the plugins handed Discord in order, and `composed()`, the tree Discord would register |
| `sessionTools(scope?)` | The tools each extension of a session registers, in plan order (an extension that registers commands, flags, or event handlers besides tools is accepted, and only its tools are listed); the owner's session unless an `AgentTurnScope` is given |
| `sessionContext(scope?)` | A `SessionContext` as the runtime builds it, with the real compaction wrapper |
| `runTool(name, args, { speaker?, channel?, origin? })` | Runs a contributed tool in the owner's session as the speaker on the channel (the owner's channel by default), as `testPlugin`'s `runTool` does, and gives the text the model would read: a tool that throws throws, a refusal (`ToolRefusal`) comes back as its text, and a tool no plugin added throws a `PluginError` |
| `hold(name, args, { speaker?, channel? })` | What the tool's hold shows for the call, asked as a turn of that speaker on that channel asks it, or `undefined` when the call runs without an approval |
| `stop()` | Stops the host; call it when the test ends |

`useEagerCatalog()` sets a catalog that marks every text and uses a foreign time zone.
`eagerText(value)` lists the marked strings under a value, so a test can check that the host applied its own environment before building text from the catalog.
`useTestLocale()` restores the neutral defaults.

`holdChain(rules)` is in `pi-roundtable/kit`: the chain the host links from every plugin's hold rules, to test a rule set without a harness.

### `Roundtable.check()`: prove the registration without a database

`new Roundtable(options, plugins).check()` sets up every plugin as `run()` would and refuses what `run()` refuses: a plugin that adds nothing, two services of one name, a service no plugin provides, a field the host removed, a route that clashes or names a listener that is not configured.
It migrates nothing, starts no service, opens no listener, reaches no Discord and runs no preflight, so it needs neither PostgreSQL nor the network.
It runs each plugin's `setup`, so a plugin keeps whatever its setup keeps: the built-in agent server binds its sessions once, so the plugin objects of a definition that was checked cannot be run, or checked again.
Check a definition you do not run: call `defineRoundtable` again for the check, as `roundtable doctor` and `roundtable start` do (they also evaluate `roundtable.config.ts` again, so the plugins it makes with a factory are new objects), and run the one you did not check.
The configuration file's top-level code therefore runs twice under `doctor` and `start`: keep side effects out of it (opening a port, writing a file, calling a helper that refuses a second call). If the file was not evaluated again, because the runtime did not run it or because its default export is built in a module it imports, the check fails and says so; build the definition in `roundtable.config.ts` itself.
What stays shared between the two definitions is a plugin object that a module the configuration imports exports, and state kept at module level: a plugin's `setup` must keep nothing one-shot outside its call, such as a value it binds once and then refuses to bind again, because `doctor` and `start` set the same plugin up twice.
As `run()` does, it sets three things of the process: the locale and the time zone from the host's `environment`, and `PI_CODING_AGENT_DIR` when `environment.agentDir` is set.
A check of another host while one runs therefore changes them for the running host, and in one `bun test` process they carry into later test files; give the hosts you check the same `environment`.
It is no running host: a check never makes `run()` refuse a second host.
It resolves a `RegistrationReport`: `plugins` (those that run, in set-up order), `services` (those they contribute, in start order) and `routes` (as `<listener> <path>`).

A plugin's `setup` sees a database that refuses every query, so setup may take `database()` and hand it to a store but may not query it: query from a service's `start` or from a handler.
A plugin that queries during setup fails the check with `plugin <name>: setup failed: the database was queried during setup…`.
Work that must be done before any service starts, such as reading the stored rows a command or a turn needs at once, belongs in the plugin's `preflight`, which the host runs after every plugin is set up and `check()` never runs.
The built-in plugins that read or write rows when they attach (the identity sync, the skills and the agent stores) skip that load here and start empty.
The identity sync still settles what the configuration and the declared identities settle without a stored principal: a plugin identity that names no principal when `access.owners` lists no one to bind it to, and an owner who names their `principal` and lists an identity a plugin binds to another principal.
What needs a stored principal or link, such as a plugin bound to a principal that does not exist, is left to the start.
Keep resources out of `setup`; open them from a service's `start`, which `check()` never runs.

Test the production composition with it, since the other tests build their settings by hand:

```ts
import { expect, test } from "bun:test";
import { defineRoundtable, Roundtable } from "pi-roundtable";
import { silentLogger } from "pi-roundtable/testing";

test("the production configuration registers every plugin", async () => {
	const defined = await defineRoundtable(productionConfig(), { logger: silentLogger() });
	const report = await new Roundtable(defined.options, defined.plugins).check();
	expect(report.plugins).toContain("my-plugin");
});
```

`roundtable doctor` and `roundtable start` run it in the offline `plugins` check, on a definition assembled again for the purpose (the configuration file is evaluated again too), so a configuration the host would refuse fails before `start` migrates or contacts Discord.

### `describeSurfaceContract`: what every chat surface keeps

A plugin that contributes a `ChatSurface` can test it against the contract every surface keeps.
`describeSurfaceContract(name, make)` registers one test per check, each on a fresh `SurfaceContractSubject` from `make`: the `surface`, a `channel` of it, and one person on its network, who can `write(text)`, whose `observations()` list what they have seen (`SurfaceObservation`: a reply's text and file names, typing and stop controls going on and off, progress, and prompts opening and closing), and who may `answer(prompt, approved)` an approval; `speaker` is who they are to `surface.prompts`, given as `promptScope(speaker, visibility)`, an owner by default, and every approval the contract asks for needs exactly their tier. `stranger`, when given, is someone else on the network, another principal and not an owner, who knows the id of the person's open approval and may `join()` and `answer(prompt, approved)` it; `owner`, when given, is an owner on the network, another principal than the person, who does the same in the person's private conversation. Both are `SurfaceContractAnswerer`s. `approver`, when given, is a third person on the network with a `principalId`, not an owner and at the person's tier, whom the contract names in `approvers`; `speakerOnly` marks a surface that honours `ApprovalOptions.speakerOnly` in a shared conversation, which the contract then checks with the `owner`; `privateOnly` marks a surface that serves only conversations private to one person, such as the web chat.
The contract starts the surface, calls the subject's `join()`, and stops the surface after the subject's `close()`.
It checks that the surface names a prefix and owns its channel, delivers what the person writes, and shows every chunk of a reply; and, for the parts the surface offers, that it delivers files when `supportsFiles` is set, ends typing and stop controls idempotently, shows progress, and resolves an approval as the person approves or declines it, or `cancelled` when the turn stops or its plugin withdraws it (`ApprovalOptions.supersede`; one answered first stays answered), with a `stranger`, that the stranger's answer leaves the person's approval open, and with an `owner`, that an owner's answer leaves it open in a private conversation; with an `approver` and a `stranger`, that an approval naming the approver is answered by the approver and not by the person or the stranger, unless the surface is `privateOnly`, and, with an `approver`, that a private conversation ignores the names; with a `speakerOnly` subject and an `owner`, that an owner's answer leaves an approval that is the speaker's alone open in a shared conversation, unless the surface is `privateOnly`; and, for a speaker below the owner tier, that a private conversation's approval above their tier resolves `unavailable` (or `expired`, as older surfaces answer) at once and is not shown.
A check for a part the surface does not offer passes.
The contract has no check for `ApprovalDetails.copy`: a surface that shows it keeps it informational, so using it never resolves, approves or declines the prompt, whoever uses it.
A subject that gives `answerQuestionnaire` (and a `stranger` that gives its own) must declare `asks` and also keeps the questionnaire checks.
`checkSurfaceContract(make)` runs the same checks and returns the ones that failed, as `SurfaceContractFailure`s.

## What happens when the bot starts and stops

`roundtable start` checks Bun, `.env`, the configuration, the plugins, the model login, and the public URL without using the network.
A failed check stops startup with the same message as `roundtable doctor`.
The host's `run()` handles startup:

1. Each plugin's `replaces` is applied: the plugin that provided a replaced service is dropped, and the replacement stands where it stood.
   Providers are then resolved: each slot from the plugin that fills it, or the core's default.
   The runtime plugin builds the runtime later, in its own setup: from the `runtime` slot when a plugin fills it, else the Pi runtime.
2. The database is opened and every plugin's migrations run, in plugin order.
3. Every plugin's `setup` runs, in plugin order.
   The order is the built-ins (`identity`, `memory`, `schedule-store`, `prechecks`, `discord`, `modules`, `worker-sessions`, `discord-admin`, `skills`, `conversations`, `runtime`, `agent-server`, `seeds`; an addon that is switched off is not there, and without Discord neither are `discord` or `discord-admin`, nor, without `agents`, `skills`, `agent-server` or `seeds`), then yours in the order of `plugins` in `roundtable.config.ts`, then the built-in `schedules`, so a due schedule fires only once everything it can reach is running.
4. The contributions are linked: tool tiers, hold rules, the session plan, the channel router, and the events.
   From here `sessions()`, `conversations`, `surfaces`, `turns`, and `dashboard()` work.
5. Every plugin's `preflight` runs, in plugin order.
   The Discord plugin's preflight is where it composes the slash commands every plugin added in `setup`; a clash stops the start here.
   Once every one has finished, the runtime's own `preflight` (the `RUNTIME` service's) runs, so its check of the model and the required tools sees the tools that other plugins filled in during theirs.
6. Every service starts: the plugins' in plugin order, and each plugin's own in the order it listed them, after the plugin's chat surfaces (the `surface:<prefix>` services).
7. The HTTP listeners open.
8. Every service's `startInBackground` runs, at once and without holding up the boot, and every plugin hears `serviceStarted` as each ends; the agent server's `team` service starts the agents' channels and the dashboard there.

Steps 1 to 5 must succeed before anything reaches Discord or the listeners.

`run()` applies the host's environment to the process: the locale and time zone, the assistant's name, and `PI_CODING_AGENT_DIR` from `options.environment`.
`defineRoundtable` puts these values in the options for `run()` to apply.
Build command and tool descriptions from the message catalog in `setup` or later, when that environment is in effect.
The Discord plugin builds the root command's description in its preflight.
The message catalog and time zone are process-wide, so only one host can run in a process at a time.
A second `run()` is refused while a host is running; stop that host or use a separate process.
If a startup step fails, the host stops its listeners, stops services in reverse order, closes the pool, and rethrows.
The process exits non-zero.
The same host may call `run()` again after that.

On `SIGTERM` or `SIGINT` the bot takes no new work at once, finishes what runs, and stops serving last:

1. It stops starting work: the channel queue closes (`context.queue.closed` turns true), and from then on no new turn starts, whoever asks. A message that arrives is not run; its channel gets one short "restarting, try again shortly" reply, except a bot's or an integration's message, which is only logged. A background turn (a schedule's, a delegated task's report, an error report) is skipped, and so is a turn a plugin asks of `context.turns.run`, which rejects with `HostStoppingError`; a task for the queue that has not started, whether queued before or after, is refused with the same error. The scheduler claims nothing, so a due schedule stays due and fires after the next start if it is less than twelve hours late. A turn that is already running finishes. A plugin that starts turns from a timer or a route of its own should check `context.queue.closed` first.
2. It waits until the channel queue is empty and no service reports `busy()` work, for at most three minutes (`drainSeconds` in the config, `drain.limitMs` in `RoundtableOptions`). If work is left, it stops each running turn as the owner's stop does, gives them ten seconds (`drain.abortGraceMs`) to end, and goes on; whatever is left is logged and given up on.
3. Every plugin hears `shutdown(left)`, while every service is still running.
4. The HTTP listener closes, so no request reaches a service that has stopped.
5. Services stop in the reverse of the order they started.
6. The database pool closes.

`shutdown()` returns exit code `0`, or `1` if a listener, service, or pool failed to stop.
Every call shares the same shutdown.
Give the service manager a stop timeout longer than the drain limit plus about a minute for the steps after it, such as systemd's `TimeoutStopSec=5min` with the default three-minute drain; a shorter one has the manager kill the process in the middle of the drain.
The built-in runtime limits a turn to 10 minutes of work by default (`turnLimits.timeoutSeconds`), not counting time spent waiting on the owner's cards. Each message steered into the running turn gives it the full budget again from that moment, up to a cap of 30 minutes of work for the whole turn by default (`turnLimits.maxSeconds`); once the cap is reached the turn takes no more steering, so a message waits for the next turn.
When a limit fires on a turn that can show a card (an owner's turn or a report turn on a surface with cards, the same turns that can ask with `ask_user` or an approval card), the turn is not aborted: it keeps working and a card asks the owner whether to go on. The card names the limit, how long the turn has worked, what it is doing now (the tool running and for how long, or waiting on the model, or compacting the conversation) and the tools it called so far, by name and count, never their inputs. **Continue** gives the turn another full budget from the answer; at the cap it moves the cap too, to a full budget from the answer, so the owner can keep going in steps. **Cancel** aborts the turn. With no answer within `turnLimits.cardSeconds` of wall time (5 minutes by default) the turn is aborted. The time the card is open counts as work, unlike an `ask_user` or approval card, because the turn keeps working; while it is open the turn takes no steering. If the turn finishes first, the card closes saying so and the reply is posted as usual; a press after that gets the usual "no longer valid" reply. The card's buttons come from `ApprovalOptions.wording` on `Prompts.confirm`, with `supersede` closing it, and `ApprovalOptions.purpose` is `"turn-timeout"` on it (`"action"` or absent on a held call's approval), so a surface can tell the two apart and notify on the first; Discord ignores `purpose`. A surface that shows approvals shows it; one that ignores `wording` shows its own approve and decline labels.
A turn that cannot show a card (a schedule's turn, a member's turn, an agent's message, an agent's opening task, a turn without a surface) is aborted at once, as before, unless the conversation is [long-running](#long-running-conversations) or, for a schedule, the schedule has its own `time_limit_minutes`. The failure it posts in the conversation names the limit and, for such a turn, says that no one was in the conversation to ask for more time and how to allow it (`TurnTimeout.unasked`), so the owner sees where it stopped. Either way an aborted turn fails with a `TurnTimeoutError` (an `AgentRunError`) whose `timeout` (`TurnTimeout`) holds the limit, the work time, the running tools, whether it was compacting, the tools so far, and how it ended (`end`: `"timeout"`, `"cancelled"` by the owner, or `"unanswered"`); its message says the same in English, and the failure the conversation posts says it in the host's language instead of the generic failure notice.
The limits are the config's `turnLimits`, which the runtime plugin passes on to `turnTimeoutMs`, `turnMaxMs` and `turnTimeoutCardMs` of `PiAgentRuntimeOptions` (a host that builds the runtime itself sets those directly):

| Key | Default | What it is |
|---|---|---|
| `turnLimits.timeoutSeconds` | `600` | A turn's budget, 60 to 86400; each steered message renews it |
| `turnLimits.maxSeconds` | three times `timeoutSeconds` | The most one turn works in all, at least `timeoutSeconds` |
| `turnLimits.cardSeconds` | `300` | How long the card at a limit waits for an answer, 30 to 3600, in wall time |

A limit that waiting on an owner's card pushed back can fire up to a second late. The log says `steer renewed the turn's time budget` with `deadlineMs`, the work time left; `turn reached its time limit; asking the owner` when the card is posted; `owner continued the turn past its time limit` on Continue; and the warning `turn timed out; aborting` names the limit that fired (`limit: "turn"` or `"turnMax"`) with `workedMs`, `running`, `compacting`, `tools` and `end`. Task workers (`task.timeoutMs`), coding workers (`workTimeout`) and sandbox guests (their own `turnTimeoutMs`) keep their own limits, which steering does not renew and which post no card.
A turn whose model ignores its abort (a subprocess that does not exit) is given up on too: a turn that outlives its timeout, or is stopped, gets `turnAbortGraceMs` (15 seconds by default) to end, and then its session is disposed of and the turn is reported failed, so it cannot hold the queue.
`listen()`, called by the command line and a host's own entry point, exits the process with that code.

### Long-running conversations

An owner can switch a conversation to long-running mode, so a turn that reaches its limit goes on by itself instead of asking, or aborting when it cannot show a card. The server extends the limit exactly as **Continue** would, and logs `long-running mode continued the turn`. The cap is per turn: it counts the turn's work since it started, not the time spent on cards, and the extensions stop exactly at it (a `turnLimits.timeoutSeconds` of 3 hours with a 4-hour cap asks or aborts at 4 hours of work, not at 6). It is `autonomy.longRunning.maxSeconds` in the config (`600` to `604800`, default `14400`, four hours). At the cap the turn behaves as an ordinary one: a card whose `ApprovalOptions.purpose` is `"turn-timeout"`, so a surface can push it, or an abort. `ask_user` and approval cards are never answered automatically. `agent_create` takes `long_running: true` to switch the new agent's conversations to this mode before its opening task starts; only an owner's turn may (a lower tier, or the host's own turn, is refused before anything is made), and a host with no `modes` service refuses it.
In a turn nobody is present in (a schedule's, an agent's message, an opening task) `ask_user` has no card to show: it refuses at once, telling the model to write the question as its final answer, which is posted to the agent's room, and the answer arrives as a new turn.

The mode is the conversation's, set with `MODES.set(channel, { longRunning: true }, speaker)` and read with `MODES.peek(channel)`; see [the `MODES` service](#conversation-modes-modes). A surface decides who may toggle it.

## Errors and their fixes

A mistake in a plugin or in the configuration stops the start, before Discord connects, with a message of the form `plugin <name>: <what>. <fix>.`
`roundtable doctor` prints the same messages.
These are the messages as the code writes them, with `<...>` where your names go.

### A plugin's shape

| Message | Fix |
|---|---|
| `plugin "<name>": the name must be lowercase words joined by dashes, such as my-notes. Rename the plugin.` | Rename it in `definePlugin` |
| `plugin <name>: setup is missing. Give the function that returns what the plugin adds.` | Add `setup` |
| `plugin <name> adds nothing. Give it a part (tools, services, channels, and so on), a migration, or a provider, or remove it.` | Return a part from `setup`, or remove the plugin from `roundtable.config.ts` |
| `plugin <name>: setup must return an object of the parts it adds; return {} to add none.` | Return an object, not `undefined` |
| `plugin <name>: setup returned an unknown part "<key>". Did you mean "<closest>"? The parts are services, events, http, holdRules, piPackages, sessionTools, channels, surfaces, personas, backgroundTargets, directChannels, dashboard, tools, seeds, prompt, agentSelection, requiredTools.` | Fix the key; `migrations`, `providers`, and `preflight` belong on the plugin, not in what `setup` returns |

### Tools

| Message | Fix |
|---|---|
| `tool "<name>": the name must be lowercase words joined by underscores, such as note_add. Rename the tool.` | Rename it |
| `tool <name>: the agents already have a tool of this name. Rename the tool.` | Do not use `bash`, `read`, `edit`, or `write` |
| `tool <name>: minTier must be one of member, admin, owner; got <value>. Set the lowest tier that may use it.` | Give `minTier`; leaving it out is also a type error in TypeScript |
| `tool <name>: the description is empty. Tell the model when to call the tool.` | Write the description; the model reads it to decide when to call the tool |
| `tool <name>: run is missing. Give the function the tool runs.` | Add `run` |

### Clashes

| Message | Fix |
|---|---|
| `plugin <b>: tool <name> is already defined by plugin <a>. Rename one of the two tools.` | Rename one tool |
| `plugin <b>: service <name> is already registered by plugin <a>. Rename one of the two.` | Rename one service |
| `plugin <b>: hold rule <name> is already registered by plugin <a>. Rename one of the two.` | Rename one rule |
| `plugin <b>: provider slot <slot> is already filled by plugin <a>. Keep one plugin that fills it.` | Fill each slot from one plugin only |
| `plugin <name>: "<field>" was removed in 0.2.0; <replacement>.` (`useCommands`, `agentServer`, `stopTurn`) | Use what the message names: `commands.add`, a service with startInBackground and a serviceStarted handler, or stop on the channel claim |
| `plugin <name>: the "interactions" part was removed in 0.2.0; …` | Call `context.services.get(DISCORD).commands.add({ module, rootOptions })` from `setup`, with `DISCORD` from `pi-roundtable/discord` |
| `plugin <name>: surface <prefix> has useCommands, which was removed in 0.2.0; …` | Drop `useCommands` from the surface; nothing calls it |
| `RoundtableOptions.commands was removed in 0.2.0; …` | Drop the option; the root command is `discord.rootCommand` in the configuration |
| `plugin <name>: the "agentServer" event was removed in 0.2.0; hear serviceStarted instead, which names the plugin and service whose background start ended.` | Handle `serviceStarted`, and check `event.plugin` and `event.service` |
| `plugin <b>: surface <prefix> is already registered by plugin <a>. Rename one of the two.` | Serve one prefix from one plugin only |
| `plugin <name>: a surface is named by the prefix of its channel keys, a non-empty word without a colon or space, such as discord; got "<value>".` | Give the surface a prefix like `fake` |
| `plugin <name>: unknown provider slot "<slot>". Did you mean "<closest>"? The slots are judge, images, runtime.` | Fill one of the listed slots |
| `plugin <b>: persona kind "<kind>" is already registered by plugin <a>. Keep one persona per kind.` | Give each conversation kind one persona |
| `plugin <name>: the persona kind "agent" is reserved for the agent server's agents. Give the persona the kind of your own conversations.` | Name your own kind |
| `plugin <b>: background target "<name>" is already registered by plugin <a>. Keep one target per name.` | Give each background target one plugin, or rename one of them |
| `no plugin contributes the background target "<name>"` (a schedule's last status, or a skipped turn) | Contribute the target from the plugin whose claim serves it, or cancel the schedule |
| `no persona is registered for the conversation kind "<kind>". A plugin adds one with personas: [...], or its claim must start conversations of a kind that has one.` (a failed turn) | Contribute a persona of that kind, or run the turn with a kind that has one |
| `no runtime provider is configured: the runtime plugin builds the Pi runtime when no plugin fills the runtime slot; read the running one from services.get(RUNTIME)` | Only a plugin that calls `providers.runtime` without `providers.filled.has("runtime")` sees it; read `services.get(RUNTIME)` instead |
| `session tool <name> takes a core extension name. Rename it.` | Pick a name other than the core's |
| `plugin <name>: setup failed: the database was queried during setup…` (from `Roundtable.check()`, `roundtable doctor` or `start`) | A plugin's `setup` ran a query. Take `database()` in setup and query from a service's `start` or from a handler |
| `two plugins are named <name>.` (from `roundtable doctor`) | Rename yours; the built-in plugins are `identity`, `memory`, `schedule-store`, `prechecks`, `discord`, `modules`, `worker-sessions`, `discord-admin`, `skills`, `conversations`, `runtime`, `agent-server`, `seeds`, and `schedules` |
| `migration <plugin>/<name> is declared twice` | A plugin declares two migrations with one name: rename one (the same name in two plugins is fine) |
| `/<root> <name> is added twice`, `/<name> is registered twice` | Give each slash command and subcommand its own name |
| `route <name> is registered twice`, `routes <a> and <b> overlap on listener <id>` | Give each route its own name and a path no other route can take |

### Things used before they are ready

`sessions()`, `conversations`, `surfaces`, `turns`, and `dashboard()` are linked after every plugin is set up.
Calling one from `setup` fails, and the message says when it becomes ready:

```text
plugin <name>: setup failed: session parts are linked once every plugin is set up. Call sessions() from a service's start or from a handler, not during setup. Fix the error, or remove the plugin.
```

The same message exists for `conversations` (`Use them from a service's start or from a handler, not during setup.`), for `surfaces` (`chat surfaces are linked once every plugin is set up.`), for `turns` (`conversation turns are linked once every plugin is set up.`), and for `dashboard()`.
Move the call into a service's `start` or an event handler.

`context.services.get(KEY)` before the plugin that provides it has run throws `service <id> is not provided yet; plugin <name> provides it. Register plugin <name> before plugin <yours>.`
When no registered plugin declares the key it says `service <id> is not provided. Register a plugin that provides it, before the plugin that reads it.`
Your plugins run after the built-ins, so built-in keys show this error only in `testPlugin`, which has no built-ins: `service <id> is not provided. testPlugin has no built-in plugins: give it in the services option, ...`.
Pass what you need in the harness's `services` option, or test that part elsewhere.
`find(KEY)` is `undefined` for a service nobody declares, in the host and in the harness.

A key in `requires` is checked before any migration or setup, and a wrong order stops the start with `plugin <yours>: requires service <id>, which plugin <name> provides after it. Register plugin <name> before plugin <yours>, or read the service with services.lazy(KEY) from a callback that runs after startup.`
Calling the function `services.lazy(KEY)` returned during setup throws `service <id> is read through lazy() once every plugin is set up. Call it from a service's start or from a handler, not during setup.`
A `lazy` key that no registered plugin provides stops the start once every plugin is set up: `plugin <yours>: services.lazy reads service <id>, which no registered plugin provides.`

### A setup or a migration that throws

```text
plugin <name>: setup failed: <what the error said>. Fix the error, or remove the plugin.
plugin <name>: migration <migration> failed: <what the database said>. Fix the migration or restore the database, then start again.
```

A failed migration stops the start before any plugin is set up.
Migrations are idempotent, so start again once the cause is fixed.

### Configuration

| Message | Fix |
|---|---|
| `config <key>: unknown key. Did you mean "<closest>"? The keys here are ...` | Fix the spelling |
| `config <key>: required, expected <kind>. Add it to roundtable.config.ts.` | Add the setting, or fill in the variable in `.env` that it reads |
| `config model: expected <provider>/<id>, got "<value>". Write it like anthropic/claude-sonnet-5-5.` | Write the model as `<provider>/<id>` |
| `config locale: expected a locale, en or zh-TW, got "<value>". Fix the value in roundtable.config.ts.` | Use `en` or `zh-TW` |
| `config <key>: cannot read <path>: <reason>. Create the file or fix the path.` | Create the prompt file, or fix the path in `prompts` |
| `config adapters[<n>]: unknown adapter "<name>". The adapters are discord; …` | Use `discord()` from `pi-roundtable/discord`; a chat network that comes as a plugin, such as `webChat()`, belongs in `plugins` |
| `config adapters[<n>]: Discord is configured twice, …` | Keep the top-level `discord` or the Discord adapter, not both |
| `required tools are not registered: compact_session. compact_session comes from the Pi package pi-self-compact: …` | `bun add pi-self-compact`, and load it from a plugin with `piPackages: ["pi-self-compact"]`, as a project `roundtable init` creates does in `plugins/self-compact.ts` |

### Missing settings

| Message | Fix |
|---|---|
| `commands can be added only while plugins set up: the Discord plugin composed them in its preflight, …` | Call `commands.add` from `setup`, not from a service or a handler |
| `commands.add takes { module, rootOptions? }, …` | Give it a module with `commands()` and `handle(interaction)` |
| `migrations need a configured database` | Only reachable if you build the host yourself; `defineRoundtable` always sets it |
| `no database is configured` | In `testPlugin`, pass `{ database }` to a plugin that calls `context.database()` |
| `route <name> needs listener <id>, which is not configured` | Use the listener `public` |

## Changing the bot's language

The text the bot shows in Discord comes from a message catalog chosen by `locale` in `roundtable.config.ts`: `en` (the default) or `zh-TW`.
Both catalogs have the same keys.
Your own plugins' text is yours to write in any language.

## Consumer TypeScript configuration

The package ships `.ts`, so your compiler checks its source with your project's options.
`skipLibCheck` skips dependency declarations; package source is still checked.
The following configuration was tested against an installed tarball with TypeScript 5.9.3, and the package itself is checked with TypeScript 7.0.2:

```json
{
	"compilerOptions": {
		"target": "ESNext",
		"module": "Preserve",
		"moduleResolution": "bundler",
		"lib": ["ESNext"],
		"types": ["bun"],
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"noImplicitOverride": true,
		"verbatimModuleSyntax": true,
		"allowImportingTsExtensions": true,
		"skipLibCheck": true,
		"noEmit": true,
		"exactOptionalPropertyTypes": false,
		"noPropertyAccessFromIndexSignature": false
	}
}
```

Install TypeScript and `@types/bun` as development dependencies, as the generated project does.
Keep `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` disabled: a main-only consumer produces 3 and 132 package-source errors respectively when either is enabled, even with `skipLibCheck: true`.
The package doesn't override these flags; they are existing compatibility limits.
`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, and `noUncheckedSideEffectImports` were also tested enabled and pass.
Keep `skipLibCheck` enabled for this configuration; setting it to `false` produces 97 dependency-declaration errors in the example consumer.
Discord-facing signatures in `pi-roundtable/discord` and the composed slash commands in `pi-roundtable/testing` use the package's pinned `discord.js` types.
Use compatible types for panel rows and interaction handlers.
`discord.js` is a regular dependency, so it installs with `pi-roundtable` when your project imports either entry.

## Developing the core and a host together

A host pins an exact `pi-roundtable` version, so a change to the core reaches it only after a release.
To try a core change in a host first, link the checkout:

```sh
# in the pi-roundtable checkout
bun link
# in the host
bun link pi-roundtable
```

The host imports the checkout's source, so core edits take effect at once and the host's `bun run typecheck` and `bun test` check them.
The linked checkout resolves dependencies from its own `node_modules`, outside the host's `overrides`.
A host that depends on its own build of `pi-web-access` has two copies while linked.
When the change is ready, release the core, set the host's `pi-roundtable` to the new exact version, and run `bun install` to replace the link with the published package.
Run the host's checks again against that package.

## Name-to-entry index

Type-only exports require `import type` when `verbatimModuleSyntax` is enabled.
Each name is exported from exactly one entry; importing it from another causes a TypeScript and runtime error.
Import from the entries listed below; source area files are internal.

| Name | Entry | Kind |
|---|---|---|
| `AccessConfig` | `pi-roundtable` | type |
| `AccessOwner` | `pi-roundtable` | type |
| `AccessOwnerConfig` | `pi-roundtable` | type |
| `AccessRules` | `pi-roundtable` | type |
| `AccessTier` | `pi-roundtable` | type |
| `AccessTierConfig` | `pi-roundtable` | type |
| `ActionEvent` | `pi-roundtable` | type |
| `ActorFacts` | `pi-roundtable` | type |
| `AGENTS` | `pi-roundtable` | value |
| `AGENT_SERVER_PLUGIN` | `pi-roundtable` | value |
| `AGENT_SERVER_PRIORITY` | `pi-roundtable` | value |
| `AGENT_TEAM_SERVICE` | `pi-roundtable` | value |
| `AdapterConfig` | `pi-roundtable` | type |
| `Admission` | `pi-roundtable` | type |
| `Agent` | `pi-roundtable` | type |
| `AgentChange` | `pi-roundtable` | type |
| `AgentDirectory` | `pi-roundtable` | type |
| `AgentGroup` | `pi-roundtable` | type |
| `AgentRoutes` | `pi-roundtable` | type |
| `AgentRunError` | `pi-roundtable` | value |
| `AgentRuntime` | `pi-roundtable` | type |
| `AgentSeed` | `pi-roundtable` | type |
| `AgentServer` | `pi-roundtable` | type |
| `AgentSessions` | `pi-roundtable` | type |
| `AgentStatus` | `pi-roundtable` | type |
| `AgentTeam` | `pi-roundtable` | type |
| `AgentTools` | `pi-roundtable` | type |
| `AgentTurnScope` | `pi-roundtable` | type |
| `Approval` | `pi-roundtable` | type |
| `ApprovalDetails` | `pi-roundtable` | type |
| `ApprovalFile` | `pi-roundtable` | type |
| `ApprovalOptions` | `pi-roundtable` | type |
| `ApprovalWording` | `pi-roundtable` | type |
| `ApprovedBy` | `pi-roundtable` | type |
| `AskOption` | `pi-roundtable` | type |
| `AskSupport` | `pi-roundtable` | type |
| `AttachmentContent` | `pi-roundtable` | type |
| `AttachmentFailure` | `pi-roundtable` | type |
| `AttachmentFile` | `pi-roundtable` | type |
| `AttachmentPort` | `pi-roundtable` | type |
| `AttachmentRef` | `pi-roundtable` | type |
| `AttachmentRefusal` | `pi-roundtable` | value |
| `AttachmentRefusalCode` | `pi-roundtable` | type |
| `AttachmentRetention` | `pi-roundtable` | type |
| `AttachmentUpload` | `pi-roundtable` | type |
| `AttachmentsConfig` | `pi-roundtable` | type |
| `AutoApproval` | `pi-roundtable` | type |
| `AvatarMode` | `pi-roundtable` | type |
| `AgentWorkspace` | `pi-roundtable` | type |
| `AvatarStudio` | `pi-roundtable` | type |
| `PROMPTS` | `pi-roundtable` | value |
| `characterOf` | `pi-roundtable` | value |
| `isHelper` | `pi-roundtable` | value |
| `BACKGROUND_TURNS` | `pi-roundtable` | value |
| `CONVERSATIONS` | `pi-roundtable` | value |
| `BackgroundConfig` | `pi-roundtable` | type |
| `BackgroundRunsAs` | `pi-roundtable` | type |
| `BackgroundTarget` | `pi-roundtable` | type |
| `BackgroundTurn` | `pi-roundtable` | type |
| `BackgroundTurns` | `pi-roundtable` | type |
| `ChannelClaim` | `pi-roundtable` | type |
| `ChannelKey` | `pi-roundtable` | type |
| `ChatSurface` | `pi-roundtable` | type |
| `ClassedHold` | `pi-roundtable` | type |
| `ClientCallError` | `pi-roundtable` | type |
| `ClientCallOptions` | `pi-roundtable` | type |
| `ClientCallResult` | `pi-roundtable` | type |
| `ClientPart` | `pi-roundtable` | type |
| `ClientPort` | `pi-roundtable` | type |
| `ConfigError` | `pi-roundtable` | value |
| `ContextUse` | `pi-roundtable` | type |
| `Contribution` | `pi-roundtable` | type |
| `ConversationKind` | `pi-roundtable` | type |
| `ConversationMode` | `pi-roundtable` | type |
| `ConversationModes` | `pi-roundtable` | type |
| `ConversationPort` | `pi-roundtable` | type |
| `ConversationRecord` | `pi-roundtable` | type |
| `ConversationRegistration` | `pi-roundtable` | type |
| `ConversationRegistry` | `pi-roundtable` | type |
| `ConversationVisibility` | `pi-roundtable` | type |
| `ConversationsConfig` | `pi-roundtable` | type |
| `ConversationTurnInput` | `pi-roundtable` | type |
| `ConversationTurns` | `pi-roundtable` | type |
| `DELEGATION` | `pi-roundtable` | value |
| `DEFAULT_MAX_REQUEST_BODY_BYTES` | `pi-roundtable` | value |
| `DefineOverrides` | `pi-roundtable` | type |
| `DirectChannelProvider` | `pi-roundtable` | type |
| `DirectChannels` | `pi-roundtable` | type |
| `DirectReach` | `pi-roundtable` | type |
| `DefinedRoundtable` | `pi-roundtable` | type |
| `DelegationError` | `pi-roundtable` | value |
| `DelegationJob` | `pi-roundtable` | type |
| `DelegationOutcome` | `pi-roundtable` | type |
| `DelegationRequest` | `pi-roundtable` | type |
| `Delegator` | `pi-roundtable` | type |
| `DiscordConfig` | `pi-roundtable` | type |
| `DrainOptions` | `pi-roundtable` | type |
| `EventHandlers` | `pi-roundtable` | type |
| `EventSink` | `pi-roundtable` | type |
| `ExpireUsedOptions` | `pi-roundtable` | type |
| `ExpiredAttachments` | `pi-roundtable` | type |
| `GroupStatus` | `pi-roundtable` | type |
| `HeldActionStore` | `pi-roundtable` | type |
| `HeldCall` | `pi-roundtable` | type |
| `HelperTeam` | `pi-roundtable` | type |
| `HelpersConfig` | `pi-roundtable` | type |
| `HelpersEnded` | `pi-roundtable` | type |
| `HoldCheck` | `pi-roundtable` | type |
| `HoldContext` | `pi-roundtable` | type |
| `HoldDescription` | `pi-roundtable` | type |
| `HoldRefusal` | `pi-roundtable` | type |
| `HoldRule` | `pi-roundtable` | type |
| `HostEnv` | `pi-roundtable` | type |
| `HostEnvironment` | `pi-roundtable` | type |
| `HostStoppingError` | `pi-roundtable` | value |
| `HttpRoute` | `pi-roundtable` | type |
| `IDENTITY` | `pi-roundtable` | value |
| `IDENTITY_LINKS` | `pi-roundtable` | value |
| `IdentityError` | `pi-roundtable` | value |
| `IdentityLink` | `pi-roundtable` | type |
| `IdentityLinks` | `pi-roundtable` | type |
| `IdentityRef` | `pi-roundtable` | type |
| `IdentityService` | `pi-roundtable` | type |
| `ImageDrawer` | `pi-roundtable` | type |
| `InboundMessage` | `pi-roundtable` | type |
| `IntercomCard` | `pi-roundtable` | type |
| `InterimMessage` | `pi-roundtable` | type |
| `InterimPosts` | `pi-roundtable` | type |
| `InterimTextMode` | `pi-roundtable` | type |
| `Judge` | `pi-roundtable` | type |
| `JudgeError` | `pi-roundtable` | value |
| `JudgeModel` | `pi-roundtable` | type |
| `LateAnswer` | `pi-roundtable` | type |
| `LinkedSessions` | `pi-roundtable` | type |
| `LinkSource` | `pi-roundtable` | type |
| `ListenerAddress` | `pi-roundtable` | type |
| `ListenerConfig` | `pi-roundtable` | type |
| `LoadedSkill` | `pi-roundtable` | type |
| `Locale` | `pi-roundtable` | type |
| `LimitsConfig` | `pi-roundtable` | type |
| `LogEntry` | `pi-roundtable` | type |
| `LogFn` | `pi-roundtable` | type |
| `Logger` | `pi-roundtable` | type |
| `LOCAL_TEAM_ID` | `pi-roundtable` | value |
| `MEMORY` | `pi-roundtable` | value |
| `MAX_ATTACHMENT_BYTES` | `pi-roundtable` | value |
| `MODES` | `pi-roundtable` | value |
| `MEMORY_KINDS` | `pi-roundtable` | value |
| `Memory` | `pi-roundtable` | type |
| `MemoryError` | `pi-roundtable` | value |
| `MemoryKind` | `pi-roundtable` | type |
| `MemoryStore` | `pi-roundtable` | type |
| `Migration` | `pi-roundtable` | type |
| `MigrationError` | `pi-roundtable` | value |
| `MigrationReport` | `pi-roundtable` | type |
| `ModeChange` | `pi-roundtable` | type |
| `ModelImage` | `pi-roundtable` | type |
| `NO_ATTACHMENTS` | `pi-roundtable` | value |
| `NewAgent` | `pi-roundtable` | type |
| `NewSchedule` | `pi-roundtable` | type |
| `NotLinkedError` | `pi-roundtable` | value |
| `OWNER_TARGET` | `pi-roundtable` | value |
| `PERSONAL_TARGET` | `pi-roundtable` | value |
| `OutboundReply` | `pi-roundtable` | type |
| `PostAuthor` | `pi-roundtable` | type |
| `OwnerAnswer` | `pi-roundtable` | type |
| `OwnerPrompts` | `pi-roundtable` | type |
| `OwnerQuestion` | `pi-roundtable` | type |
| `PeerBotEntry` | `pi-roundtable` | type |
| `PeerBotsConfig` | `pi-roundtable` | type |
| `PendingConfirmation` | `pi-roundtable` | type |
| `PerPrincipalLimits` | `pi-roundtable` | type |
| `PersonDisplay` | `pi-roundtable` | type |
| `PersonProfiles` | `pi-roundtable` | type |
| `Persona` | `pi-roundtable` | type |
| `PlaceTarget` | `pi-roundtable` | type |
| `PluginContext` | `pi-roundtable` | type |
| `PluginIdentity` | `pi-roundtable` | type |
| `PluginError` | `pi-roundtable` | value |
| `Principal` | `pi-roundtable` | type |
| `ProfileRules` | `pi-roundtable` | type |
| `ProfileSource` | `pi-roundtable` | type |
| `ProfilesConfig` | `pi-roundtable` | type |
| `PromptDocumentSpec` | `pi-roundtable` | type |
| `PromptDocuments` | `pi-roundtable` | type |
| `PromptDocumentView` | `pi-roundtable` | type |
| `PromptHandle` | `pi-roundtable` | type |
| `PromptMemory` | `pi-roundtable` | type |
| `PromptScope` | `pi-roundtable` | type |
| `PromptSection` | `pi-roundtable` | type |
| `PromptTurn` | `pi-roundtable` | type |
| `PromptVersion` | `pi-roundtable` | type |
| `PromptWait` | `pi-roundtable` | type |
| `Prompts` | `pi-roundtable` | type |
| `Pronouns` | `pi-roundtable` | type |
| `ProviderError` | `pi-roundtable` | value |
| `Providers` | `pi-roundtable` | type |
| `Provisioning` | `pi-roundtable` | type |
| `ProvisioningRule` | `pi-roundtable` | type |
| `QueuePort` | `pi-roundtable` | type |
| `QUESTIONNAIRE_LIMITS` | `pi-roundtable` | value |
| `Questionnaire` | `pi-roundtable` | type |
| `QuestionnaireAnswer` | `pi-roundtable` | type |
| `Recurrence` | `pi-roundtable` | type |
| `ReferenceImage` | `pi-roundtable` | type |
| `ResolvedProviders` | `pi-roundtable` | type |
| `ResolvedSkill` | `pi-roundtable` | type |
| `RoleGrant` | `pi-roundtable` | type |
| `RoleSource` | `pi-roundtable` | type |
| `RoundEnd` | `pi-roundtable` | type |
| `RoundProgress` | `pi-roundtable` | type |
| `Roundtable` | `pi-roundtable` | value |
| `ReplyFile` | `pi-roundtable` | type |
| `ReplyFileError` | `pi-roundtable` | value |
| `REPLY_FILE_LIMITS` | `pi-roundtable` | value |
| `RoundtableConfig` | `pi-roundtable` | type |
| `RoundtableOptions` | `pi-roundtable` | type |
| `RegistrationReport` | `pi-roundtable` | type |
| `RoundtablePlugin` | `pi-roundtable` | type |
| `RouteKind` | `pi-roundtable` | type |
| `RouteSocket` | `pi-roundtable` | type |
| `RoutingConfig` | `pi-roundtable` | type |
| `RoutingTable` | `pi-roundtable` | type |
| `RuntimeDeps` | `pi-roundtable` | type |
| `RuntimeFactory` | `pi-roundtable` | type |
| `SCHEDULES` | `pi-roundtable` | value |
| `PRECHECKS` | `pi-roundtable` | value |
| `PROFILES` | `pi-roundtable` | value |
| `RUNTIME` | `pi-roundtable` | value |
| `PRECHECK_TIMEOUT_MS` | `pi-roundtable` | value |
| `Precheck` | `pi-roundtable` | type |
| `PrecheckContext` | `pi-roundtable` | type |
| `PrecheckFinding` | `pi-roundtable` | type |
| `PrecheckRegistry` | `pi-roundtable` | type |
| `PrecheckResult` | `pi-roundtable` | type |
| `PrecheckScope` | `pi-roundtable` | type |
| `PrecheckScriptContext` | `pi-roundtable` | type |
| `PrecheckScriptRunner` | `pi-roundtable` | type |
| `PrecheckTool` | `pi-roundtable` | type |
| `PRECHECK_SCRIPT_CHARS` | `pi-roundtable` | value |
| `PromptConflictError` | `pi-roundtable` | value |
| `SkillConflictError` | `pi-roundtable` | value |
| `SkillDocument` | `pi-roundtable` | type |
| `SKILLS` | `pi-roundtable` | value |
| `SINGLE_QUESTION` | `pi-roundtable` | value |
| `Schedule` | `pi-roundtable` | type |
| `ScheduleChange` | `pi-roundtable` | type |
| `ScheduleError` | `pi-roundtable` | value |
| `ScheduleStore` | `pi-roundtable` | type |
| `ScheduledOutcome` | `pi-roundtable` | type |
| `SelfLinkRules` | `pi-roundtable` | type |
| `Service` | `pi-roundtable` | type |
| `ServiceKey` | `pi-roundtable` | type |
| `ServiceStartOutcome` | `pi-roundtable` | type |
| `ServiceStartedEvent` | `pi-roundtable` | type |
| `Services` | `pi-roundtable` | type |
| `SessionContext` | `pi-roundtable` | type |
| `SessionConversation` | `pi-roundtable` | type |
| `SessionPlan` | `pi-roundtable` | type |
| `SessionTool` | `pi-roundtable` | type |
| `SessionToolSnapshot` | `pi-roundtable` | type |
| `SkillCatalogEntry` | `pi-roundtable` | type |
| `SkillRegistry` | `pi-roundtable` | type |
| `SkillVersion` | `pi-roundtable` | type |
| `WorkerSessions` | `pi-roundtable` | type |
| `WorkerSessionRequest` | `pi-roundtable` | type |
| `WORKER_SESSIONS` | `pi-roundtable` | value |
| `SkillSet` | `pi-roundtable` | type |
| `SkillSource` | `pi-roundtable` | type |
| `SkillsConfig` | `pi-roundtable` | type |
| `Speaker` | `pi-roundtable` | type |
| `SpeakerMemory` | `pi-roundtable` | type |
| `StoredAttachment` | `pi-roundtable` | type |
| `SurfacePort` | `pi-roundtable` | type |
| `SurfaceRouting` | `pi-roundtable` | type |
| `SurfaceThreads` | `pi-roundtable` | type |
| `SurfaceMessageEvents` | `pi-roundtable` | type |
| `ObserveFilter` | `pi-roundtable` | type |
| `MessageObserver` | `pi-roundtable` | type |
| `SYSTEM_PRINCIPAL` | `pi-roundtable` | value |
| `THE_SPEAKER` | `pi-roundtable` | value |
| `THREADS` | `pi-roundtable` | value |
| `TIERS` | `pi-roundtable` | value |
| `TeamAgentStatus` | `pi-roundtable` | type |
| `TeamStatus` | `pi-roundtable` | type |
| `ThinkingLevel` | `pi-roundtable` | type |
| `ThinkingSetting` | `pi-roundtable` | type |
| `Tier` | `pi-roundtable` | type |
| `TierConfig` | `pi-roundtable` | type |
| `ToolAttachment` | `pi-roundtable` | type |
| `ToolAttachmentInfo` | `pi-roundtable` | type |
| `ToolContribution` | `pi-roundtable` | type |
| `ToolOutput` | `pi-roundtable` | type |
| `ToolRefusal` | `pi-roundtable` | value |
| `ToolSelection` | `pi-roundtable` | type |
| `ToolSpec` | `pi-roundtable` | type |
| `ToolTierTable` | `pi-roundtable` | type |
| `ToolTiers` | `pi-roundtable` | type |
| `ToolTurn` | `pi-roundtable` | type |
| `TranscriptEntry` | `pi-roundtable` | type |
| `TransientTask` | `pi-roundtable` | type |
| `TurnAttachmentOptions` | `pi-roundtable` | type |
| `TurnAttachments` | `pi-roundtable` | type |
| `TurnConversation` | `pi-roundtable` | type |
| `TurnEndEvent` | `pi-roundtable` | type |
| `TurnProgress` | `pi-roundtable` | type |
| `TurnProgressEvent` | `pi-roundtable` | type |
| `TurnEvent` | `pi-roundtable` | type |
| `TurnRequest` | `pi-roundtable` | type |
| `TurnResult` | `pi-roundtable` | type |
| `TurnSelection` | `pi-roundtable` | type |
| `TurnLimit` | `pi-roundtable` | type |
| `TurnTimeout` | `pi-roundtable` | type |
| `TurnTimeoutEnd` | `pi-roundtable` | type |
| `TurnTimeoutError` | `pi-roundtable` | value |
| `WebSocketAccept` | `pi-roundtable` | type |
| `WebSocketRoute` | `pi-roundtable` | type |
| `WebSocketSendResult` | `pi-roundtable` | type |
| `Weekday` | `pi-roundtable` | type |
| `attachReplyFile` | `pi-roundtable` | value |
| `agentRoomKey` | `pi-roundtable` | value |
| `groupRoomKey` | `pi-roundtable` | value |
| `roomOf` | `pi-roundtable` | value |
| `promptScope` | `pi-roundtable` | value |
| `validateQuestionnaire` | `pi-roundtable` | value |
| `withReplyFiles` | `pi-roundtable` | value |
| `withdrawalNote` | `pi-roundtable` | value |
| `prepareImageBytes` | `pi-roundtable/kit` | value |
| `ImagePreparationError` | `pi-roundtable/kit` | value |
| `squarePng` | `pi-roundtable/kit` | value |
| `renderCharacterPng` | `pi-roundtable/kit` | value |
| `SQUARE_PNG_MAX_SIDE` | `pi-roundtable/kit` | value |
| `SquarePngOptions` | `pi-roundtable/kit` | type |
| `scrubDiagnostic` | `pi-roundtable/kit` | value |
| `channelKey` | `pi-roundtable` | value |
| `checkAnswer` | `pi-roundtable` | value |
| `checkQuestionnaireAnswer` | `pi-roundtable` | value |
| `definePlugin` | `pi-roundtable` | value |
| `defineRoundtable` | `pi-roundtable` | value |
| `defineTool` | `pi-roundtable` | value |
| `migrateDatabase` | `pi-roundtable` | value |
| `parseChannelKey` | `pi-roundtable` | value |
| `serviceKey` | `pi-roundtable` | value |
| `shapeFor` | `pi-roundtable` | value |
| `FakeDiscord` | `pi-roundtable/testing` | type |
| `FakeThreadHost` | `pi-roundtable/testing` | type |
| `OWNER_SPEAKER` | `pi-roundtable/testing` | value |
| `RecordedEvent` | `pi-roundtable/testing` | type |
| `ServicePair` | `pi-roundtable/testing` | type |
| `SurfaceContractAnswerer` | `pi-roundtable/testing` | type |
| `TEST_GUILD` | `pi-roundtable/testing` | value |
| `TestHost` | `pi-roundtable/testing` | type |
| `TestHostOptions` | `pi-roundtable/testing` | type |
| `TestLocale` | `pi-roundtable/testing` | type |
| `TestPluginOptions` | `pi-roundtable/testing` | type |
| `TestPluginResult` | `pi-roundtable/testing` | type |
| `TestStore` | `pi-roundtable/testing` | type |
| `UsePostgresOptions` | `pi-roundtable/testing` | type |
| `describeDb` | `pi-roundtable/testing` | value |
| `describeSurfaceContract` | `pi-roundtable/testing` | value |
| `checkSurfaceContract` | `pi-roundtable/testing` | value |
| `SurfaceContractFailure` | `pi-roundtable/testing` | type |
| `SurfaceContractSubject` | `pi-roundtable/testing` | type |
| `SurfaceObservation` | `pi-roundtable/testing` | type |
| `eagerText` | `pi-roundtable/testing` | value |
| `fakeDiscord` | `pi-roundtable/testing` | value |
| `fakeDiscordPoster` | `pi-roundtable/testing` | value |
| `FakeDiscordPoster` | `pi-roundtable/testing` | type |
| `FakePosterChannel` | `pi-roundtable/testing` | type |
| `FakePosterMessage` | `pi-roundtable/testing` | type |
| `fakePrecheck` | `pi-roundtable/testing` | value |
| `fakePrechecks` | `pi-roundtable/testing` | value |
| `FakePrecheck` | `pi-roundtable/testing` | type |
| `FakePrecheckAnswer` | `pi-roundtable/testing` | type |
| `fakeScriptRunner` | `pi-roundtable/testing` | value |
| `FakeScriptAnswer` | `pi-roundtable/testing` | type |
| `FakeScriptRunner` | `pi-roundtable/testing` | type |
| `fakeThreads` | `pi-roundtable/testing` | value |
| `openTestStore` | `pi-roundtable/testing` | value |
| `servicePair` | `pi-roundtable/testing` | value |
| `partial` | `pi-roundtable/testing` | value |
| `requireDatabase` | `pi-roundtable/testing` | value |
| `recordingLogger` | `pi-roundtable/testing` | value |
| `RecordingLogger` | `pi-roundtable/testing` | type |
| `RecordedLog` | `pi-roundtable/testing` | type |
| `silentLogger` | `pi-roundtable/testing` | value |
| `testDatabaseUrl` | `pi-roundtable/testing` | value |
| `testHost` | `pi-roundtable/testing` | value |
| `testPlugin` | `pi-roundtable/testing` | value |
| `useEagerCatalog` | `pi-roundtable/testing` | value |
| `usePostgresForTests` | `pi-roundtable/testing` | value |
| `useTestLocale` | `pi-roundtable/testing` | value |
| `AUTO_THINKING` | `pi-roundtable/kit` | value |
| `AgentCategory` | `pi-roundtable/kit` | type |
| `AgentChannelLookup` | `pi-roundtable/kit` | type |
| `AgentChannels` | `pi-roundtable/kit` | type |
| `AgentError` | `pi-roundtable/kit` | value |
| `AgentModels` | `pi-roundtable/kit` | type |
| `AgentOps` | `pi-roundtable/kit` | type |
| `AgentPost` | `pi-roundtable/kit` | type |
| `AgentTurnRunner` | `pi-roundtable/kit` | type |
| `AssistantLike` | `pi-roundtable/kit` | type |
| `Backlog` | `pi-roundtable/kit` | type |
| `CODEX_IMAGES_PROVIDER` | `pi-roundtable/kit` | value |
| `CODEX_IMAGE_MODEL` | `pi-roundtable/kit` | value |
| `CardLimits` | `pi-roundtable/kit` | type |
| `CategoryLayout` | `pi-roundtable/kit` | type |
| `ChannelMessage` | `pi-roundtable/kit` | type |
| `ChannelQueue` | `pi-roundtable/kit` | type |
| `ChoiceAnswer` | `pi-roundtable/kit` | type |
| `ChoiceQuestion` | `pi-roundtable/kit` | type |
| `CodexFetch` | `pi-roundtable/kit` | type |
| `CodexImage` | `pi-roundtable/kit` | type |
| `CodexImageRequest` | `pi-roundtable/kit` | type |
| `CodexImagesOptions` | `pi-roundtable/kit` | type |
| `DELEGATE_TOOL` | `pi-roundtable/kit` | value |
| `DELEGATE_TOOL_SPEC` | `pi-roundtable/kit` | value |
| `DashboardBoard` | `pi-roundtable/kit` | type |
| `DelegationWorker` | `pi-roundtable/kit` | type |
| `DispatchThread` | `pi-roundtable/kit` | type |
| `DispatchThreads` | `pi-roundtable/kit` | type |
| `DispatchThreadsOptions` | `pi-roundtable/kit` | type |
| `EffortBrief` | `pi-roundtable/kit` | type |
| `EffortJudgeOptions` | `pi-roundtable/kit` | type |
| `EffortLevel` | `pi-roundtable/kit` | type |
| `EffortPicker` | `pi-roundtable/kit` | type |
| `EffortPolicy` | `pi-roundtable/kit` | type |
| `EffortRequest` | `pi-roundtable/kit` | type |
| `EffortRule` | `pi-roundtable/kit` | type |
| `GroupMessage` | `pi-roundtable/kit` | type |
| `ImageNotGeneratedError` | `pi-roundtable/kit` | value |
| `JUDGE_WORK` | `pi-roundtable/kit` | value |
| `JevJudgeOptions` | `pi-roundtable/kit` | type |
| `McpEndpoint` | `pi-roundtable/kit` | type |
| `ModelRef` | `pi-roundtable/kit` | type |
| `OwnerIdentity` | `pi-roundtable/kit` | type |
| `Notifier` | `pi-roundtable/kit` | type |
| `OwnerNotifier` | `pi-roundtable/kit` | type |
| `PreviousTurn` | `pi-roundtable/kit` | type |
| `PromptSlot` | `pi-roundtable/kit` | type |
| `PushPolicy` | `pi-roundtable/kit` | type |
| `SCHEDULE_TOOLS` | `pi-roundtable/kit` | value |
| `SHELL_TOOLS` | `pi-roundtable/kit` | value |
| `SKILL_LIST_TOOL` | `pi-roundtable/kit` | value |
| `createCodexImages` | `pi-roundtable/kit` | value |
| `drawCodexImage` | `pi-roundtable/kit` | value |
| `jevJudge` | `pi-roundtable/kit` | value |
| `packageDir` | `pi-roundtable/kit` | value |
| `serveUnix` | `pi-roundtable/kit` | value |
| `ScheduleToolContext` | `pi-roundtable/kit` | type |
| `ScheduleToolName` | `pi-roundtable/kit` | type |
| `ScheduleToolSpec` | `pi-roundtable/kit` | type |
| `ScheduleToolWording` | `pi-roundtable/kit` | type |
| `ScoreQuestion` | `pi-roundtable/kit` | type |
| `SpeakerFacts` | `pi-roundtable/kit` | type |
| `SpeakerPolicy` | `pi-roundtable/kit` | type |
| `THINKING_LEVELS` | `pi-roundtable/kit` | value |
| `YOLO_CARDED_SHELL_CLASSES` | `pi-roundtable/kit` | value |
| `TextToolDef` | `pi-roundtable/kit` | type |
| `ThinkingPicker` | `pi-roundtable/kit` | type |
| `ThreadHost` | `pi-roundtable/kit` | type |
| `ToolInput` | `pi-roundtable/kit` | type |
| `VirtualServer` | `pi-roundtable/kit` | type |
| `YesNoQuestion` | `pi-roundtable/kit` | type |
| `activeToolsExtension` | `pi-roundtable/kit` | value |
| `answersAuthor` | `pi-roundtable/kit` | value |
| `approvalCard` | `pi-roundtable/kit` | value |
| `approvalDetails` | `pi-roundtable/kit` | value |
| `archiveSessions` | `pi-roundtable/kit` | value |
| `attachmentsOf` | `pi-roundtable/kit` | value |
| `callScheduleTool` | `pi-roundtable/kit` | value |
| `canonicalJson` | `pi-roundtable/kit` | value |
| `channelQueue` | `pi-roundtable/kit` | value |
| `channelSegment` | `pi-roundtable/kit` | value |
| `checkRepoName` | `pi-roundtable/kit` | value |
| `discordKey` | `pi-roundtable/kit` | value |
| `effortJudge` | `pi-roundtable/kit` | value |
| `formatModelRef` | `pi-roundtable/kit` | value |
| `headline` | `pi-roundtable/kit` | value |
| `holdChain` | `pi-roundtable/kit` | value |
| `HOLD_DESCRIBE_TIMEOUT_MS` | `pi-roundtable/kit` | value |
| `COMPACT_HEADROOM_TOKENS` | `pi-roundtable/kit` | value |
| `CompactionTiers` | `pi-roundtable/kit` | value |
| `compactionEngine` | `pi-roundtable/kit` | value |
| `HARD_COMPACT_TOKENS` | `pi-roundtable/kit` | value |
| `SOFT_COMPACT_TOKENS` | `pi-roundtable/kit` | value |
| `summaryProjection` | `pi-roundtable/kit` | value |
| `privateCompaction` | `pi-roundtable/kit` | value |
| `memoryProjection` | `pi-roundtable/kit` | value |
| `hidesPrivateExchange` | `pi-roundtable/kit` | value |
| `MemoryView` | `pi-roundtable/kit` | type |
| `MEMORY_TURN_ENTRY` | `pi-roundtable/kit` | value |
| `recordMemoryTurn` | `pi-roundtable/kit` | value |
| `carriesMemory` | `pi-roundtable/kit` | value |
| `bridgeHistoryHidesMemory` | `pi-roundtable/kit` | value |
| `CompactionEngine` | `pi-roundtable/kit` | type |
| `CompactionHistory` | `pi-roundtable/kit` | type |
| `LatestCompaction` | `pi-roundtable/kit` | type |
| `isRuleLoad` | `pi-roundtable/kit` | value |
| `InterimPoster` | `pi-roundtable/kit` | value |
| `InterimPosterOptions` | `pi-roundtable/kit` | type |
| `OpsAlerts` | `pi-roundtable/kit` | value |
| `OpsAlertsOptions` | `pi-roundtable/kit` | type |
| `OpsAlert` | `pi-roundtable/kit` | type |
| `OpsResolution` | `pi-roundtable/kit` | type |
| `OpsSeverity` | `pi-roundtable/kit` | type |
| `OpsSink` | `pi-roundtable/kit` | type |
| `OpsRaiseOptions` | `pi-roundtable/kit` | type |
| `OpsAlertKind` | `pi-roundtable/kit` | type |
| `JEV_COMPACTION_ENGINE` | `pi-roundtable/kit` | value |
| `JEV_GOAL` | `pi-roundtable/kit` | value |
| `JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS` | `pi-roundtable/kit` | value |
| `jevCompact` | `pi-roundtable/kit` | value |
| `jevCompactionExtension` | `pi-roundtable/kit` | value |
| `jevCompactor` | `pi-roundtable/kit` | value |
| `JevCompactInput` | `pi-roundtable/kit` | type |
| `JevCompactOptions` | `pi-roundtable/kit` | type |
| `JevCompactOutcome` | `pi-roundtable/kit` | type |
| `JevCompactor` | `pi-roundtable/kit` | type |
| `JevCompactRequest` | `pi-roundtable/kit` | type |
| `JevExtensionOptions` | `pi-roundtable/kit` | type |
| `JevSkipReason` | `pi-roundtable/kit` | type |
| `isScheduleTool` | `pi-roundtable/kit` | value |
| `lastAssistant` | `pi-roundtable/kit` | value |
| `mcpAdapterExtension` | `pi-roundtable/kit` | value |
| `mcpExtension` | `pi-roundtable/kit` | value |
| `oidcIdentity` | `pi-roundtable/kit` | value |
| `oidcProvider` | `pi-roundtable/kit` | value |
| `outcome` | `pi-roundtable/kit` | value |
| `ownerAttachmentDir` | `pi-roundtable/kit` | value |
| `parseModelRef` | `pi-roundtable/kit` | value |
| `promptSlot` | `pi-roundtable/kit` | value |
| `quietLinks` | `pi-roundtable/kit` | value |
| `readAttachmentExtension` | `pi-roundtable/kit` | value |
| `requiredString` | `pi-roundtable/kit` | value |
| `runWorkerTask` | `pi-roundtable/kit` | value |
| `scheduleToolSpecs` | `pi-roundtable/kit` | value |
| `searchTerms` | `pi-roundtable/kit` | value |
| `settleTurn` | `pi-roundtable/kit` | value |
| `shellHoldRule` | `pi-roundtable/kit` | value |
| `shellHoldRuleFor` | `pi-roundtable/kit` | value |
| `skillListExtension` | `pi-roundtable/kit` | value |
| `splitReply` | `pi-roundtable/kit` | value |
| `stringList` | `pi-roundtable/kit` | value |
| `textOf` | `pi-roundtable/kit` | value |
| `textToolsExtension` | `pi-roundtable/kit` | value |
| `thinkingLabel` | `pi-roundtable/kit` | value |
| `thinkingLine` | `pi-roundtable/kit` | value |
| `toolError` | `pi-roundtable/kit` | value |
| `toolText` | `pi-roundtable/kit` | value |
| `withAttachmentsBlock` | `pi-roundtable/kit` | value |
| `withReference` | `pi-roundtable/kit` | value |
| `within` | `pi-roundtable/kit` | value |
| `workTimeout` | `pi-roundtable/kit` | value |
| `zonedStamp` | `pi-roundtable/kit` | value |
| `AgentPanel` | `pi-roundtable/discord` | type |
| `AgentPanelMessage` | `pi-roundtable/discord` | type |
| `AgentPanelOptions` | `pi-roundtable/discord` | type |
| `CHANNEL_CONTEXT_DEFAULTS` | `pi-roundtable/discord` | value |
| `CHANNEL_OPERATIONS` | `pi-roundtable/discord` | value |
| `CHANNEL_TOOLS` | `pi-roundtable/discord` | value |
| `ChannelContext` | `pi-roundtable/discord` | type |
| `ChannelContextAttachment` | `pi-roundtable/discord` | type |
| `ChannelContextAttachmentOptions` | `pi-roundtable/discord` | type |
| `ChannelContextMessage` | `pi-roundtable/discord` | type |
| `ChannelContextOptions` | `pi-roundtable/discord` | type |
| `formatChannelContext` | `pi-roundtable/discord` | value |
| `ChannelExecutor` | `pi-roundtable/discord` | type |
| `ChannelInfo` | `pi-roundtable/discord` | type |
| `ChannelOperation` | `pi-roundtable/discord` | type |
| `ChannelTool` | `pi-roundtable/discord` | type |
| `ChannelToolError` | `pi-roundtable/discord` | value |
| `CommandGuard` | `pi-roundtable/discord` | type |
| `CommandGuardOptions` | `pi-roundtable/discord` | type |
| `CommandRegistrar` | `pi-roundtable/discord` | type |
| `CommandRoot` | `pi-roundtable/discord` | type |
| `ComposedCommands` | `pi-roundtable/discord` | type |
| `DISCORD` | `pi-roundtable/discord` | value |
| `DISCORD_ADMIN_TOOLS` | `pi-roundtable/discord` | value |
| `DiscordActor` | `pi-roundtable/discord` | type |
| `DiscordAdapterConfig` | `pi-roundtable/discord` | type |
| `DiscordConnection` | `pi-roundtable/discord` | type |
| `DiscordServices` | `pi-roundtable/discord` | type |
| `DISCORD_LIMITS` | `pi-roundtable/discord` | value |
| `DiscordPosterError` | `pi-roundtable/discord` | value |
| `CardButton` | `pi-roundtable/discord` | type |
| `CardLink` | `pi-roundtable/discord` | type |
| `CardPicture` | `pi-roundtable/discord` | type |
| `CardSelect` | `pi-roundtable/discord` | type |
| `CategoryChannel` | `pi-roundtable/discord` | type |
| `DiscordCard` | `pi-roundtable/discord` | type |
| `DiscordFailure` | `pi-roundtable/discord` | type |
| `DiscordMessage` | `pi-roundtable/discord` | type |
| `DiscordPoster` | `pi-roundtable/discord` | type |
| `DiscordReason` | `pi-roundtable/discord` | type |
| `PostedMessage` | `pi-roundtable/discord` | type |
| `PosterFile` | `pi-roundtable/discord` | type |
| `RecentMessage` | `pi-roundtable/discord` | type |
| `ThreadCloser` | `pi-roundtable/discord` | type |
| `ThreadState` | `pi-roundtable/discord` | type |
| `WebhookCardPost` | `pi-roundtable/discord` | type |
| `WebhookPost` | `pi-roundtable/discord` | type |
| `InteractionContribution` | `pi-roundtable/discord` | type |
| `InteractionModule` | `pi-roundtable/discord` | type |
| `ManagedChannel` | `pi-roundtable/discord` | type |
| `OPERATION_PERMISSIONS` | `pi-roundtable/discord` | value |
| `OwnerCommandHandlers` | `pi-roundtable/discord` | type |
| `OwnerFacingError` | `pi-roundtable/discord` | value |
| `OwnerOperations` | `pi-roundtable/discord` | type |
| `PanelContent` | `pi-roundtable/discord` | type |
| `RootOption` | `pi-roundtable/discord` | type |
| `agentPanel` | `pi-roundtable/discord` | value |
| `commandGuard` | `pi-roundtable/discord` | value |
| `composeCommands` | `pi-roundtable/discord` | value |
| `discord` | `pi-roundtable/discord` | value |
| `ephemeralPanel` | `pi-roundtable/discord` | value |
| `fetchManagedChannel` | `pi-roundtable/discord` | value |
| `groupOption` | `pi-roundtable/discord` | value |
| `isChannelOperation` | `pi-roundtable/discord` | value |
| `operationLabel` | `pi-roundtable/discord` | value |
| `ownerCommandModule` | `pi-roundtable/discord` | value |
| `ownerPanel` | `pi-roundtable/discord` | value |
| `ownerPanels` | `pi-roundtable/discord` | value |
| `ownerRootCommand` | `pi-roundtable/discord` | value |
| `parseChannelTool` | `pi-roundtable/discord` | value |
| `plain` | `pi-roundtable/discord` | value |
| `replyWithPanels` | `pi-roundtable/discord` | value |
| `withChannelContext` | `pi-roundtable/discord` | value |
| `withChannelContextImages` | `pi-roundtable/discord` | value |
| `AVATAR_STATES` | `pi-roundtable/characters` | value |
| `CATALOG` | `pi-roundtable/characters` | value |
| `CLASS_IDS` | `pi-roundtable/characters` | value |
| `CharacterError` | `pi-roundtable/characters` | value |
| `EAST_ASIAN_SKINS` | `pi-roundtable/characters` | value |
| `EXPRESSIONS` | `pi-roundtable/characters` | value |
| `STATE_EXPRESSION` | `pi-roundtable/characters` | value |
| `accentOf` | `pi-roundtable/characters` | value |
| `characterCss` | `pi-roundtable/characters` | value |
| `checkSkins` | `pi-roundtable/characters` | value |
| `composeSvg` | `pi-roundtable/characters` | value |
| `parseCharacter` | `pi-roundtable/characters` | value |
| `readCharacter` | `pi-roundtable/characters` | value |
| `resolveCharacter` | `pi-roundtable/characters` | value |
| `suggestCharacter` | `pi-roundtable/characters` | value |
| `AccessoryId` | `pi-roundtable/characters` | type |
| `AvatarState` | `pi-roundtable/characters` | type |
| `BeardId` | `pi-roundtable/characters` | type |
| `CharacterColors` | `pi-roundtable/characters` | type |
| `CharacterInput` | `pi-roundtable/characters` | type |
| `CharacterLook` | `pi-roundtable/characters` | type |
| `CharacterSpec` | `pi-roundtable/characters` | type |
| `ClassId` | `pi-roundtable/characters` | type |
| `ComposeOptions` | `pi-roundtable/characters` | type |
| `Expression` | `pi-roundtable/characters` | type |
| `HairId` | `pi-roundtable/characters` | type |
| `HatId` | `pi-roundtable/characters` | type |
| `Hex` | `pi-roundtable/characters` | type |
| `OutfitId` | `pi-roundtable/characters` | type |
| `PaletteName` | `pi-roundtable/characters` | type |
| `PropId` | `pi-roundtable/characters` | type |
