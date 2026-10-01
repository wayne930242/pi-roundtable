# pi-roundtable

A Discord agent server on [Pi](https://github.com/earendil-works/pi).
You get a team of AI agents in one Discord server: each agent owns a channel and a conversation, they share tools and memory, and you extend the bot with plugins written in TypeScript.

- Built for one owner and one Discord server. Others can be allowed to talk to the agents, but that setup, and its risks, are the operator's.
- Bun only. The package ships its TypeScript source, so there is no build step.
- MIT licensed.

## What you need

- [Bun](https://bun.sh/docs/installation) 1.3 or newer.
- PostgreSQL. The project `init` creates has a `docker-compose.yml` that runs one.
- A Discord bot: an application with a bot user, the Message Content intent turned on, and an invitation to your server.
- A model login: the API key of the provider of the model you choose (`ANTHROPIC_API_KEY` for `anthropic/...`), or a login made with Pi.
- An address that reaches the process from the internet, such as a tunnel, because Discord fetches the agents' avatars from it.

## Five minutes

```sh
npx pi-roundtable init my-bot    # or: bunx pi-roundtable init my-bot
cd my-bot
bun install
docker compose up -d             # PostgreSQL, matching .env.example
cp .env.example .env             # then fill it in
bunx roundtable doctor
bunx roundtable start
```

`init` writes a working project and asks for no secret.
It refuses to write anything when Bun is missing or too old, or when a file it would create already exists.

### `.env`

`.env.example` says where each value comes from.
Bun loads `.env` by itself, and `.gitignore` keeps it out of Git.

| Variable | What it is |
|---|---|
| `DISCORD_TOKEN` | The bot's token, from the application's Bot page |
| `DISCORD_GUILD_ID`, `DISCORD_ENTRY_CHANNEL_ID` | The server and the channel where the coordinating agent lives (turn on Developer Mode, then right-click to copy ids) |
| `OWNER_ID`, `OWNER_NAME` | You: the one person who can change everything |
| `DATABASE_URL` | PostgreSQL; the default matches `docker-compose.yml` |
| `MODEL` | The agents' model, `<provider>/<id>` |
| `PUBLIC_URL` | The address that reaches this process from the internet |

### `doctor`

`bunx roundtable doctor` checks, in order, and prints each check as passed or failed with how to fix it:

1. Bun's version.
2. `.env` has a value for every variable `.env.example` lists.
3. `roundtable.config.ts` against its schema, naming the failing key.
4. Every plugin loads, and no two share a name.
5. Whether a plugin fills the `images` slot. Without one is not a failure: agents get avatars generated from their display names.
6. PostgreSQL is reachable and migratable.
7. The Discord token is valid, the bot is in your server, the Message Content intent is on, and the bot has the permissions it needs in the entry channel (including Pin Messages).
   When the bot is not in the server, the fix is an invitation link that asks for exactly those permissions.
8. The model login exists.
9. `PUBLIC_URL` is a well-formed address; with `--reachable` it also has to answer, which is only true while the bot runs.

It exits non-zero on any failure and changes nothing it checked.
A fresh project fails only on the credentials you have not entered yet, and says which.

### `start`

`bunx roundtable start` runs the checks that need no network, stops with the same message `doctor` prints when one fails, and otherwise starts the bot.
Once it runs, the agents in `agents.ts` have their channels, and `/roundtable help` opens the control panel.
On `SIGTERM` or `SIGINT` it finishes running work before it stops.

## A plugin

`roundtable add plugin <name>` creates `plugins/<name>.ts` and its test and lists it in `roundtable.config.ts`.
A plugin is an object with a name and a `setup` function that returns what it adds; this one gives every agent a tool:

```ts
import { definePlugin, defineTool } from "pi-roundtable";
import { Type } from "typebox";

export const hello = definePlugin({
	name: "hello",
	setup: () => ({
		tools: [
			defineTool({
				name: "hello_greet",
				description: "Greet someone by name. Call it when asked to say hello.",
				parameters: Type.Object({ who: Type.String() }),
				minTier: "member",
				run: ({ who }) => `Hello, ${who}!`,
			}),
		],
	}),
});
```

It is tested without Discord or PostgreSQL:

```ts
import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { hello } from "./hello.ts";

test("hello greets", async () => {
	const harness = await testPlugin(hello);
	expect(await harness.runTool("hello_greet", { who: "Ada" })).toBe("Hello, Ada!");
	await harness.stop();
});
```

The [plugin guide](docs/plugins.md) explains every part a plugin can add (tools, prompt sections, agents, events, services, migrations, providers, slash commands, HTTP routes, and more), the order things start and stop in, and every startup error with its fix.
Its examples live in [`examples/`](examples), and the test suite runs each of them.
`pi-roundtable/kit` supplies claim, tool and presentation helpers and type-only names for the context’s existing services, and `pi-roundtable/discord` supplies the slash-command registrar, owner-command and panel helpers, and the agent panel, and is the entry that names discord.js types (`pi-roundtable/testing` names a few, through `testHost`'s composed commands); both are unstable before 1.0 and not covered by semver.

## Settings

`roundtable.config.ts` holds the settings and the list of plugins.
An unknown key is an error that names the closest known one.

The language of what the bot shows in Discord is the `locale` setting: `en` by default, or `zh-TW`.

```ts
export default {
	// ...
	locale: "zh-TW",
	timeZone: "Europe/Berlin", // the zone schedules and time stamps use; default UTC
	plugins: [hello],
} satisfies RoundtableConfig;
```

## Commands

| Command | What it does |
|---|---|
| `roundtable init [dir]` | Creates a project in `dir` (default: the current directory) |
| `roundtable doctor [--reachable]` | Checks the setup and says how to fix what is wrong |
| `roundtable start` | Runs the checks that need no network, then the bot |
| `roundtable add plugin <name>` | Adds `plugins/<name>.ts` and its test, and lists it in the config |

## Changes and license

[CHANGELOG.md](CHANGELOG.md) lists every change to the package's exported names.
[MIT](LICENSE).
