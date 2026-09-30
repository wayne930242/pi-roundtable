# Writing plugins for pi-roundtable

This guide is for someone who has run `npx pi-roundtable init` and wants the bot to do something it does not do yet.
Read it once, top to bottom, and you can write, test, and run a plugin.

Every code block below marked with `example:` is a real file under [`examples/`](../examples), and the test suite fails when a block here differs from its file.
Each example has a test next to it that runs it without Discord or PostgreSQL, except the one that needs a database, which says so.

## What a plugin is

A plugin is an object with a name and a `setup` function.
`setup` returns the parts the plugin adds to the bot: tools agents can call, text added to their prompt, agents to create, handlers for events, long-lived services, slash commands, HTTP routes, and so on.
The bot itself is assembled from plugins too: the core ships built-in plugins for its stores, Discord connection, agent server, skills, memory, notifications, delegation, and schedules, and yours are added after them.

You write plugins in TypeScript, list them in `roundtable.config.ts`, and Bun loads them directly.
There is no build step and no plugin registry: importing a plugin is how you install it.

```ts
// roundtable.config.ts
import type { RoundtableConfig } from "pi-roundtable";
import { notes } from "./plugins/notes.ts";

export default {
	// ...the settings `init` wrote...
	plugins: [notes],
} satisfies RoundtableConfig;
```

Everything a plugin author needs comes from two entries, and nothing else can be imported from the package:

| Entry | What it exports |
|---|---|
| `pi-roundtable` | `definePlugin`, `defineTool`, `defineRoundtable`, `ToolRefusal`, `PluginError`, `NotLinkedError`, `Roundtable`, and the types (`Tier`, `Speaker`, `Contribution`, `PluginContext`, and so on) |
| `pi-roundtable/testing` | `testPlugin`, the harness that runs a plugin against a fake context |

`roundtable add plugin <name>` creates `plugins/<name>.ts` and its test from a small template and lists it in `roundtable.config.ts`.
The name is lowercase words joined by dashes, such as `my-notes`.

## The plugin object

```ts
definePlugin({
	name: "my-notes",          // lowercase words joined by dashes; unique across all plugins
	migrations: [],            // optional: tables the plugin needs
	providers: {},             // optional: replaces a part the core runs on
	preflight() {},            // optional: a check that runs before anything starts
	setup(context) {           // required: returns the parts the plugin adds
		return { /* parts */ };
	},
});
```

`definePlugin` returns the object it was given, typed, after checking the name and that `setup` is there, so a mistake shows where the plugin is written.

A plugin must add something.
A plugin whose `setup` returns `{}` and that has no migrations, providers, or hooks stops the start (see [Errors](#errors-and-their-fixes)).

### The context

`setup` receives a `PluginContext`:

| Field | What it is |
|---|---|
| `logger` | A pino logger; each line is JSON on stdout |
| `database()` | The host's one PostgreSQL connection (a Bun `SQL`), already migrated |
| `toolTiers` | What each tool needs; ask it when a tool is used, not during setup |
| `events` | Where the core reports turns and team changes to every plugin's handlers |
| `providers` | Each provider slot, from the plugin that fills it or the core's default |
| `queue` | The one channel queue that every conversation and channel operation shares |
| `core` | What the built-in plugins built (stores, the Discord surface, the team, the runtime), for advanced plugins |
| `sessions()`, `conversations`, `dashboard()` | Linked once every plugin has been set up; calling them during `setup` throws `NotLinkedError` |

Use `sessions()`, `conversations`, and `dashboard()` from a service's `start` or from an event handler, not from `setup`.

## Tiers: who may use what

Every turn is for a speaker, and a speaker has a tier: `owner`, `admin`, or `member`, from most to least trusted.
With nothing configured only the owner speaks.
An operator who opens the bot to others lists them under `speakers` in `roundtable.config.ts` and owns that setup.

A tool must say which tier may call it.
The tool is offered only in turns whose speaker is at that tier or above, and the operator's `toolTiers` setting can override what the plugin chose.
A tool nobody named needs the owner.

## The parts

Each heading below is a key `setup` may return.
A key the contract does not have stops the start and names the closest one.

### `tools`: what agents can call

`defineTool` takes a name (lowercase words joined by underscores), a description the model reads to decide when to call it, a Typebox parameter schema, the lowest tier that may call it, and the function.
`run` receives the arguments, already typed, and the turn: the speaker, the channel, the agent, and an abort signal.
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

### `holdRules`, and a tool's `hold`: calls that wait for the owner

A held call is described to the owner, who approves or refuses it in Discord before the call runs.
A tool's `hold` returns the description for its own calls, and `holdRules` are rules over every tool call, asked in order until one describes the call.
Each rule needs a name, unique across plugins.

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
The first start creates the agents that are not stored yet and never overwrites one that is, so agents are edited in Discord afterwards.
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
| `agentServer(outcome)` | The agent server has started (`"ready"`) or failed to (`"failed"`); the rest of the process runs either way |
| `turnStarted(turn)` | An agent's turn began |
| `turnEnded(turn)` | An agent's turn ended; `turn.result` is `"ok"`, `"failed"`, or `"stopped"` |
| `changed()` | The team changed: an agent or group was created, edited, arranged, archived, or started over |
| `shutdown(left)` | The shutdown drain ended, before any service stops; `left` lists the work it gave up on |

A handler that throws is logged and never stops the others.

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
					lines.push(`${turn.agent} started`);
				},
				turnEnded: (turn) => {
					lines.push(`${turn.agent} ${turn.result}`);
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

A test calls a handler itself with the payload the core sends: a turn is `{ agent, channel, speaker }` (plus `group` for a member's turn in a group), `turnEnded` adds `result`, `changed` takes nothing, and `shutdown` takes the list of unfinished work, which `harness.stop()` delivers as an empty one.

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
`busy` lists the work still running, one entry each; a shutdown waits until every service's list is empty, so a deploy never cuts work short.

Use a service for anything with a lifetime: a timer, a queue, a connection.
There is no separate part for schedules: agents create schedules with the built-in `schedule_create` tool, the built-in scheduler fires them, and a scheduled turn is an ordinary agent turn that can call your tools.
A plugin that needs its own timer writes a service like this one.

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

### `migrations` and `context.database()`: tables of your own

`migrations` sits on the plugin, not in what `setup` returns.
Every start runs every plugin's migrations, in plugin order, before any `setup`, so a table is there when `setup` asks for the database.
A migration is `{ name, up(sql) }`, and `up` must be idempotent (`CREATE TABLE IF NOT EXISTS`) because it runs again over the existing schema on every start.
Migration names and table names are shared with the core and with every other plugin, so prefix them with your plugin's name.

`testPlugin` gives your plugin the database you pass it but does not run its migrations; run them yourself first, as this example's test does.
This is the one example whose test needs PostgreSQL: it is skipped unless `ROUNDTABLE_TEST_DATABASE_URL` is set.
The package exports no client of its own for tests, so the test opens a Bun `SQL` on that URL, runs the migrations twice, passes the client to `testPlugin`, and drops its table in `finally`.
Point the variable at a database you can write to and lose:

```sh
ROUNDTABLE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/plugin_test bun test
```

<!-- example: examples/migrations.ts -->
```ts
import { definePlugin, defineTool } from "pi-roundtable";
import { Type } from "typebox";

/**
 * Migrations create the plugin's tables before any setup runs, on every start, so they must be
 * idempotent. Their names and the tables are shared with every other plugin: prefix them.
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
				await migration.up(sql); // Idempotent: the host runs it on every start.
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
There are two slots, and one plugin may fill each.

| Slot | The core's default | Your replacement |
|---|---|---|
| `judge` | Asks the configured model small questions: does this reply approve the held actions, how hard is this turn, which agents does this group message concern | An object with `askYesNo`, `askChoice`, and `askScore` |
| `images` | No drawing; agents keep the neutral avatar | `async (prompt, references) => bytes` returning PNG bytes |

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

### `interactions`: slash commands

A subcommand goes under the one root command, `/roundtable` unless `discord.rootCommand` says otherwise.
The `module` answers the interactions Discord sends and returns `true` for the ones it handled; `commands()` returns top-level commands of its own, and never the root.

<!-- example: examples/interactions.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/**
 * Interactions add slash commands. A subcommand goes under the one root command (`/roundtable`
 * by default); the module answers the interactions Discord sends and returns true for the ones it handled.
 */
export const ping = definePlugin({
	name: "ping",
	setup: () => ({
		interactions: [
			{
				rootOptions: [
					{ type: 1, name: "ping", description: "Check that the bot answers" },
				],
				module: {
					commands: () => [],
					handle: async (interaction) => {
						if (!interaction.isChatInputCommand()) return false;
						if (interaction.options.getSubcommand(false) !== "ping")
							return false;
						await interaction.reply("pong");
						return true;
					},
				},
			},
		],
	}),
});
```
<!-- /example -->

### `http`: routes on the bot's listener

The configuration's `http` block opens one listener, named `public`, and `http.publicUrl` is the address that reaches it from the internet; the agents' avatars are served from it.
A route names the listener, a path (`{ exact }` or `{ prefix }`), optionally the methods, and a handler that gets a `Request` and returns a `Response`.
Two routes that could take the same request are refused, so a route cannot shadow the avatars.
Anything on this listener is reachable from the internet: check a secret in the handler before doing anything.

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

It is a function, read before each turn, so a set that changes while the process runs stays current.
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

Names of npm packages, installed in your project (`bun add pi-web-access`), whose Pi extensions every conversation session loads.
Two plugins that name the same package load it once.

<!-- example: examples/packages.ts -->
```ts
import { definePlugin } from "pi-roundtable";

/** Pi packages are npm packages whose Pi extensions every session loads; install each one in your project first. */
export const webSearch = definePlugin({
	name: "web-search",
	setup: () => ({
		piPackages: ["pi-web-access"],
	}),
});
```
<!-- /example -->

### `sessionTools`: the raw form of `tools`

A session tool is a Pi extension placed in every conversation session by its phase: `tools`, `compaction`, or `mcp`.
Reach for it only when `defineTool` cannot express what you need, such as a tool whose set changes while the process runs (bump `revision`) or a tool that depends on the session.
The extension's name must be unique, and a plugin may not take the name of a core extension (`read-attachment`, `confirmation-gate`, `ask-user`, `self-compact-guard`, `profile-tools`).
At most one plugin may add a `compaction` extension, and it must name the `engine` its compactions record.

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
Most plugins never need one: the built-in agent server already owns the agents' channels.

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

### What plugins do not extend

`useCommands`, `agentServer`, and `stopTurn` are hooks on the plugin that the built-in plugins use to receive the composed commands, start the agent server, and stop a running turn.
Only one plugin may start the agent server, and the built-in `agent-server` already does; a plugin that tries is refused.

## Testing a plugin

`testPlugin(plugin, options?)` sets one plugin up against a fake context and starts its services, with no Discord and no PostgreSQL unless you pass `{ database }`.
It returns:

| Field | What it is |
|---|---|
| `contribution` | What the plugin added, as the host would collect it: `tools`, `prompt`, `seeds`, `events`, `services`, `interactions`, `http`, and the rest |
| `tools`, `tiers` | The tool names, and the table that says what tier each needs |
| `runTool(name, args, { speaker }?)` | Runs a tool the way an agent's turn would, and returns the text the model reads |
| `events` | The events the plugin itself reported through `context.events` |
| `stop()` | Delivers `shutdown` and stops the services in reverse |

The harness applies the same checks as the host (a plugin that adds nothing, an unknown part, a clash of names, a tool with no tier), so a mistake fails your test with the message the start would print.
It does not run migrations (see [`migrations`](#migrations-and-contextdatabase-tables-of-your-own) for a test that does), it does not deliver the core's events (call the handlers yourself, as [`events`](#events-hear-what-the-core-does) shows), and it does not build a prompt (call `contribution.prompt`'s `build` yourself, as [`prompt`](#prompt-text-added-to-every-agent-turn) shows), and `sessions()` and `conversations` throw `NotLinkedError` in it, as they do in `setup`.

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

## What happens when the bot starts and stops

`roundtable start` first runs the checks that need no network (Bun, `.env`, the configuration, the plugins, the model login, the public URL), and stops with the message `roundtable doctor` prints for a failed one.
Then the host runs `run()`:

1. Providers are resolved: each slot from the plugin that fills it, or the core's default.
2. The database is opened and every plugin's migrations run, in plugin order.
3. Every plugin's `setup` runs, in plugin order.
   The order is the built-ins (`stores`, `discord`, `modules`, `agent-server`, `seeds`), then yours in the order of `plugins` in `roundtable.config.ts`, then the built-in `schedules`, so a due schedule fires only once everything it can reach is running.
4. The contributions are linked: tool tiers, hold rules, the session plan, the channel router, and the events.
   From here `sessions()`, `conversations`, and `dashboard()` work.
5. Every plugin's `preflight` runs, in plugin order.
6. The composed slash commands are handed to the plugins that take them.
7. Every service starts: the plugins' in plugin order, and each plugin's own in the order it listed them.
8. The HTTP listener opens.
9. The agent server starts in the background, and then every plugin hears `agentServer("ready")` or `agentServer("failed")`.

Nothing reaches Discord or the listener unless steps 1 to 5 succeeded.

On `SIGTERM` or `SIGINT` the bot stops serving new work last:

1. It keeps serving until no service reports `busy()` work, for at most an hour; whatever is left is logged and given up on.
2. Every plugin hears `shutdown(left)`, while every service is still running.
3. The HTTP listener closes, so no request reaches a service that has stopped.
4. Services stop in the reverse of the order they started.
5. The database pool closes, and the process exits.

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
| `plugin <name>: setup returned an unknown part "<key>". Did you mean "<closest>"? The parts are services, events, interactions, http, holdRules, piPackages, sessionTools, channels, dashboard, tools, seeds, prompt, agentSelection.` | Fix the key; `migrations`, `providers`, and `preflight` belong on the plugin, not in what `setup` returns |

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
| `plugins <a> and <b> both start the agent server. Keep one.` | Do not define `agentServer` on your plugin; the built-in one starts it |
| `session tool <name> takes a core extension name. Rename it.` | Pick a name other than the core's |
| `two plugins are named <name>.` (from `roundtable doctor`) | Rename yours; the built-in plugins are `stores`, `discord`, `modules`, `agent-server`, `seeds`, and `schedules` |
| `migration <name> is declared twice` | Migration names are shared by every plugin: prefix each with its plugin's name |
| `/<root> <name> is added twice`, `/<name> is registered twice` | Give each slash command and subcommand its own name |
| `route <name> is registered twice`, `routes <a> and <b> overlap on listener <id>` | Give each route its own name and a path no other route can take |

### Things used before they are ready

`sessions()`, `conversations`, and `dashboard()` are linked after every plugin is set up.
Calling one from `setup` fails, and the message says when it becomes ready:

```text
plugin <name>: setup failed: session parts are linked once every plugin is set up. Call sessions() from a service's start or from a handler, not during setup. Fix the error, or remove the plugin.
```

The same message exists for `conversations` (`Use them from a service's start or from a handler, not during setup.`) and for `dashboard()`.
The fix is the one it says: move the call into a service's `start` or into an event handler.

`context.core.<service>` before the built-in plugin that provides it has run throws `core service <name> is not provided yet. Register the built-in plugin that provides it before the plugin that reads it.`
Your plugins always run after the built-ins, so this shows only in `testPlugin`, which has none: pass what you need or test that part elsewhere.

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

### Missing settings

| Message | Fix |
|---|---|
| `interactions need a configured root command` | Only reachable if you build the host yourself; `defineRoundtable` always sets it |
| `migrations need a configured database` | Only reachable if you build the host yourself; `defineRoundtable` always sets it |
| `no database is configured` | In `testPlugin`, pass `{ database }` to a plugin that calls `context.database()` |
| `route <name> needs listener <id>, which is not configured` | Use the listener `public` |

## Changing the bot's language

The text the bot shows in Discord comes from a message catalog chosen by `locale` in `roundtable.config.ts`: `en` (the default) or `zh-TW`.
Both catalogs have the same keys.
Your own plugins' text is yours to write in any language.
