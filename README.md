# pi-roundtable

English | [Traditional Chinese](README.zh-TW.md)

Docs: <https://pi-roundtable.wayneh.tw>
Source and issues: <https://github.com/wayne930242/pi-roundtable>

An agent server on [Pi](https://github.com/earendil-works/pi) that you talk to through Discord, or through a web chat.
In Discord, each AI agent has its own channel and conversation in your server, and they share tools and memory.
On the web, people your OpenID Connect provider signs in chat with an assistant in private conversations, through [pi-roundtable-webchat](packages/webchat).
You can extend the bot with TypeScript plugins.

- Built for one owner.
  Discord and the web chat both work, and you can let other people talk to the assistant, but running it for several people is at the operator's risk: read the [threat model](#threat-model) first.
- Bun only.
  The package ships its TypeScript source, so there is no build step.
- MIT licensed.

## What you need

- [Bun](https://bun.sh/docs/installation) 1.3 or newer.
- PostgreSQL.
  The project `init` creates has a `docker-compose.yml` that runs one.
- A model login: the API key of the provider of the model you choose (`ANTHROPIC_API_KEY` for `anthropic/...`), or a login made with Pi.
- For Discord: a Discord bot (an application with a bot user, the Message Content intent turned on, and an invitation to your server), and an address that reaches the process from the internet, such as a tunnel, because Discord fetches the agents' avatars from it.
- For the web chat: an OpenID Connect provider that issues access tokens for the chat's API, and a reverse proxy that serves the host over HTTPS.

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

`init` writes a working project without asking for secrets.
It refuses to write anything when Bun is missing or too old, or when a file it would create already exists.
`init --adapter web` writes a project without Discord around the web chat instead; see [web chat](#web-chat).
Both load the Pi package pi-self-compact, whose `compact_session` tool every session needs.

### `.env`

`.env.example` says where each value comes from.
Bun loads `.env` by itself, and `.gitignore` keeps it out of Git.

| Variable | What it is |
| --- | --- |
| `DISCORD_TOKEN` | The bot's token, from the application's Bot page |
| `DISCORD_GUILD_ID`, `DISCORD_ENTRY_CHANNEL_ID` | The server and the channel where the coordinating agent lives (turn on Developer Mode, then right-click to copy ids) |
| `OWNER_ID`, `OWNER_NAME` | You: the one person who can change everything |
| `DATABASE_URL` | PostgreSQL; the default matches `docker-compose.yml` |
| `MODEL` | The agents' model, `<provider>/<id>` |
| `PUBLIC_URL` | The address that reaches this process from the internet |

A web chat project asks for `OWNER_NAME`, `DATABASE_URL`, and `MODEL`, and for the OpenID Connect issuer, audience, and signing keys address, the roles that may chat, and the origins of the pages that open it.

### `doctor`

`bunx roundtable doctor` checks, in order, and prints each check as passed or failed with how to fix it:

1. Bun's version.
2. `.env` has a value for every variable `.env.example` lists.
3. `roundtable.config.ts` against its schema, naming the failing key.
4. Every plugin loads, and no two share a name.
5. Whether a plugin fills the `images` slot.
   The check passes with or without one; agents without an image provider get avatars generated from their display names.
6. PostgreSQL is reachable and migratable.
7. With Discord configured: the Discord token is valid, the bot is in your server, the Message Content intent is on, and the bot has the permissions it needs in the entry channel (including Pin Messages).
   When the bot is not in the server, the fix is an invitation link that asks for exactly those permissions.
8. The model login exists.
9. With Discord configured: `PUBLIC_URL` is a well-formed address; with `--reachable` it also has to answer, which is only true while the bot runs.

It exits non-zero on any failure and changes nothing it checked.
A fresh project fails only on the credentials you have not entered yet, and says which.

### `start`

`bunx roundtable start` runs the checks that need no network, stops with the same message `doctor` prints when one fails, and otherwise starts the bot.
The running bot gives the agents in `agents.ts` their channels, and `/roundtable schedule list` shows their schedules.
On `SIGTERM` or `SIGINT` it finishes running work before it stops.

## A plugin

`roundtable add plugin <name>` creates `plugins/<name>.ts` and its test and lists it in `roundtable.config.ts`.
`roundtable add package <spec>` does the same for a Pi package from npm: it installs the package and writes a plugin that loads its extensions and selects its tools.
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

You can test it without Discord or PostgreSQL:

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
`pi-roundtable/kit` supplies claim, tool and presentation helpers and type-only names for the context’s existing services.
`pi-roundtable/discord` supplies the slash-command registrar, owner-command and panel helpers, and the agent panel.
It is the entry that names discord.js types (`pi-roundtable/testing` names a few, through `testHost`'s composed commands).
Both follow the main entry's versioning: before 1.0, breaking changes come in minor releases and are listed in the changelog.

## Web chat

The package [pi-roundtable-webchat](packages/webchat) is a chat network that comes as a plugin: a WebSocket and a REST API under `/chat` on the host's listener.
People your OpenID Connect provider signs in open private conversations with the personas you list, see each turn's text and tools as it runs, and answer approval cards for held calls.
A host whose configuration has no `discord` and lists `webChat({ ... })` in `plugins` is a web-only assistant; `roundtable init --adapter web` creates one.

```sh
npx pi-roundtable init my-desk --adapter web
```

Its README describes the protocol, the access map, the limits, and the [provider settings](packages/webchat/README.md#provider-settings) that keep one person one identity, such as a stable subject claim and a pinned tenant.

## MCP connectors

The separate package [pi-roundtable-mcp](https://www.npmjs.com/package/pi-roundtable-mcp) connects the bot to the MCP ecosystem in both directions, with two plugins:

- `mcpConnectors`: you add an MCP server in Discord with a private form, such as Notion, a calendar, or anything that speaks MCP over HTTP.
  Your code then gives its tools to the agents you choose.
  A [ContextForge](https://github.com/IBM/mcp-context-forge) gateway that you run keeps each server and its token.
- `remoteMcp`: an agent outside Discord sends your agent a message over MCP and reads the answer.
  It can also use the Discord channels you grant, with only the operations you choose.

```sh
bun add pi-roundtable-mcp
```

It releases in lockstep with pi-roundtable, and its README lists every option.

## Settings

`roundtable.config.ts` holds the settings and the list of plugins.
An unknown key is an error that names the closest known one.

`locale` sets the language of the bot's Discord text: `en` by default, or `zh-TW`.

```ts
export default {
	// ...
	locale: "zh-TW",
	timeZone: "Europe/Berlin", // the zone schedules and time stamps use; default UTC
	plugins: [hello],
} satisfies RoundtableConfig;
```

## Threat model

pi-roundtable runs one assistant for one owner.
It does not yet isolate the people it talks to from each other the way a multi-user service must; whoever lets others in takes that on.

- **Who is trusted.** The operator controls the host, its configuration, and its credentials. The owner (`owner.id`) may use every tool. Everyone else is admitted at a tier, `member` or `admin`: in Discord from user and role ids in `speakers`, on the web from the access map over the token's roles. No token claim makes anyone the owner.
- **What a turn may do.** A turn gets only the tools its speaker's tier holds, and a tool no plugin gives a tier is the owner's alone. Tools run in the host process, with its files and its network: `web_search` and `fetch_content` can reach internal addresses, so name the tools of a web persona in its `selection`. Plugins run in the same process, with the same access.
- **Approvals.** A held call is approved only by the speaker whose turn held it, at a tier that still holds the call, or by the owner, on its card or by a confirming message.
- **Conversations.** In Discord an agent's channel and a group room are shared: everyone who writes there adds to one conversation the agent reads. A web chat conversation belongs to the person who opened it; only they may read it, write in it, or answer its prompts.
- **Memory.** Each speaker's memory is their own. One person who writes from Discord and from the web has two identities, and two memories, until principals arrive in 0.9.
- **Model credentials.** Every turn, whoever speaks, runs on the host's model login and is billed to it. Per-person credentials are planned for a later release.
- **Data.** Conversations, memory, and schedules sit unencrypted in PostgreSQL and the data directory.

## Upgrading

[Migrating to 0.8](docs/migrating-0.8.md) covers upgrading a Discord project from 0.7, which needs no configuration change, and starting a host without Discord.

## Commands

| Command | What it does |
| --- | --- |
| `roundtable init [dir] [--adapter discord\|web]` | Creates a project in `dir` (default: the current directory) that talks through Discord (the default) or through pi-roundtable-webchat |
| `roundtable doctor [--reachable]` | Checks the setup and says how to fix what is wrong |
| `roundtable start` | Runs the checks that need no network, then the bot |
| `roundtable add plugin <name>` | Adds `plugins/<name>.ts` and its test, and lists it in the config |
| `roundtable add package <spec>` | Installs a Pi package with `bun add` and adds a plugin that loads it and gives its tools to every agent turn |

## Changes and license

[CHANGELOG.md](CHANGELOG.md) lists every change to the package's exported names.
[MIT](LICENSE).
