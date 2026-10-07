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

Everything a plugin author needs comes from four entries, and nothing else can be imported from the package:

| Entry | What it exports |
|---|---|
| `pi-roundtable` | `definePlugin`, `defineTool`, `defineRoundtable`, `ToolRefusal`, `PluginError`, `NotLinkedError`, `Roundtable`, and the types (`Tier`, `Speaker`, `Contribution`, `PluginContext`, and so on) |
| `pi-roundtable/testing` | Fixtures for testing plugins, without Discord or a database unless the test explicitly opens one; `testHost` names a few discord.js types (`ComposedCommands`, `CommandGuard`, `InteractionModule`, `RootOption`) so a test can drive the composed slash commands |
| `pi-roundtable/kit` | Helpers for channel claims, tools, presentation, worker processes, and naming existing core parts |
| `pi-roundtable/discord` | The entry built on discord.js types: the `DISCORD` service (slash commands, the owner guard), owner-command and panel helpers, the agent panel, and the channel-operation tables |

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

#### Helpers for a Pi session of your own

Use the kit's building blocks for a plugin that runs Pi itself, such as a coding worker:

- MCP: `mcpExtension` and `VirtualServer` expose MCP servers to a session, and `mcpAdapterExtension` and `readAttachmentExtension` do the same inside an out-of-process worker.
- Admitted media: `prepareImageBytes(data, contentType)` prepares raster bytes without reopening a guest-writable path; supported small images remain unchanged, and larger sides/encoded images are downsized to JPEG at a 2,000 px long side.
  Before any native decoder, it refuses more than 25 MiB of encoded bytes or 64 million decoded pixels, including aggregate GIF/WebP frame dimensions.
  `ImagePreparationError.reason` is `byte-limit`, `pixel-limit`, or `invalid-image`; hosts can localize refusals without parsing native decoder errors.
  Ordinary 48 MP images and thin 9000×1 images remain admitted.
  This helper is not a downloader or filesystem validator.
- Work: `promptSlot` (how a run asks the owner while it works), `workTimeout` (a time limit that does not count the time spent waiting on the owner), `runWorkerTask`, `archiveSessions`, and `approvalCard` and `canonicalJson` for the cards of held actions.
- Diagnostics: `scrubDiagnostic(text, max = 600)` masks credentials (URL userinfo, token shapes, secret-named assignments and JSON fields, `Authorization`/`Cookie`/`x-api-key` headers, JWTs, PEM blocks), turns control characters other than tab and newline into spaces, and cuts the result at `max` characters.
  It scans only the first `max * 4` characters (at least 4,096), in linear time, so pass it git, gh or provider error text before showing that text to a user.
- Shell: `SHELL_TOOLS`, and `shellHoldRule` and `shellHoldRuleFor(policy)`, the hold rule that keeps risky host-shell commands behind the owner's approval; see [the shell rule](#the-shell-rule).
- Tools: `textToolsExtension`, `requiredString`, `stringList` (with `toolText` and `toolError`) for tools that return text.
- Mirroring a built-in tool in a worker that cannot reach the host: `SCHEDULE_TOOLS`, `scheduleToolSpecs({ locale, timeZone })`, `isScheduleTool`, `callScheduleTool`, `DELEGATE_TOOL` and `DELEGATE_TOOL_SPEC`.
  The specs take the locale and time zone for their descriptions, so the worker needs no process-wide setting.
- Compaction: `CompactionTiers` gives a session the core's compaction tiers (`settings()` for Pi's `SettingsManager`, `wrapCompactor(factory, onBypass)` to hold a compaction extension back past the ceiling, `latest()`), with `SOFT_COMPACT_TOKENS` (300,000), `HARD_COMPACT_TOKENS` (500,000), `COMPACT_HEADROOM_TOKENS` (50,000), `compactionEngine(details, engine)` and the types `CompactionEngine`, `CompactionHistory` and `LatestCompaction`.
- Jev compaction: `jevCompact(input, options)` compacts through Jev (pi-jev-compaction 1.0.0) and returns `{ compaction }` or `{ skipped, detail? }` (a `JevSkipReason`: pi-jev-compaction's fallbacks `no_key`, `aborted`, `nothing_to_compact`, `no_candidates`, `cannot_fit`, `jev_error`, `reduction_too_small`, or `previous_summary_too_large`), for Pi's own summary to run instead.
  Its summary carries the previous summary once, as the transcript's `[previous compaction]` message, with `estimatedTokensAfter` measured on the final text; a previous summary over `previousSummaryLimitTokens` (default `JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS`, 60,000) skips without calling Jev, so Pi's summary condenses the chain.
  Jev judges with `goal` (default `JEV_GOAL`: keep the tool results that set rules still in force, drop stale lookups, listings and finished edits), and the summary ends with a `## Rules loaded before this compaction` section naming each rule load among the summarized messages (tool name and JSON arguments cut at 200 characters) for the agent to load again; `ruleLoad(tool, args)` picks them (default `isRuleLoad`: tools ending in `invoke-skill` or `get-system-prompt`, and tools ending in `read` whose `path` is a `SKILL.md`, an `AGENTS.md` or under `.agents/skills/`).
  `config` passes pi-jev-compaction's settings (`apiKey`, `model`, thresholds) over its config file and environment; `asker` replaces Jev's service, for tests.
  The API key is optional: without one, `jevCompact` skips with `no_key` without calling Jev, and compaction is Pi's own summary.
  Two adapters log each skip as `Jev leaves the compaction to Pi's summary` with `reason`, `detail` and `tokensBefore` through the `logger` they take: `jevCompactionExtension({ logger, ...options })`, the `compaction` session tool's extension, placed as `session.compaction.wrap(jevCompactionExtension({ logger }))` under the engine `JEV_COMPACTION_ENGINE` (`pi-jev-compaction`), and `jevCompactor({ logger, ...options })`, a `JevCompactor` for pi-roundtable-sandbox's `compaction` option that returns the compaction or `undefined` and logs with the `channel`.
  A `no_key` skip is logged once per adapter, as `Jev is not configured, so compaction uses Pi's summary`, and then not again; every other skip is logged each time.
  The types are `JevCompactInput`, `JevCompactOptions`, `JevCompactOutcome`, `JevCompactor`, `JevCompactRequest`, `JevExtensionOptions` and `JevSkipReason`.
- Effort: `effortJudge` picks a turn's thinking level from a message with your own brief (`EffortBrief`, `JUDGE_WORK`).
- Presentation and small helpers: `thinkingLine`, `zonedStamp(date, timeZone)`, `channelQueue()` (a queue of your own, so work does not wait behind a running turn), `checkRepoName` and `SKILL_LIST_TOOL` with `skillListExtension` for repositories and skills, and `searchTerms` for memory search.

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
	preflight() {},            // optional: a check that runs before anything starts
	setup(context) {           // required: returns the parts the plugin adds
		return { /* parts */ };
	},
});
```

`definePlugin` checks the name and the presence of `setup`, then returns the typed object you gave it.
Errors point to the plugin definition.

A plugin whose `setup` returns `{}` and has no migrations, providers, or hooks stops startup (see [Errors](#errors-and-their-fixes)).

### The context

`setup` receives a `PluginContext`:

| Field | What it is |
|---|---|
| `logger` | The host's logger with `plugin: <your name>` on every line; each line is JSON on stdout. Its type is `Logger` (`debug`, `info`, `warn`, `error`, `fatal`, `child(fields)`), which a pino logger satisfies |
| `env` | The host's own environment for the run: `locale`, `timeZone` (an IANA zone), and `now()`; read the zone from here rather than from the process |
| `database()` | The host's one PostgreSQL connection (a Bun `SQL`), already migrated |
| `toolTiers` | What each tool needs; ask it when a tool is used, not during setup |
| `events` | Where the core reports turns and team changes to every plugin's handlers |
| `providers` | Each provider slot, from the plugin that fills it or the core's default; `providers.filled` is the set of slots a plugin fills |
| `apiKey(provider)` | The credential the host's model login holds for a provider such as `openai-codex`, the same login the agents use. It resolves to `undefined` when the host has none for that provider and never throws for that. The value is a secret: keep it out of logs and error messages. Read it when you use it rather than keeping it, since a login may refresh its token |
| `queue` | The one channel queue that every conversation and channel operation shares |
| `services` | The services plugins provide to each other, read by key: `services.get(SCHEDULES)`; see [services](#services-what-plugins-provide-to-each-other) |
| `surfaces` | Every contributed [chat surface](#surfaces-a-chat-network-of-your-own), chosen by the prefix of a channel key: `of`, `sendReply`, `startTyping`, `showStop`, `react`, `unreact`, `prompts` |
| `turns` | Runs one turn of a conversation your claim owns, over the runtime and the surfaces: [`turns.run`](#personas-and-contextturns-conversations-of-a-kind-of-your-own) |
| `sessions()`, `conversations`, `surfaces`, `turns`, `dashboard()` | Linked once every plugin has been set up; calling them during `setup` throws `NotLinkedError` |

`sessions()`, `conversations`, `surfaces`, `turns`, and `dashboard()` are available from a service's `start`, an event handler, or a claim's turn.

Use `QueuePort` from the main entry for `context.queue`; the kit's `ChannelQueue` is also type-only.

`context.core` of 0.1.0 is gone: reading it throws a `PluginError` that names `context.services`.

### Logging and error reports

`context.logger` is a child of the host's logger and adds `plugin: <your plugin's name>` to each line in the journal.
`Logger` has five levels and `child(fields)`; you can pass an existing pino logger as `DefineOverrides.logger`.

With `defineRoundtable`, the host's logger sends every `error` and `fatal` line to the ops agent named by `config.ops.agent`, which reports it in its channel, or, with `config.ops.conversation`, to that conversation as a visible message and a report turn its claim answers.
The report turn is a background turn of the `owner` target, so the host does not start, with a `ConfigError` naming `config ops.conversation` and the reason, when no chat surface serves the key, no plugin's claim owns it, no plugin contributes the `owner` background target, or the claim that owns it takes no background turns (has no `background`); a report is then never only logged.
On a host without Discord no plugin contributes `owner` unless one of yours does, so `ops.conversation` needs such a plugin there.
The web chat takes no error reports in 0.8: it posts only to a conversation a signed-in person opened, and its claim takes no background turns, so `web:<id>` fails at startup; name a conversation of another surface, or an agent with Discord.
It then calls `DefineOverrides.errorSink(entry)` if you supply one; this function must not throw.
A logger you supply reaches the ops agent and `errorSink` only if it forwards its error lines there.
The report names the plugin next to `app` and `module`; the same error is reported at most once an hour, regardless of which plugin wrote it.

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
| `IDENTITY` | `IdentityService` | `identity` | Who the host serves: `resolve(facts, { conversation }?)` gives the `Speaker` with its `principalId` behind a surface's `ActorFacts`, or undefined; `principal(id)`, `tierOf(principalId, { conversation, facts }?)`, `speakerFor(principalId, tier?)`, `owners()`, and `principals`, the `PrincipalStore` of principals, identity links, and lasting roles. `SYSTEM_PRINCIPAL` is the host's own |
| `CONVERSATIONS` | `ConversationRegistry` | `conversations` | The conversations run through `context.turns`: `register`, `get(key)`, `list({ principal }?)`, `setTitle(key, title)`; each a `ConversationRecord` of `key`, `surface`, `kind`, `visibility` (`"private"` or `"shared"`), `principalId?`, `title?`, `createdAt`, `lastActiveAt` |
| `RUNTIME` | `AgentRuntime` | `runtime` | The runtime every conversation turn runs on, the agent server's and `context.turns`': the `runtime` slot's when a plugin fills it, Pi's otherwise |
| `AGENTS` | `AgentServer` | `agent-server` | The `team` (`AgentTeam`), the read-only `directory` (`AgentDirectory`), the `runtime` every agent turn runs on (the same one `RUNTIME` provides), `approvals` (whether the owner's reply approves held actions), and `avatars` (`AvatarStudio`) |
| `SKILLS` | `SkillRegistry` | `skills` (an addon) | What agents carry: `carried`, `carriedNames`, `describeCarried`, `catalog`, `list`, `linkedFrom`, `checkRegistered`, `link`, `attach` |
| `SCHEDULES` | `ScheduleStore` | `schedule-store` | The stored schedules: `create`, `get`, `forChannel`, `all`, `update`, `remove`, `due`, `claim`, `recordStatus` |
| `PRECHECKS` | `PrecheckRegistry` | `prechecks` | The host's named [prechecks](#prechecks-wake-a-schedule-only-when-it-has-work): `register`, `get`, `list`; and the runner of agents' precheck scripts: `useScriptRunner`, `scriptRunner` |
| `MEMORY` | `MemoryStore` | `memory` (an addon) | `forSpeaker(id)` gives that speaker's `SpeakerMemory`: `list`, `forPrompt`, `add`, `search`, `update`, `removeById`, `remove`; `MEMORY_KINDS` is `core`, `note`, `event` |
| `BACKGROUND_TURNS` | `BackgroundTurns` | `modules` | Turns nobody wrote: `runScheduled`, `runDelegated`, `runErrorReport` |
| `DELEGATION` | `Delegator` | `modules` | `start(request)` a background task, `runningChannels()`, `idle()` |

The data types the ports use (`Schedule`, `NewSchedule`, `Agent`, `AgentGroup`, `TeamStatus`, `Memory`, `SkillSet`, `DelegationJob`, and so on) are in the main entry too.
Your plugins run after the built-ins, so they can read every key above.
The Discord connection's key, `DISCORD`, is in the Discord entry, because its port names discord.js types: `DiscordServices` has `connection`, `commands`, `guard`, and `threads` (see [`commands.add`](#slash-commands-commandsadd)).

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
| Memory | `memory` (provides `MEMORY`) | `memory: false` | The memory table, the `memory_add`, `memory_search` and `memory_remove` tools, and the memory block of every system prompt | No memory tools and no block; the table is left as it is |
| Skills | `skills` (provides `SKILLS`) | `skills: false` | The skill tables, the skill tools of agent sessions (`skill_list`, `skill_link`, `skill_create`, `agent_skills`, and the rest), and the skills every agent carries, `writing-skills` included | No skill tools and no skills in any session; `agent_get` has no skills line; `agent_create` leaves out its `skills` parameter and refuses a call that passes some with `Skills are off on this host`; the tables are left as they are |
| Discord administration | `discord-admin` | `discord: { admin: false }` | The `discord_*` tools that read and manage the server, for the owner | No `discord_*` tools; the channel executor that remote MCP uses is the connection's, so it stays |

Switching an addon off leaves its tables and rows unchanged, ready for when you turn it on again.
`skills` also takes the two directories (`skills: { builtinDir, reposDir }`) when it is on.

Use `find` for an optional addon service; it returns `undefined` while the addon is off.
Use `get` if your plugin needs the addon; it fails with a message naming the switch:

```text
service roundtable.memory is not provided. The memory addon is switched off (config memory: false). Switch it on, or provide the service from a plugin of your own.
```

`serviceKey(id, { absent })` lets your own keys say the same.
Switching an addon off and adding a plugin of yours that provides the same key is equivalent to `replaces`.

## Tiers: who may use what

Every turn has a speaker with a tier: `owner`, `admin`, or `member`, from most to least trusted.
By default, only the owner speaks.
The operator can open the bot to others by listing them under `speakers` in `roundtable.config.ts` and is responsible for that setup.

Each tool names the lowest tier that may call it.
The bot offers the tool in turns whose speaker is at that tier or above; the operator's `toolTiers` setting can override the plugin's choice.
Tools with no tier assigned require the owner.
A plugin that adds raw session tools names their tiers with `toolTiers`; the core's own table names only `ask_user`, `compact_session` and `read_attachment`.

## The parts

Each heading below is a key `setup` may return.
A key the contract does not have stops the start and names the closest one.

### `tools`: what agents can call

`defineTool` takes a name (lowercase words joined by underscores), a description the model reads to decide when to call it, a Typebox parameter schema, the lowest tier that may call it, and the function.
`run` receives the arguments, already typed, and the turn: the speaker, the channel, the agent, an abort signal, and `attachFile`.
It returns the text the model reads.
Throw `ToolRefusal` for a call the model should correct; any other error fails the call.

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

A rule whose verdict depends on the input, such as one that holds only a `delete` action, can also answer `mayHold(tool)`: whether it may hold some call of that tool.
It is asked when the input is not known yet, as for a [precheck script](#precheck-scripts-prechecks-the-agent-writes)'s call whose arguments are computed when it runs; a rule without it is judged by `describe` with an empty input.
A rule whose held call stands for others can answer `approvalTier(tool, input, context)`: the lowest tier that may approve it when higher than the tool's own. The held call keeps it as `minTier`, and both its card and a confirming message require it. A card is answered, and a confirming message accepted, from the speaker whose turn held the call, when their tier is at least `minTier`, and from the owner; nobody else in the channel may approve it. The held call records that speaker as `PendingConfirmation.speakerId`; a call held without one is the owner's to approve.

#### The shell rule

`shellHoldRule` in `pi-roundtable/kit` judges the agents' `bash`, `write` and `edit` calls; the agent server links it, and a session without a workspace has no shell.
Its scratch roots are the shared workspace (`HoldContext.workspace`) and the scratch dir (`HoldContext.scratchDir`).
The scratch dir is the config's `scratchDir`, by default `<os temp dir>/<discord.rootCommand>-scratch` (such as `/tmp/roundtable-scratch`); the agent server creates it with mode 0700 at startup and refuses one that is a symlink or another user's, and the agents' `bash` runs with `TMPDIR` pointing to it, so `mktemp` and tools write there.
`AgentSessions.scratchDir` carries it to a runtime, and the agents' prompt tells them to write temporary files there.

- A `>`, `>>` or `tee` target, and a `write` or `edit` path, inside a scratch root run; anything else, the rest of `/tmp` included, is held.
- An `rm` runs when every operand resolves inside a scratch root and none is a root itself or `/`. Operands resolve after the variables assigned earlier in the same command line (`NAME=value` and `export NAME=value` with literal values; `$TMPDIR` is the scratch dir and `$HOME` the service user's home), from the directory of the last `cd`, through `..` and, for paths that exist, symlinks, so a link out of a root is held. A glob is judged by its directory part. A command substitution, an unknown variable, `~user`, an `rm` without operands, and `xargs rm` are held.
- `sudo`, `kill`, `dd`, `mkfs` and the other programs held whatever their arguments stay held, as do service, container, firewall and package changes, `git reset --hard`, and `gh` writes.
- `git push` is held, `force-pushes` for a force push and otherwise as a push to GitHub.

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
			speaker: { id: "1", name: "Ada", tier: "member" },
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
				avatarPrompt:
					"A calm librarian with round glasses and a stack of books",
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
`busy` lists the work still running, one entry each; a shutdown waits until every service's list is empty, for at most an hour, so a deploy rarely cuts work short.
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
- The runner's `run(script, context)` gets the `PrecheckScriptContext`: the schedule, `firedAt`, `signal`, the host's `timeZone`, and `today`, the date there. Its answer is checked like a named precheck's, and its finding is named `script`.
- `describe({ channel, target, tier })` (a `PrecheckScope`) tells the model how to write one and what it may call there; `schedule_list` shows it, waiting at most 10 seconds. `tier` is the asker's there and the script's creator's when it runs, so a runner may grant lower tiers less.
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
| `images` | No drawing; each agent gets an avatar generated from its display name | `async (prompt, references) => bytes` returning PNG bytes |
| `runtime` | None: the runtime plugin builds the Pi runtime itself | `(deps) => runtime`, an [`AgentRuntime`](#the-runtime-slot-replace-pi) that runs every conversation |

When no `images` provider is configured, `agent_create` has no `avatar_prompt` parameter and `agent_avatar` is unavailable.
The owner's profile panel reports the missing provider and offers no redraw option.
Each agent gets a picture generated from its display name and the assistant's icon, so you can tell agents apart.
`bunx roundtable doctor` reports whether the slot is filled.
The copy-in [`codex-images` provider template][codex-images-template] is a complete implementation of the `images` slot.

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
`prompts(conversation, speaker)` gives you the owner's approval and question cards on the conversation's surface, or `undefined`.
`agents` holds the agent server's per-agent settings: `workDir`, `scratchDir` (the agents' shell's `TMPDIR`), `skills(name)`, `modelOf(name)`, and `turnChannel(scope)`.
The agent server sets up after the runtime is built, so read `agents` when a turn runs; it is `undefined` on a host without the agent server, where no agent turn runs.
`confirmations` stores held actions across restarts.

An `AgentRuntime` has these methods:

| Method | What it does |
|---|---|
| `runTurn(request)` | Runs one turn and returns `{ ok: true, text }` or `{ ok: false, error }`; `error` is an `Error`, and `AgentRunError` (exported) is the core's own |
| `steer(conversation, text, attachments, speakerId?)` | Adds a message to the conversation's running steerable turn; `false` when the message must wait for its own turn |
| `stop(conversation)` | Aborts the conversation's running turn; `false` when none runs |
| `startFresh(conversation)`, `deleteConversation(conversation)` | Archive the conversation, or remove it for good; called between turns |
| `pendingConfirmation(conversation)`, `heldActions(conversation)` | The held actions known in memory, and those restored from the store after a restart: the agent server reads `heldActions` to show an approval card again after a restart. A `PendingConfirmation` carries the `selectionId` of the `TurnSelection` whose turn held the calls, an opaque string that the caller resolves again when the owner confirms; the core stores it and never reads it |
| `recentTranscript(conversation, limit)` | The latest messages, for the owner's and the dashboard's views of a conversation |
| `contextUsage?(conversation)` | How full the conversation's context is, `{ tokens, contextWindow }`; leave it out and the team status shows no context bar |
| `preflight?()` | Runs in the host's preflight, before anything starts; a throw stops the boot |
| `dispose?()` | Runs when the host stops the runtime plugin's `runtime` service |

A request has the turn's `channel`, `selection` (its tools), `text`, `attachments`, `speaker`, flags (`steerable`, `interactive`, `confirmed`), and `interim`, where the turn may post the text it writes before its final answer ([interim text](#interim-text-what-a-turn-writes-before-its-final-answer)).
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

Build a feature's part of the root command with `ownerCommandModule(guard, handlers)` from `pi-roundtable/discord`; it is owner-only, defers interactions, and supplies a failure panel.
That entry also exports `groupOption` for subcommand groups, the panel helpers (`ownerPanel`, `ownerPanels`, `ephemeralPanel`, `replyWithPanels`, `plain`, `OwnerFacingError`), and `agentPanel({ guard, agents })` for an agent's profile panel.
`DISCORD.guard` is the `CommandGuard`; its `isOwner(actor)` accepts an interaction or anything with `user.id`, so a test needs no cast.
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
`pi-roundtable` lists it as a peer dependency (`>=0.35.0 <0.36.0`), so `bun add pi-roundtable` installs it for you.
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
Each extension needs a unique name; the core reserves `read-attachment`, `confirmation-gate`, `ask-user`, `self-compact-guard`, and `active-tools`.
A runtime of your own pins the active tools the way the core does: `activeToolsExtension(() => tools)` from `pi-roundtable/kit` is the extension the core places last, so its handler runs after every other extension's.
At most one plugin may add a `compaction` extension, and it must name the `engine` its compactions record.
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
Your Discord claim won't receive messages from that guild at any priority below 100, including `priority: 10`.
Claims on other surfaces, such as the example's `echo:` keys, don't compete with the agent server.

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

### `personas` and `context.turns`: conversations of a kind of your own

A conversation has a kind: the string its claim returns from `startFresh`, such as `"owner"` or `"study"`.
Your plugin names its claims' kinds; the host treats them as opaque strings.
A `Persona` supplies the system prompt for every non-agent conversation of one kind: `{ kind, prompt() }`.
The runtime reads `prompt()` when it creates the conversation's session, so message catalog text uses the host's language.

- A plugin contributes `personas` with the kinds it owns; `sessions().persona(kind)` is the linked lookup a runtime uses.
- Two personas of one kind are refused, naming both plugins, and so is the kind `"agent"`, which the agent server keeps for its agents.
- The kind `"owner"` is the default for a conversation whose claim names none.
  The plugin that owns the owner's conversations contributes its persona; without one, those conversations start with an empty system prompt.
- List tools your plugin needs in `requiredTools`; startup builds a session and refuses to run if any listed tool is unregistered.
  The host merges every plugin's list and keeps each name once.
- A turn whose kind has no persona is refused with an error naming `personas`.
  The Pi runtime refuses when it makes the session; a runtime of your own does the same, as the example's does.
- With the memory addon on, a turn's `speaker` decides whose memory the system prompt carries and the memory tools change: a member's or an admin's own, and the owner's for a speaker of the owner tier.

Call `context.turns.run(input)` inside your claim's queue task to run a turn in a conversation it owns.
It shows typing and the stop control on the channel's surface, runs the turn, and emits `turnStarted` and `turnEnded` with the turn's `kind`.
It catches runtime errors as failed results and posts the answer, failure notice, or stopped notice through the surface.
Supply `reply(result)` to handle the reply yourself.
`input` has `channel`, `kind`, `text`, `speaker`, and optionally `attachments`, `selection` (by default the plugins' `agentSelection`), `steerable`, `interactive`, `confirmed`, `reply`, and `conversation`.
It rejects with `NotLinkedError` during `setup`, and with a `PluginError` on a host whose runtime plugin has not provided a runtime.

Before each turn runs, `context.turns.run` records its conversation in the host's registry, `CONVERSATIONS`: at the first turn its key, surface, kind, visibility, owner, and title, and at every later turn only that it was active.
`conversation: { visibility: "private" }` records it as the speaker's own (`principalId` is `speaker.id`); without it the conversation is `shared`.
`conversation.title` names it at its first turn; `setTitle(key, title)` renames it later.
A turn whose conversation cannot be recorded does not run, and the call rejects.
The registry records and never refuses: who may speak in a conversation stays your claim's decision, which may read `get(key)` to check the owner.
`list({ principal })` gives one principal's conversations and `list()` every one, the most recently active first; the web console lists them too.
No session file moves, and a conversation from before the registry is recorded at its next turn.

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
				admit: (message) =>
					message.authorIsBot
						? undefined
						: {
								kind: "turn",
								run: async () => {
									await turns.run({
										channel: message.channel,
										kind: STUDY,
										text: message.text,
										speaker: {
											id: message.authorId,
											name: message.authorName,
											tier: "member",
										},
									});
								},
								failure: "a study turn failed",
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
import { testPlugin } from "pi-roundtable/testing";
import { createEchoRuntime } from "./echo-runtime.ts";
import { FakeSurface } from "./fake-surface.ts";
import { studyRoom } from "./study-room.ts";

/** The plugin over the fake surface and the echo runtime, with nothing else: no Discord, no Pi, no database. */
async function studying() {
	const surface = new FakeSurface();
	const harness = await testPlugin(studyRoom, {
		surfaces: [surface],
		providers: { runtime: createEchoRuntime },
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

test("the persona is the plugin's and belongs to the study kind only", async () => {
	const { harness } = await studying();
	const [persona] = harness.contribution.personas ?? [];
	expect(persona?.kind).toBe("study");
	expect(persona?.prompt()).toContain("patient tutor");
	await harness.stop();
});
```
<!-- /example -->

### `backgroundTargets`: whose turn a schedule or delegated task is

Schedules and delegated tasks return later as turns without a new message in the channel.
A `BackgroundTarget` says whose turn that is: a `name` that the schedule or job stores, a `label(locale)` that lists such as `/<root> schedule` show, and the limits that apply to it.
`schedules` (`perChannel`, `promptChars`, `aheadDays`) bounds what `schedule_create` accepts, and `delegation` (`maxRunning`) bounds how many delegated tasks may run in one channel; a target without one of them may not schedule or delegate at all.
The claim that answers the target serves it in its `background(turn)`, where `turn.target` is the name, and skips every target it does not serve.
A channel's claim runs turns only for its own target, keeping the owner's tools out of channels open to many people.

- Contribute `backgroundTargets` alongside the claim that serves them; read one with `context.conversations.target(name)` from a service or handler.
- Two targets with the same name are refused, naming both plugins.
- The agent server contributes `OWNER_TARGET` (name `"owner"`, exported from the main entry) for the owner's and agents' conversations.
  Its claim answers that target and skips all others, so a turn for another target never runs with the owner's tools.
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

### `surfaces`: a chat network of your own

A chat surface connects the host to one chat network: it reports what people write, and it posts what the conversations answer.
The host ships Discord's; a plugin contributes another with `surfaces`, and its claims answer on it through `context.surfaces`.
All surfaces share one conversation router.
The surface delivers messages; the channel's owning claim decides what happens to them.

A surface serves the channels whose key starts with its `surface` prefix: `surface = "fake"` serves `fake:<id>` keys, and only those reach its methods.
The prefix is one non-empty word without a colon or a space, unique per host: two surfaces with one prefix stop the start, naming both plugins.
The agent server claims only `discord:` keys, so claims on your surface's channels don't compete with it.

| Method | What the surface does | Without it |
|---|---|---|
| `surface` | The key prefix | (required) |
| `start(deliver)` | Connects, and calls `deliver(message)` for every incoming message; the host passes its conversation router | (required) |
| `sendReply(channel, reply)` | Posts an `OutboundReply`: a thinking line, a card, text chunks, then files | (required) |
| `stop()` | Disconnects when the host stops | nothing to stop |
| `startTyping(channel)` | Shows a typing indicator until the returned function is called | none is shown |
| `showStop(channel)` | Shows the owner a stop control until the returned function is called; using it calls `conversations.stop(channel)` | none is shown |
| `react`, `unreact` | Adds or removes the bot's reaction on a message | no marks on queued or steered messages |
| `prompts(channel, speaker?)` | The owner's way to approve a held action or answer `ask_user` inside a running turn, as `OwnerPrompts`: `confirm` and `ask` | the action is held until the owner's next message |
| `interim(channel)` | Where a running turn posts the text it writes before its final answer, as `InterimPosts`: `post(text)` sends one message of at most 2000 characters and resolves to an `InterimMessage` whose `edit(text)` changes it in place | only the final reply is posted |
| `progress(channel, event)` | Shows a turn run through `context.turns` as it goes, such as a live preview in a web chat. `event` is a `TurnProgress`: `{ type: "text", delta }` (the reply's text, joined over 250 ms and always sent before a tool event, never the thinking), `{ type: "tool_start", id, tool, preview? }` (a one-line preview of the arguments, at most 80 characters, never their full text), or `{ type: "tool_end", id, tool, ok }`. The final reply still comes through `sendReply`; a rejection is logged and the turn goes on | only the final reply is shown |

The host starts each surface as `surface:<prefix>` at the contributing plugin's place in the order, before that plugin's own services.
It stops surfaces in reverse order, like other services.
The host logs and drops messages whose prefix differs from the delivering surface's, since claims can't identify which surface they belong to.
`context.surfaces` picks the surface by the key's prefix.
Its `sendReply` rejects with a `PluginError` naming the prefix when no surface serves it.
`startTyping`, `showStop`, `react`, and `unreact` do nothing when a channel has no surface or its surface omits those methods.
If `prompts` is unavailable, it returns `undefined` and held actions wait for the owner's next message.
`of(channel)` returns the surface, or `undefined`.
The agent server asks the owner for approvals through `context.surfaces.prompts`, so a surface that gives `prompts` gets them in its own channels.

#### Interim text: what a turn writes before its final answer

A model often writes text in an assistant message that then calls tools, such as a proposal before it asks `ask_user` "go with this version?".
On a surface that gives `interim`, and in the agent server's channels through the agents' webhooks, the host posts that text as the turn goes, sorted in two:

- **Primary** text is posted as ordinary messages as soon as its assistant message ends: text of 400 characters or more, or written with a Markdown heading, list, table or code fence.
- **Secondary** text, short narration between tool calls, goes to one progress message per run of tool-calling messages, in Discord's small text (`-# ` per line): each text as a line, then the tools called in the run, such as `-# bash ×3 · read · web_search` (names only). It is edited in place at most every 1.5 seconds, its last state always lands, and it stays inside 2000 characters by dropping its oldest lines behind `-# …`. A primary post or a card starts a new progress message.

Before any card, an `ask_user` question or an approval, the host posts the pending text and brings the progress message up to date, so what the model wrote before the card shows above it.
The final reply is posted at the end as before, with its thinking line; an intermediate message is never the final one, so nothing is posted twice, and a steered run keeps its final text.
A failed interim post or edit is logged and never fails the turn.
Turns with nowhere to post, such as transient tasks, coding workers, and turns of a claim that passes its own `reply` to `context.turns.run`, post only their final reply.
A runtime that fills [the `runtime` slot](#the-runtime-slot-replace-pi) receives the place to post as `TurnRequest.interim` and may use it or not.

The config's `interimText: "off"` posts only the final reply (default `"on"`), and `interimPrimaryChars` sets the length of primary text (default 400).

The Discord plugin collects [slash commands](#slash-commands-commandsadd); the host doesn't compose them or pass them to surfaces on other networks.

This in-memory chat surface records everything the host asks of it.
Its plugin adds a claim that answers through `context.surfaces`:

<!-- example: examples/fake-surface.ts -->
```ts
import {
	type ChannelKey,
	type ChatSurface,
	definePlugin,
	type InboundMessage,
	type OutboundReply,
	type OwnerPrompts,
	parseChannelKey,
} from "pi-roundtable";

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
	readonly asked: string[] = [];
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

	/** How the owner would approve a held action or answer a question in a turn. */
	prompts(channel: ChannelKey): OwnerPrompts {
		return {
			confirm: async (title) => {
				this.asked.push(`${channel}: ${title}`);
				return "approved";
			},
			ask: async () => undefined,
		};
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
In 0.8 the one adapter is Discord: `discord()` from `pi-roundtable/discord` takes the same settings as the top-level `discord`, and a host configured either way assembles the same plugins in the same order.
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
		owner: { id: env("OWNER_ID"), name: env("OWNER_NAME") },
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

Leave `discord` out of `roundtable.config.ts` and the host runs without it: no Discord plugin, no agent server, no agents, and no skills.
The runtime plugin still builds the runtime, so every claim that runs turns through `context.turns` works, over the surfaces your plugins bring.
`http` is optional too; without it the host opens no listener, and a route then names a listener that is not configured.

What needs Discord is refused or left out rather than failing later:

- `agents`, `skills` (anything but `false`), and `ops.agent` are configuration errors. `ops: { conversation: "<surface>:<id>" }` needs a chat surface that serves it, a claim that owns it and takes background turns, and a plugin that contributes the `owner` background target, or the host does not start; without Discord nothing contributes `owner` unless a plugin of yours does. The web chat takes no error reports in 0.8.
- `notify_owner` is not registered, since there are no owner's messages to send to.
- `schedule_*` and `delegate_task` are not registered: their runs are turns of the [background target](#backgroundtargets-whose-turn-a-schedule-or-delegated-task-is) named `owner`, which the agent server contributes, so without it none could start.
  A plugin that contributes `owner`, and a claim that takes its background turns, bring them back; they then work in a conversation a chat surface carries, posting their runs there, and refuse elsewhere.
- `roundtable doctor` skips the Discord checks.

Pi's runtime still needs the `compact_session` tool in every session, from the Pi package pi-self-compact: load it from a plugin with `piPackages: ["pi-self-compact"]`, as the `plugins/self-compact.ts` of a project `roundtable init` creates does, or the preflight stops the start and says so.
`roundtable init --adapter web` creates a host without Discord around the [web chat](#web-chat-pi-roundtable-webchat).
A host that keeps Discord may write it as an adapter instead, as [`adapters`](#adapters-the-chat-networks-the-host-talks-through) describes.

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
		owner: { id: "owner", name: "Ada" },
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
`webChat({ verifier, access, personas, origins })` adds a chat surface whose conversations have keys `web:<conversation>`, the claim that runs each message as a turn of its conversation's persona through `context.turns`, and a REST API and a WebSocket under `/chat` on the host's `public` listener.
People an OpenID Connect provider signs in open private conversations, see each turn's text and tools as it runs, and answer its approval cards.
It needs no Discord: a host whose configuration has no `discord` and lists `webChat(...)` in `plugins` is a web-only assistant.

#### `roundtable init --adapter web`

`roundtable init --adapter web` writes a project without Discord around it: no `agents.ts` and no shared persona, a `roundtable.config.ts` that lists `webChat(...)` with an `oidcJwtVerifier`, an access map whose members and admins come from the token's roles, and one persona, `assistant`, whose prompt is `persona/assistant.md`.
The persona's `selection` names its tools (the hello plugin's), so tools a later plugin adds, such as pi-web-access's, stay out until you add them by name.
`package.json` pins pi-roundtable-webchat at the core's version and pi-self-compact, and `.env.example` asks for `OWNER_NAME`, `DATABASE_URL`, `MODEL`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`, `CHAT_MEMBER_ROLES`, and `CHAT_ORIGINS`, with no Discord variable.
The host listens on `127.0.0.1:3000`; serve it over HTTPS through a reverse proxy.
`--adapter discord` is the default and writes the Discord project.

#### Protocol

A browser asks for a one-time ticket with `POST /chat/tickets` and `Authorization: Bearer <token>`, then opens `/chat/socket` offering the subprotocols `roundtable.webchat.v1` and `ticket.<ticket>`; another client sends the bearer token on the upgrade.
The token never travels in a URL.
Each WebSocket message is one JSON object with a `type`: the client sends `send`, `stop`, `approval`, `answer`, and `auth`; the server answers with `ready`, `accepted`, `typing`, `stoppable`, `progress`, `reply`, `failed`, `prompt`, `prompt_closed`, `reauth`, and `error`.
`progress` carries the turn's [`TurnProgress`](#surfaces-a-chat-network-of-your-own) events, never the thinking and never a tool's full arguments; `reply` carries the answer in full markdown.
The REST API lists a person's conversations, opens one, and reads its messages.
The package README documents every frame, error code, close code, and limit.

#### Security model

- A conversation belongs to the person who opened it: the claim checks the [conversation registry](#services-what-plugins-provide-to-each-other) inside the conversation's queue before every turn, and only that person may list, read, write in, stop, or answer it.
- Tokens are checked on every REST call, every upgrade, and every `auth` frame. By default only a person's access token passes: a token without a scope or app roles, or an app-only token, is refused. A socket closes when its token expires.
- `origins` is required, and checked on every upgrade and every browser request.
- Each person has bounded sockets, tickets, conversations opened per hour, and turns running or queued at once; frames are bounded in size and rate.
- An approval card goes to the conversation's person only, at the tier the held call needs.
- No token claim makes anyone the owner; owners are listed by speaker id, `oidc:<base64url(issuer)>:<subject>`.

#### Provider settings

The verifier is generic; what makes it safe is how it is pointed at your provider.
The README's [provider settings][webchat-provider-settings] explain, with Microsoft Entra ID as the example, why to name people by a claim that stays the same across app registrations (`subjectClaim`), pin the tenant in `check`, accept access tokens only, refuse app-only tokens, merge issuers of one tenant only (`speakerIssuer`), and mind the guests `everyone` admits.

The web chat takes no attachments and no background turns yet: leave `schedule_*` and `delegate_task` out of a web persona's `selection`, and `web_search` and `fetch_content` unless people may make the host fetch any address, internal ones included.

[webchat-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/webchat/README.md
[webchat-provider-settings]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/webchat/README.md#provider-settings

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

## Official plugins

The package ships three plugins you can copy into a project and change.
`roundtable add plugin codex-images`, `roundtable add plugin dice`, and `roundtable add plugin release-notice` write `plugins/<name>.ts` and `plugins/<name>.test.ts`, import the plugin in `roundtable.config.ts`, and list it in `plugins`.
You can edit the copied files; `add plugin` refuses to overwrite existing ones.
The three names are reserved for these copies.
Inspect the ready-made implementations in the [codex-images][codex-images-template], [dice][dice-template], and [release-notice][release-notice-template] templates.

The [pi-roundtable-mcp][mcp-package] workspace, published separately on npm, adds two more plugins, `mcpConnectors` and `remoteMcp`.
The first lets the owner add MCP servers such as Notion or a calendar from Discord and gives your code the list; the second lets an agent outside Discord reach your agent.
Install it with `bun add pi-roundtable-mcp`.

Six official packages live in this repository as Bun workspaces and publish as separate npm packages, versioned in lockstep with the core.
The [site guide source files][package-guides] describe installation, requirements, configuration, and security considerations:

- [pi-roundtable-drawing][drawing-package]: [site guide source][drawing-guide] · local relationship maps, magic circles, sigils, sacred geometry, and card spreads.
- [pi-roundtable-coding][coding-package]: [site guide source][coding-guide] · repository shelves and owner-approved Pi coding workers.
- [pi-roundtable-web][web-package]: [site guide source][web-guide] · an owner-only console for conversations, transcripts, and memory notes with live updates.
- [pi-roundtable-sandbox][sandbox-package]: [site guide source][sandbox-guide] · sealed guest channels on native Linux Docker with a host-only credential broker and allow-listed tools.
- [pi-roundtable-mcp][mcp-package]: [site guide source][mcp-guide] · MCP connectors through a gateway and remote MCP endpoints for agent turns and owner-granted Discord channel tools.
- [pi-roundtable-webchat][webchat-package]: [site guide source][webchat-guide] · a WebSocket chat for people an OpenID Connect provider signs in, with private conversations, live progress, and approval cards; see [web chat](#web-chat-pi-roundtable-webchat).

[drawing-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/drawing/README.md
[coding-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/coding/README.md
[web-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/web/README.md
[sandbox-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/sandbox/README.md
[mcp-package]: https://github.com/wayne930242/pi-roundtable/blob/master/packages/mcp/README.md
[package-guides]: https://github.com/wayne930242/pi-roundtable/tree/master/site/src/content/docs/plugins/
[drawing-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/drawing-package.mdx
[coding-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/coding-package.mdx
[web-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/web-package.mdx
[sandbox-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/sandbox-package.mdx
[mcp-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/mcp-package.mdx
[webchat-guide]: https://github.com/wayne930242/pi-roundtable/blob/master/site/src/content/docs/plugins/webchat-package.mdx
[coding-source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/coding
[sandbox-source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/sandbox
[web-source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/web
[drawing-source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/drawing
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

`release-notice` listens to two [events](#events-hear-what-the-core-does).
When the agent server's team service reports `ready`, it reads the release file and posts if the release's `sha` differs from the one it last announced (`announced-release` in the data directory), or if the previous shutdown cut work short.
It records the announced `sha` only after the post succeeds, so a failed post is tried again at the next start, and a `release.json` that is not valid (not JSON, an empty `sha`, or `commits` that is not a list of strings) fails the handler with its path in the log.
At `shutdown(left)` it adds the channels in `left`, the work the drain gave up on after an hour, to `aborted-on-shutdown.json` in the data directory; the next start's announcement names them as cut short (a Discord channel key as a `<#id>` mention), and once it is posted they are removed from the file. A shutdown that arrives while a post is still in flight keeps its channels for the next announcement.
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
It returns:

| Field | What it is |
|---|---|
| `contribution` | What the plugin added, as the host would collect it: `tools`, `prompt`, `seeds`, `events`, `services`, `http`, and the rest |
| `tools`, `tiers` | The tool names, and the table that says what tier each needs |
| `holds` | The plugin's `holdRules` chained as the host links them (`holdChain`): `holds(tool, input, { workspace?, scratchDir? })` returns the description of a call that must be approved first, or `undefined` |
| `runTool(name, args, { speaker, channel }?)` | Runs a tool the way an agent's turn would, in the channel (default `test:1`) for the speaker, and returns the text the model reads |
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
	const ada: Speaker = { id: "1", name: "Ada", tier: "member" };
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
`fakeDiscord({ ownerId?, rootCommand? })` is the `DISCORD` service for a plugin that adds slash commands: give it as `services: [discord.service]`, read what the plugin added with `discord.added()`, and compose the tree Discord would get with `discord.compose()`.
Only `commands` and `guard` are given; a plugin that reads another member of `DISCORD` in a test gives its own with `servicePair(DISCORD, { ... })`.

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
| `discord` | What the stand-in Discord hands out: `agentChannels(guildId)` and `ownerChannel()`; `false` boots a [host without Discord](#a-host-without-discord), with no `discord`, `http`, or `agents` in the test configuration |

It returns:

| Field | What it is |
|---|---|
| `context` | The `PluginContext` of a probe plugin set up after every other: read `services`, `sessions()`, or `toolTiers` from it |
| `conversations` | The host's conversations, as a surface would drive them |
| `commands` | `added`, every slash-command contribution the plugins handed Discord in order, and `composed()`, the tree Discord would register |
| `sessionTools(scope?)` | The tools each extension of a session registers, in plan order (an extension that registers commands, flags, or event handlers besides tools is accepted, and only its tools are listed); the owner's session unless an `AgentTurnScope` is given |
| `sessionContext(scope?)` | A `SessionContext` as the runtime builds it, with the real compaction wrapper |
| `stop()` | Stops the host; call it when the test ends |

`useEagerCatalog()` sets a catalog that marks every text and uses a foreign time zone.
`eagerText(value)` lists the marked strings under a value, so a test can check that the host applied its own environment before building text from the catalog.
`useTestLocale()` restores the neutral defaults.

`holdChain(rules)` is in `pi-roundtable/kit`: the chain the host links from every plugin's hold rules, to test a rule set without a harness.

### `describeSurfaceContract`: what every chat surface keeps

A plugin that contributes a `ChatSurface` can test it against the contract every surface keeps.
`describeSurfaceContract(name, make)` registers one test per check, each on a fresh `SurfaceContractSubject` from `make`: the `surface`, a `channel` of it, and one person on its network, who can `write(text)`, whose `observations()` list what they have seen (`SurfaceObservation`: a reply's text and file names, typing and stop controls going on and off, progress, and prompts opening and closing), and who may `answer(prompt, approved)` an approval; `speaker` is who they are to `surface.prompts`, an owner by default, and every approval the contract asks for needs exactly their tier. `stranger`, when given, is someone else on the network, not the owner, who knows the id of the person's open approval and may `join()` and `answer(prompt, approved)` it.
The contract starts the surface, calls the subject's `join()`, and stops the surface after the subject's `close()`.
It checks that the surface names a prefix and owns its channel, delivers what the person writes, and shows every chunk of a reply; and, for the parts the surface offers, that it delivers files when `supportsFiles` is set, ends typing and stop controls idempotently, shows progress, and resolves an approval as the person approves or declines it, or `cancelled` when the turn stops, and, with a `stranger`, that the stranger's answer leaves the person's approval open.
A check for a part the surface does not offer passes.
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
   The order is the built-ins (`memory`, `schedule-store`, `prechecks`, `discord`, `modules`, `discord-admin`, `skills`, `conversations`, `runtime`, `agent-server`, `seeds`; an addon that is switched off is not there, and without Discord neither are `discord`, `discord-admin`, `skills`, `agent-server`, or `seeds`), then yours in the order of `plugins` in `roundtable.config.ts`, then the built-in `schedules`, so a due schedule fires only once everything it can reach is running.
4. The contributions are linked: tool tiers, hold rules, the session plan, the channel router, and the events.
   From here `sessions()`, `conversations`, `surfaces`, `turns`, and `dashboard()` work.
5. Every plugin's `preflight` runs, in plugin order.
   The Discord plugin's preflight is where it composes the slash commands every plugin added in `setup`; a clash stops the start here.
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

On `SIGTERM` or `SIGINT` the bot stops serving new work last:

1. It keeps serving until the channel queue is empty and no service reports `busy()` work, for at most an hour; whatever is left is logged and given up on.
2. Every plugin hears `shutdown(left)`, while every service is still running.
3. The HTTP listener closes, so no request reaches a service that has stopped.
4. Services stop in the reverse of the order they started.
5. The database pool closes.

`shutdown()` returns exit code `0`, or `1` if a listener, service, or pool failed to stop.
Every call shares the same shutdown.
`listen()`, called by the command line and a host's own entry point, exits the process with that code.

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
| `plugin <name>: setup returned an unknown part "<key>". Did you mean "<closest>"? The parts are services, events, http, holdRules, piPackages, sessionTools, channels, surfaces, personas, backgroundTargets, dashboard, tools, seeds, prompt, agentSelection, requiredTools.` | Fix the key; `migrations`, `providers`, and `preflight` belong on the plugin, not in what `setup` returns |

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
| `two plugins are named <name>.` (from `roundtable doctor`) | Rename yours; the built-in plugins are `memory`, `schedule-store`, `prechecks`, `discord`, `modules`, `discord-admin`, `skills`, `conversations`, `runtime`, `agent-server`, `seeds`, and `schedules` |
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
| `AccessOwner` | `pi-roundtable` | type |
| `AccessRules` | `pi-roundtable` | type |
| `AccessTier` | `pi-roundtable` | type |
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
| `AgentRunError` | `pi-roundtable` | value |
| `AgentRuntime` | `pi-roundtable` | type |
| `AgentSeed` | `pi-roundtable` | type |
| `AgentServer` | `pi-roundtable` | type |
| `AgentSessions` | `pi-roundtable` | type |
| `AgentStatus` | `pi-roundtable` | type |
| `AgentTeam` | `pi-roundtable` | type |
| `AgentTurnScope` | `pi-roundtable` | type |
| `Approval` | `pi-roundtable` | type |
| `AskOption` | `pi-roundtable` | type |
| `AttachmentFailure` | `pi-roundtable` | type |
| `AttachmentRef` | `pi-roundtable` | type |
| `AvatarMode` | `pi-roundtable` | type |
| `AvatarStudio` | `pi-roundtable` | type |
| `BACKGROUND_TURNS` | `pi-roundtable` | value |
| `CONVERSATIONS` | `pi-roundtable` | value |
| `BackgroundTarget` | `pi-roundtable` | type |
| `BackgroundTurn` | `pi-roundtable` | type |
| `BackgroundTurns` | `pi-roundtable` | type |
| `ChannelClaim` | `pi-roundtable` | type |
| `ChannelKey` | `pi-roundtable` | type |
| `ChatSurface` | `pi-roundtable` | type |
| `ConfigError` | `pi-roundtable` | value |
| `ContextUse` | `pi-roundtable` | type |
| `Contribution` | `pi-roundtable` | type |
| `ConversationKind` | `pi-roundtable` | type |
| `ConversationPort` | `pi-roundtable` | type |
| `ConversationRecord` | `pi-roundtable` | type |
| `ConversationRegistration` | `pi-roundtable` | type |
| `ConversationRegistry` | `pi-roundtable` | type |
| `ConversationVisibility` | `pi-roundtable` | type |
| `ConversationTurnInput` | `pi-roundtable` | type |
| `ConversationTurns` | `pi-roundtable` | type |
| `DELEGATION` | `pi-roundtable` | value |
| `DefineOverrides` | `pi-roundtable` | type |
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
| `GroupStatus` | `pi-roundtable` | type |
| `HeldActionStore` | `pi-roundtable` | type |
| `HeldCall` | `pi-roundtable` | type |
| `HoldCheck` | `pi-roundtable` | type |
| `HoldContext` | `pi-roundtable` | type |
| `HoldRule` | `pi-roundtable` | type |
| `HostEnv` | `pi-roundtable` | type |
| `HostEnvironment` | `pi-roundtable` | type |
| `HttpRoute` | `pi-roundtable` | type |
| `IDENTITY` | `pi-roundtable` | value |
| `IdentityError` | `pi-roundtable` | value |
| `IdentityLink` | `pi-roundtable` | type |
| `IdentityRef` | `pi-roundtable` | type |
| `IdentityService` | `pi-roundtable` | type |
| `ImageDrawer` | `pi-roundtable` | type |
| `InboundMessage` | `pi-roundtable` | type |
| `InterimMessage` | `pi-roundtable` | type |
| `InterimPosts` | `pi-roundtable` | type |
| `InterimTextMode` | `pi-roundtable` | type |
| `Judge` | `pi-roundtable` | type |
| `JudgeError` | `pi-roundtable` | value |
| `JudgeModel` | `pi-roundtable` | type |
| `LinkedSessions` | `pi-roundtable` | type |
| `LinkSource` | `pi-roundtable` | type |
| `ListenerAddress` | `pi-roundtable` | type |
| `ListenerConfig` | `pi-roundtable` | type |
| `LoadedSkill` | `pi-roundtable` | type |
| `Locale` | `pi-roundtable` | type |
| `LogEntry` | `pi-roundtable` | type |
| `LogFn` | `pi-roundtable` | type |
| `Logger` | `pi-roundtable` | type |
| `MEMORY` | `pi-roundtable` | value |
| `MEMORY_KINDS` | `pi-roundtable` | value |
| `Memory` | `pi-roundtable` | type |
| `MemoryError` | `pi-roundtable` | value |
| `MemoryKind` | `pi-roundtable` | type |
| `MemoryStore` | `pi-roundtable` | type |
| `Migration` | `pi-roundtable` | type |
| `MigrationError` | `pi-roundtable` | value |
| `MigrationReport` | `pi-roundtable` | type |
| `ModelImage` | `pi-roundtable` | type |
| `NewPrincipal` | `pi-roundtable` | type |
| `NO_ATTACHMENTS` | `pi-roundtable` | value |
| `NewSchedule` | `pi-roundtable` | type |
| `NotLinkedError` | `pi-roundtable` | value |
| `OWNER_TARGET` | `pi-roundtable` | value |
| `OutboundReply` | `pi-roundtable` | type |
| `OwnerAnswer` | `pi-roundtable` | type |
| `OwnerPrompts` | `pi-roundtable` | type |
| `OwnerQuestion` | `pi-roundtable` | type |
| `PendingConfirmation` | `pi-roundtable` | type |
| `Persona` | `pi-roundtable` | type |
| `PluginContext` | `pi-roundtable` | type |
| `PluginError` | `pi-roundtable` | value |
| `Principal` | `pi-roundtable` | type |
| `PrincipalRecord` | `pi-roundtable` | type |
| `PrincipalStore` | `pi-roundtable` | type |
| `PromptMemory` | `pi-roundtable` | type |
| `PromptSection` | `pi-roundtable` | type |
| `PromptTurn` | `pi-roundtable` | type |
| `Pronouns` | `pi-roundtable` | type |
| `ProviderError` | `pi-roundtable` | value |
| `Providers` | `pi-roundtable` | type |
| `QueuePort` | `pi-roundtable` | type |
| `Recurrence` | `pi-roundtable` | type |
| `ReferenceImage` | `pi-roundtable` | type |
| `ResolvedProviders` | `pi-roundtable` | type |
| `ResolvedSkill` | `pi-roundtable` | type |
| `RoleGrant` | `pi-roundtable` | type |
| `RoleHolder` | `pi-roundtable` | type |
| `RoleSource` | `pi-roundtable` | type |
| `Roundtable` | `pi-roundtable` | value |
| `ReplyFile` | `pi-roundtable` | type |
| `ReplyFileError` | `pi-roundtable` | value |
| `REPLY_FILE_LIMITS` | `pi-roundtable` | value |
| `RoundtableConfig` | `pi-roundtable` | type |
| `RoundtableOptions` | `pi-roundtable` | type |
| `RoundtablePlugin` | `pi-roundtable` | type |
| `RouteSocket` | `pi-roundtable` | type |
| `RuntimeDeps` | `pi-roundtable` | type |
| `RuntimeFactory` | `pi-roundtable` | type |
| `SCHEDULES` | `pi-roundtable` | value |
| `PRECHECKS` | `pi-roundtable` | value |
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
| `SKILLS` | `pi-roundtable` | value |
| `Schedule` | `pi-roundtable` | type |
| `ScheduleChange` | `pi-roundtable` | type |
| `ScheduleError` | `pi-roundtable` | value |
| `ScheduleStore` | `pi-roundtable` | type |
| `ScheduledOutcome` | `pi-roundtable` | type |
| `Service` | `pi-roundtable` | type |
| `ServiceKey` | `pi-roundtable` | type |
| `ServiceStartOutcome` | `pi-roundtable` | type |
| `ServiceStartedEvent` | `pi-roundtable` | type |
| `Services` | `pi-roundtable` | type |
| `SessionContext` | `pi-roundtable` | type |
| `SessionPlan` | `pi-roundtable` | type |
| `SessionTool` | `pi-roundtable` | type |
| `SessionToolSnapshot` | `pi-roundtable` | type |
| `SkillCatalogEntry` | `pi-roundtable` | type |
| `SkillRegistry` | `pi-roundtable` | type |
| `SkillSet` | `pi-roundtable` | type |
| `SkillSource` | `pi-roundtable` | type |
| `Speaker` | `pi-roundtable` | type |
| `SpeakerMemory` | `pi-roundtable` | type |
| `StoredAttachment` | `pi-roundtable` | type |
| `SurfacePort` | `pi-roundtable` | type |
| `SYSTEM_PRINCIPAL` | `pi-roundtable` | value |
| `THE_SPEAKER` | `pi-roundtable` | value |
| `TIERS` | `pi-roundtable` | value |
| `TeamAgentStatus` | `pi-roundtable` | type |
| `TeamStatus` | `pi-roundtable` | type |
| `ThinkingLevel` | `pi-roundtable` | type |
| `ThinkingSetting` | `pi-roundtable` | type |
| `Tier` | `pi-roundtable` | type |
| `TierConfig` | `pi-roundtable` | type |
| `ToolContribution` | `pi-roundtable` | type |
| `ToolRefusal` | `pi-roundtable` | value |
| `ToolSelection` | `pi-roundtable` | type |
| `ToolSpec` | `pi-roundtable` | type |
| `ToolTierTable` | `pi-roundtable` | type |
| `ToolTiers` | `pi-roundtable` | type |
| `ToolTurn` | `pi-roundtable` | type |
| `TranscriptEntry` | `pi-roundtable` | type |
| `TransientTask` | `pi-roundtable` | type |
| `TurnAttachments` | `pi-roundtable` | type |
| `TurnEndEvent` | `pi-roundtable` | type |
| `TurnProgress` | `pi-roundtable` | type |
| `TurnProgressEvent` | `pi-roundtable` | type |
| `TurnEvent` | `pi-roundtable` | type |
| `TurnRequest` | `pi-roundtable` | type |
| `TurnResult` | `pi-roundtable` | type |
| `TurnSelection` | `pi-roundtable` | type |
| `WebSocketAccept` | `pi-roundtable` | type |
| `WebSocketRoute` | `pi-roundtable` | type |
| `WebSocketSendResult` | `pi-roundtable` | type |
| `Weekday` | `pi-roundtable` | type |
| `attachReplyFile` | `pi-roundtable` | value |
| `withReplyFiles` | `pi-roundtable` | value |
| `prepareImageBytes` | `pi-roundtable/kit` | value |
| `ImagePreparationError` | `pi-roundtable/kit` | value |
| `scrubDiagnostic` | `pi-roundtable/kit` | value |
| `channelKey` | `pi-roundtable` | value |
| `definePlugin` | `pi-roundtable` | value |
| `defineRoundtable` | `pi-roundtable` | value |
| `defineTool` | `pi-roundtable` | value |
| `migrateDatabase` | `pi-roundtable` | value |
| `parseChannelKey` | `pi-roundtable` | value |
| `serviceKey` | `pi-roundtable` | value |
| `FakeDiscord` | `pi-roundtable/testing` | type |
| `FakeThreadHost` | `pi-roundtable/testing` | type |
| `OWNER_SPEAKER` | `pi-roundtable/testing` | value |
| `RecordedEvent` | `pi-roundtable/testing` | type |
| `ServicePair` | `pi-roundtable/testing` | type |
| `TEST_GUILD` | `pi-roundtable/testing` | value |
| `TestHost` | `pi-roundtable/testing` | type |
| `TestHostOptions` | `pi-roundtable/testing` | type |
| `TestLocale` | `pi-roundtable/testing` | type |
| `TestPluginOptions` | `pi-roundtable/testing` | type |
| `TestPluginResult` | `pi-roundtable/testing` | type |
| `TestStore` | `pi-roundtable/testing` | type |
| `describeDb` | `pi-roundtable/testing` | value |
| `describeSurfaceContract` | `pi-roundtable/testing` | value |
| `checkSurfaceContract` | `pi-roundtable/testing` | value |
| `SurfaceContractFailure` | `pi-roundtable/testing` | type |
| `SurfaceContractSubject` | `pi-roundtable/testing` | type |
| `SurfaceObservation` | `pi-roundtable/testing` | type |
| `eagerText` | `pi-roundtable/testing` | value |
| `fakeDiscord` | `pi-roundtable/testing` | value |
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
| `recordingLogger` | `pi-roundtable/testing` | value |
| `RecordingLogger` | `pi-roundtable/testing` | type |
| `RecordedLog` | `pi-roundtable/testing` | type |
| `silentLogger` | `pi-roundtable/testing` | value |
| `testDatabaseUrl` | `pi-roundtable/testing` | value |
| `testHost` | `pi-roundtable/testing` | value |
| `testPlugin` | `pi-roundtable/testing` | value |
| `useEagerCatalog` | `pi-roundtable/testing` | value |
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
| `CategoryLayout` | `pi-roundtable/kit` | type |
| `ChannelMessage` | `pi-roundtable/kit` | type |
| `ChannelQueue` | `pi-roundtable/kit` | type |
| `ChoiceAnswer` | `pi-roundtable/kit` | type |
| `ChoiceQuestion` | `pi-roundtable/kit` | type |
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
| `GroupMessage` | `pi-roundtable/kit` | type |
| `JUDGE_WORK` | `pi-roundtable/kit` | value |
| `McpEndpoint` | `pi-roundtable/kit` | type |
| `ModelRef` | `pi-roundtable/kit` | type |
| `OwnerIdentity` | `pi-roundtable/kit` | type |
| `OwnerNotifier` | `pi-roundtable/kit` | type |
| `PreviousTurn` | `pi-roundtable/kit` | type |
| `PromptSlot` | `pi-roundtable/kit` | type |
| `PushPolicy` | `pi-roundtable/kit` | type |
| `SCHEDULE_TOOLS` | `pi-roundtable/kit` | value |
| `SHELL_TOOLS` | `pi-roundtable/kit` | value |
| `SKILL_LIST_TOOL` | `pi-roundtable/kit` | value |
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
| `TextToolDef` | `pi-roundtable/kit` | type |
| `ThinkingPicker` | `pi-roundtable/kit` | type |
| `ThreadHost` | `pi-roundtable/kit` | type |
| `ToolInput` | `pi-roundtable/kit` | type |
| `VirtualServer` | `pi-roundtable/kit` | type |
| `YesNoQuestion` | `pi-roundtable/kit` | type |
| `activeToolsExtension` | `pi-roundtable/kit` | value |
| `approvalCard` | `pi-roundtable/kit` | value |
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
| `COMPACT_HEADROOM_TOKENS` | `pi-roundtable/kit` | value |
| `CompactionTiers` | `pi-roundtable/kit` | value |
| `compactionEngine` | `pi-roundtable/kit` | value |
| `HARD_COMPACT_TOKENS` | `pi-roundtable/kit` | value |
| `SOFT_COMPACT_TOKENS` | `pi-roundtable/kit` | value |
| `CompactionEngine` | `pi-roundtable/kit` | type |
| `CompactionHistory` | `pi-roundtable/kit` | type |
| `LatestCompaction` | `pi-roundtable/kit` | type |
| `isRuleLoad` | `pi-roundtable/kit` | value |
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
| `workTimeout` | `pi-roundtable/kit` | value |
| `zonedStamp` | `pi-roundtable/kit` | value |
| `AgentPanel` | `pi-roundtable/discord` | type |
| `AgentPanelMessage` | `pi-roundtable/discord` | type |
| `AgentPanelOptions` | `pi-roundtable/discord` | type |
| `CHANNEL_OPERATIONS` | `pi-roundtable/discord` | value |
| `CHANNEL_TOOLS` | `pi-roundtable/discord` | value |
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
| `DiscordAdapterConfig` | `pi-roundtable/discord` | type |
| `DiscordConnection` | `pi-roundtable/discord` | type |
| `DiscordServices` | `pi-roundtable/discord` | type |
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
