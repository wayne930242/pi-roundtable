# pi-roundtable-mcp

Two plugins for [pi-roundtable](https://github.com/wayne930242/pi-roundtable), the Discord agent server:

- `mcpConnectors`: the owner's own MCP connectors.
  The owner adds an external MCP server (Notion, a calendar, anything that speaks MCP over HTTP) with a private Discord form, and the host gets the servers and a routing description for each, to give its agents.
  [ContextForge](#contextforge) holds every upstream server and its token.
- `remoteMcp`: an MCP server over HTTP for agents outside Discord.
  One endpoint relays turns to the agent, for the owner or another principal the dispatch token stands for, and returns the answer when polled.
  Another offers Discord channel tools, only for the channels the owner granted on Discord.

Bun only, like pi-roundtable.
The package ships its TypeScript source, so there is no build step.
MIT licensed.
Source lives in [`packages/mcp`][source] in the pi-roundtable repository and releases in lockstep with the core.
The package name and public API are unchanged from the standalone repository.

[source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/mcp

## What you need

- [Bun](https://bun.sh/docs/installation) 1.3 or newer.
- A running pi-roundtable host, version 0.8 (`pi-roundtable` is a peer dependency, `>=0.8.0 <0.9.0`), with its PostgreSQL.
- For `mcpConnectors`: a [ContextForge](#contextforge) gateway that you run yourself.
- For `remoteMcp`: an HTTPS address that reaches the host's `public` listener, such as a tunnel; this is the host's `http.publicUrl`.

## Install

The migrated package is published by the next new lockstep tag, not by this repository import.
Until then, npm's latest MCP 0.4.1 requires core below 0.6.0 and is not compatible with core 0.7.x.
After the lockstep release:

```sh
bun add pi-roundtable-mcp
```

## Principal migration in 0.9

Follow [Migrating to 0.9](../../docs/migration-0.9.md) when changing the lockstep core and package together.
The dispatch token defaults to the primary owner's principal; 0.8 sessions and schedule authors retain that attribution.
The plugin registers its private scope before runtime use and converges pre-0.9 shared registry records through `CONVERSATIONS.adopt` on startup.
Explicit `principal` bindings need an existing principal with a lasting role; only `token:` identities may be declared by plugins.
A custom `answer` must run as the supplied speaker, never silently as the owner, and must record private ownership before a direct runtime call.
The channel grants of `/mcp/discord/<token>` do not become per-principal grants in this release.

## Configure

List the plugins in `roundtable.config.ts`.
Both read the Discord connection, so they go after the built-in plugins, which is where `plugins` puts them.
Credentials come from the environment; nothing secret belongs in the file.

<!-- example: examples/roundtable.config.ts -->
```ts
import type { RoundtableConfig } from "pi-roundtable";
import { mcpConnectors, remoteMcp } from "pi-roundtable-mcp";

// Credentials come from .env, which Bun loads on its own; nothing secret belongs in this file.
const env = (name: string): string => process.env[name] ?? "";

export default {
	name: "Roundtable",
	owner: { id: env("OWNER_ID"), name: env("OWNER_NAME") },
	discord: {
		token: env("DISCORD_TOKEN"),
		guild: env("DISCORD_GUILD_ID"),
		entryChannel: env("DISCORD_ENTRY_CHANNEL_ID"),
	},
	database: { url: env("DATABASE_URL") },
	dataDir: "./data",
	model: env("MODEL"),
	// The remote MCP endpoints are served on this listener, so PUBLIC_URL must reach it over HTTPS.
	http: { publicUrl: env("PUBLIC_URL") },
	plugins: [
		mcpConnectors({
			contextForge: {
				url: env("CONTEXTFORGE_URL"),
				jwtSecret: env("CONTEXTFORGE_JWT_SECRET"),
				user: env("CONTEXTFORGE_USER"),
			},
		}),
		remoteMcp({
			dispatchToken: env("MCP_DISPATCH_TOKEN"),
			publicUrl: env("PUBLIC_URL"),
		}),
	],
} satisfies RoundtableConfig;
```
<!-- /example -->

### `mcpConnectors(options)`

| Option | Type | Default | What it is |
| --- | --- | --- | --- |
| `contextForge.url` | `string` | required | The gateway's base URL, such as `http://localhost:4444` |
| `contextForge.jwtSecret` | `string` | required | The secret ContextForge signs and verifies its JWTs with (its `JWT_SECRET_KEY`) |
| `contextForge.user` | `string` | required | The admin user the plugin acts as, an email address |
| `serverPrefix` | `string` | `roundtable-conn-` | The start of every connector's virtual server name in ContextForge |
| `maxToolName` | `number` | `45` | Tools whose names are longer are left out of a connector's server, since the model API limits a tool name (64 characters for Claude) and a client may add a prefix of its own |
| `messages` | `Partial<ConnectorMessages>` | English | The Discord text and the registry's refusals, in your wording |

It provides the `CONNECTORS` service (`Connectors`):

| Member | What it is |
| --- | --- |
| `version` | A number that changes on every add, change of purpose, and removal |
| `list()` | Every connector: name, URL, purpose, and its virtual server when it could be read |
| `servers()` | The virtual servers (name, URL, tool names) of the connectors that could be read |
| `profileSources()` | One `{ name, description, serverName }` per connector, the shape a host builds a per-agent MCP profile from |
| `token` | The bearer token that the virtual servers' URLs expect; one per process, valid for a year |
| `resolve(serverName)` | Reads one virtual server's URL and tools by name, for servers the host manages itself rather than as connectors |
| `admin` | `gateways()` and `servers()`: what ContextForge holds, upstream gateways with their state and every virtual server with its tool names, for a host's status view |

The plugin does not decide which agent uses which connector.
The host reads the service, builds its own profiles, and compares `version` with the one it built at.
A plugin registered after `mcpConnectors` can read the list like this:

<!-- example: examples/connector-profiles.ts -->
```ts
import { definePlugin } from "pi-roundtable";
import { CONNECTORS } from "pi-roundtable-mcp";

/**
 * A plugin registered after `mcpConnectors` reads the owner's connectors from the service and builds
 * whatever it needs from them: here, one line per connector for its own routing prompt. `version`
 * changes on every add, change, and removal, so a cache of anything built from the list is stale
 * when the version it was built at is not the current one.
 */
export function connectorRouting(onLines: (lines: string[]) => void) {
	return definePlugin({
		name: "connector-routing",
		requires: [CONNECTORS],
		setup: ({ services }) => {
			const connectors = services.get(CONNECTORS);
			let builtAt = -1;
			let lines: string[] = [];
			return {
				services: [
					{
						name: "connector-routing",
						start: () => {
							if (builtAt !== connectors.version) {
								lines = connectors
									.profileSources()
									.map((source) => `${source.name}: ${source.description}`);
								builtAt = connectors.version;
							}
							onLines(lines);
						},
					},
				],
			};
		},
	});
}
```
<!-- /example -->

The owner manages connectors on Discord with `/<root> connector`, where `<root>` is the host's root command:

| Command | What it does |
| --- | --- |
| `add` | Opens a private form: name, MCP URL, purpose, and an optional token (sent as `Authorization: Bearer`, or under a header name you give). ContextForge stores the token encrypted; Discord shows the form's values to nobody else |
| `list` | Lists the connectors with their tools; the URL is shown as scheme and host only, since some servers keep a credential in the path |
| `describe` | Changes a connector's purpose |
| `remove` | Deletes the connector, its virtual server, and the upstream server with its token |

### `remoteMcp(options)`

| Option | Type | Default | What it is |
| --- | --- | --- | --- |
| `dispatchToken` | `string` | required | The bearer token an outside agent presents at `/mcp/personal`. Make it long and keep it secret |
| `publicUrl` | `string` | required | The HTTPS address that reaches the host's `public` listener. Granted-channel URLs are built on its origin |
| `principal` | `string` | the primary owner | The id of the principal the dispatch token stands for: whose memory, schedules, conversations, and tier the remote turns have. See [whom the token stands for](#whom-the-token-stands-for) |
| `persona` | `string` | a short prompt | The system prompt of the default `remote` conversations. The default names the owner when the token stands for an owner, and no one otherwise |
| `answer`, `claim` | see [below](#when-the-host-runs-the-conversations-itself) | the core's runtime | Give both, or neither |
| `messages` | `Partial<RemoteMcpMessages>` | English | The relay notes (`relayNote` for an owner, `memberRelayNote` for anyone else, which falls back to your `relayNote`), the tool descriptions, and the Discord text, in your wording. `dispatchDescription` and `resultDescription` are functions that receive the tool names |
| `toolNames` | `{ dispatch?: string; result?: string }` | `agent_dispatch`, `agent_result` | The names of the two tools at `/mcp/personal`, for agents that are already set up with other names. The default descriptions follow them |

The plugin serves two endpoints on the host's `public` listener:

| Endpoint | Who may call it | What it offers |
| --- | --- | --- |
| `POST /mcp/personal` | An agent that sends `Authorization: Bearer <dispatchToken>` | `agent_dispatch` starts or continues a conversation and returns `{ runId, sessionId }` at once. `agent_result` polls a run: `working`, `completed` with the text, or `failed` |
| `POST /mcp/discord/<token>` | An agent that holds a bundle's URL | `discord_list_authorized_channels`, and the Discord tools for exactly the operations the bundle's channels were granted |

Each request gets a fresh stateless MCP server.
A browser request (one with an `Origin` header) is refused, and so is a body over 12 MiB.
A run that takes more than 30 minutes is reported failed, and a finished run can be polled for an hour.

The owner grants channels on Discord with `/<root> mcp`:

| Command | What it does |
| --- | --- |
| `authorize` | Run it in the channel to grant. Adds the channel to a bundle (created on first use) and asks which operations to allow: `read`, `send`, `edit`, `pin`, `delete`, `channel`, `permissions`. The first grant of a bundle shows its MCP URL once |
| `grants` | Lists every bundle with its channels, and this channel's recent audit entries |
| `revoke` | Removes a channel from a bundle |
| `describe` | Changes the channel name and purpose that the agent sees (Discord's own name and topic stay) |
| `token` | Replaces a bundle's MCP URL; the old one stops working at once and the channel settings stay |

The plugin provides the `REMOTE_MCP` service (`RemoteMcpService`) for a host that shows the owner what outside agents may reach:

| Member | What it is |
| --- | --- |
| `grants` | `bundles()` and `grants(bundleId?)`, read only: every bundle, and the channel grants of one bundle or of all |
| `describeGrant(client, grant)` | One grant as lines of text for a Discord message: the name the agent sees, where the channel is, its purpose, and the allowed operations, in the plugin's wording |

#### `ChannelGrantStore`

The package also exports the `ChannelGrantStore` class, for host-side imports and tools; the plugin owns the tables.
`ChannelGrantStore.migration` creates them, `ChannelGrantStore.attach(sql)` opens the store over a migrated pool, and `ensureBundle`, `save` and the other methods read and write bundles and grants, so an offline script can move an existing set of grants into the database.
The tables belong to the plugin: change them through the plugin on Discord, or through this class, not by hand.

#### The default conversation

Without `answer` and `claim`, a relayed turn runs on the core: `context.turns.run` of kind `remote`, for the principal the dispatch token stands for (`IDENTITY.speakerFor`, at their tier), in the channel `mcp:<session>`, through the agent server's runtime.
The conversation is recorded as private to that principal.
Nothing is posted to Discord, since no chat surface serves `mcp:` channels; the outside agent polls for the answer.
A relayed message that the host's judge reads as approving held actions confirms them, as the person's own reply would.
Each message begins with a short note that says it was written in an outside agent: for an owner, the note and the persona name the owner, word for word as in 0.8; for anyone else they name no owner, so the agent does not take them for one.
Which of the two is chosen at the start, by whether the principal then holds the owner role.
Starting a remote conversation over archives it, and deleting it also ends the outside agent's session.
Sessions that stay idle for 14 days are deleted once a day.

#### When the host runs the conversations itself

A host that already has its own owner conversations (its own routing, its own prompt) gives `answer` and `claim` together:

<!-- example: examples/host-conversation.ts -->
```ts
import { remoteMcp } from "pi-roundtable-mcp";

/**
 * A host that runs the owner's conversations itself passes `answer` and `claim` together. `answer`
 * runs one turn and never rejects; it joins the channel's queue itself. `claim` says what the
 * claim over the `mcp:<session>` channels does with those conversations.
 */
export function hostRemote(dispatchToken: string, publicUrl: string) {
	return remoteMcp({
		dispatchToken,
		publicUrl,
		// `speaker` is the principal the dispatch token stands for.
		answer: async (channel, text, speaker) => ({
			ok: true,
			text: `Answered ${speaker.name}'s ${text.length} characters in ${channel}.`,
		}),
		claim: {
			// The string names whose conversation it was: the host's own kind.
			startFresh: async () => "owner",
			deleteConversation: async () => undefined,
		},
	});
}
```
<!-- /example -->

- `answer(channel, text, speaker)` runs one turn and never rejects.
  `speaker` is whom the turn is for: the principal the dispatch token stands for, from `IDENTITY.speakerFor`.
  Run the turn as `speaker`, such as by passing it to `context.turns.run`: its tier decides the tools and its principal the memory.
  An `answer` that ignores it, such as one that runs every turn as the owner, gives whoever holds the token owner turns, and `principal` then only decides whose the sessions are.
  The plugin does not queue it, so it joins the channel's queue itself (`context.queue.run`).
  The host owns the conversations' kind and persona, so the plugin contributes no persona in this mode.
- `claim` is what the claim over the `mcp:<session>` channels does with those conversations: `startFresh` (required; the string it returns is the conversation's kind), `deleteConversation` (required; the plugin removes the session record after it), and optional `stop` and `background`.
  A claim without `background` skips background turns.

#### Whom the token stands for

The dispatch token is the identity `token:<toolNames.dispatch, or remote-mcp>`, which the plugin declares in its `identities`.
At every start the host links it to `principal`, or to the primary owner without one, as in 0.8.
`roundtable principal list` shows it under that principal as `token:remote-mcp  (plugin remote-mcp)`, and `roundtable principal unlink` refuses it: change the option instead.
The start stops when the principal does not exist, or when the identity is linked to someone else by the configuration or the CLI; the error names what to change.

Bound to a member, a remote turn reads and changes the member's memory, and only the tools of their tier are offered; when the host runs the conversations itself, that holds only if its `answer` runs the turn as the `speaker` it receives.
Give that member a lasting role with `roundtable principal grant <principal> member` (or `admin`).
A remote turn does not record them as seen, so a member whose tier comes only from what a surface reports stops being served `access.backgroundStaleDays` (30 by default) after they were last seen elsewhere: every remote run fails until they are seen again.

Changing `principal` and restarting moves the token.
Each session belongs to the principal it was opened for: after a move, continuing a session of the earlier principal answers `SESSION_NOT_FOUND`, and moving back makes it continue.
Sessions 0.8 opened belong to the primary owner.
The tool descriptions the outside agent reads still say "the owner"; give `dispatchDescription` in `messages` for other wording.

## The grant and security model

- **The dispatch token is the voice of the principal it stands for.** Whoever holds it can send the agent messages as that principal (the primary owner by default: owner tier, with every tool the owner's agent has), and can approve the held actions of its turns by saying so. Keep it secret, change it by changing the option, and serve the endpoint only over HTTPS.
- **A bundle URL is a credential.** It carries 32 random bytes; only its SHA-256 hash is stored, and the URL is shown once, when the bundle is created or replaced. Everyone holding it can use every channel in the bundle with the operations granted there, and nothing else.
- **The owner approves each grant on Discord.** Only the owner can use the commands. A grant needs the owner to hold *Manage Channels* in the channel, and both the owner and the bot to hold the Discord permissions behind every operation chosen, so a grant never exceeds what both may do. The pending choice expires after five minutes.
- **Every call is checked again.** The grant, the guild, and the bundle's token are read after Discord is inspected, so a revoke or a replaced URL stops a call in flight. Each call is written to an audit table before it runs and marked afterwards.
- **Failures say little.** An outside agent gets an error code, never a stack trace or the URL; a failed run shows a fixed message, and the details go to the host's log. Messages in channels are untrusted data, and the tool descriptions say so.

## ContextForge

[ContextForge](https://github.com/IBM/mcp-context-forge) is IBM's open-source MCP gateway: it federates MCP servers behind one endpoint, keeps each upstream server's credentials, and lets you expose chosen tools as a *virtual server*.
`mcpConnectors` uses it through its admin API (`/gateways`, `/tools`, `/servers`), signing a short admin JWT with `contextForge.jwtSecret`.
**This package does not run ContextForge.**
Run it yourself, next to the host, following its own [quick start](https://github.com/IBM/mcp-context-forge#quick-start---containers), with the same `JWT_SECRET_KEY` that you give the plugin, and point `contextForge.url` at it.
The host's agents then reach a connector through the connector's virtual server URL, with `CONNECTORS.token` as the bearer token.

## Wording

pi-roundtable's message catalog is closed to plugins, so these plugins keep their text in English and take a `messages` option of their own: a partial object laid over the defaults.
Entries that take values are functions.
The types `ConnectorMessages` and `RemoteMcpMessages` are exported and list every key, each with a comment that says where it is read.
Every sentence a Discord user or an outside agent reads is a key, including the errors of the ContextForge client, the description of a connector's virtual server (`serverDescription`), the human part of a granted tool's error (`operationFailed`, `outcomeUnrecorded`, joined to the fixed error code by `codeDetail`), and the separators (`labelSeparator`, `listSeparator`).
The machine error codes (`CHANNEL_NOT_AUTHORIZED`, `DISCORD_OPERATION_FAILED`, ...) stay fixed, since outside agents match on them.
`contextForgeRefused` and `contextForgeNotJson` receive ContextForge's answer with the request's token and any credential in the upstream URL already masked, so a wording of your own cannot leak them.
Operation labels (`read`, `send`, ...) come from pi-roundtable and follow the host's language.

## Database

Each plugin declares its migrations; the host runs them before any setup.
Tables: `owner_connectors`; `discord_mcp_bundles`, `discord_channel_grants`, `discord_channel_audit`, `remote_agent_sessions` (with `principal_id`, the migration `remote-sessions-principal`).

## Development

From the pi-roundtable repository root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/mcp typecheck
bun run --cwd packages/mcp lint
bun run --cwd packages/mcp test
```

Tests that need PostgreSQL are skipped unless `ROUNDTABLE_TEST_DATABASE_URL` points at a throwaway test database:

```sh
ROUNDTABLE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/roundtable_test bun run --cwd packages/mcp test
```

Shared CI runs them against a PostgreSQL service.
Before the next lockstep release, the owner moves the existing npm trusted publisher to this repository's `publish.yml`; no manual MCP publication is needed.
See [workspace releases][releases].

[releases]: https://github.com/wayne930242/pi-roundtable/blob/master/.github/PACKAGE-RELEASES.md

## License

MIT
