# Migrating to pi-roundtable 0.8

0.8 makes Discord optional and adds a web chat.
A Discord project from 0.7 upgrades without changing its configuration.
A new project can leave Discord out and talk through pi-roundtable-webchat, or through a chat surface of its own.
The [changelog](../CHANGELOG.md) lists every change; this guide covers what to do about them.

## Upgrading a Discord project from 0.7

1. Upgrade pi-roundtable and every official package you use to 0.8 together.
   The packages release in lockstep, and each one's peer range on pi-roundtable is the same minor.

   ```sh
   bun add pi-roundtable@0.8 pi-roundtable-mcp@0.8   # and any other pi-roundtable-* package you use
   ```

2. Make sure a plugin loads pi-self-compact.
   Every session needs its `compact_session` tool, and a project that loads no package that registers it stops at startup with `required tools are not registered: compact_session`.
   A running 0.7 project already loads it, since 0.7 had the same requirement; a project `roundtable init` created before 0.8 did not, and could not start.
   The fix is the plugin `roundtable init` now writes, `plugins/self-compact.ts`:

   ```sh
   bun add pi-self-compact@0.2.0
   ```

   ```ts
   import { definePlugin } from "pi-roundtable";

   export const selfCompact = definePlugin({
   	name: "self-compact",
   	setup: () => ({ piPackages: ["pi-self-compact"] }),
   });
   ```

3. Start the host.
   Its migrations only add:
   - the table `conversations` (ledger id `conversations/conversations`), the conversation registry;
   - `runtime/held-actions`, the held actions' migration recorded under its new plugin; the table exists already, so nothing changes;
   - `runtime/held-actions-speaker`, a nullable column `speaker_id` on `held_actions`.

Nothing else is required.
`bunx roundtable doctor` runs the same checks as before.

### What behaves differently

- **Approvals.**
  A held call is approved only by the speaker whose turn held it, at a tier that still holds the call, or by the owner.
  That holds for the approval card and for a confirming message in an agent's channel or a group room.
  In 0.7 any speaker whose tier held the tools could approve another person's call by message.
  Calls held before the upgrade carry no speaker, so they are the owner's to approve.
  A tool whose calls someone above the speaker should approve needs a higher `minTier`, or a hold rule's `approvalTier`.
- **Plugin order.**
  Two built-in plugins join the list, just before `agent-server`: `conversations`, which provides `CONVERSATIONS`, and `runtime`, which builds the runtime every turn runs on and provides `RUNTIME`.
  A plugin that matches built-in plugins by name, or reads `serviceStarted` events, sees the two new names; the order of everything else is unchanged.

### What changes for plugin code

- **`RUNTIME`.**
  `context.turns` now runs on `services.get(RUNTIME)`, not on the agent server, so it works on a host without one.
  `AGENTS.runtime` is the same instance, and a plugin that fills the `runtime` provider slot keeps replacing it.
  Read `RUNTIME` in new code.
- **Optional configuration.**
  `RoundtableConfig.discord`, `RoundtableConfig.http`, and `http.publicUrl` are optional in the type, and `RuntimeDeps.agents` is optional and read when a turn runs.
  Code that reads them from a configuration or from `RuntimeDeps` checks for them first.
- **Held actions.**
  `PendingConfirmation.speakerId` records who held the calls.
  A runtime with its own `HeldActionStore` keeps `speakerId` across a restart; without it, a restored call is the owner's to approve.
- **HTTP.**
  `HttpRoute.websocket` (a `WebSocketRoute`) takes WebSocket upgrades on a route's path.
  `pi-roundtable/kit`'s `serveUnix` passes the server to `fetch` as a second argument, and takes an optional `websocket` handler; with one, `fetch` may answer nothing after it upgrades the request.
- **Testing.**
  `testHost({ discord: false })` boots a host without Discord, and `describeSurfaceContract` checks a chat surface of your own.

### Optional: Discord as an adapter

The top-level `discord` stays the form `roundtable init` writes.
The same settings may come as an adapter instead, which is the form later releases build on:

```ts
import { discord } from "pi-roundtable/discord";

export default {
	// ...
	adapters: [
		discord({
			token: env("DISCORD_TOKEN"),
			guild: env("DISCORD_GUILD_ID"),
			entryChannel: env("DISCORD_ENTRY_CHANNEL_ID"),
		}),
	],
} satisfies RoundtableConfig;
```

Configure Discord in one place: both is a configuration error.

## Starting a host without Discord

### A web chat project

```sh
npx pi-roundtable init my-desk --adapter web
cd my-desk
bun install
docker compose up -d
cp .env.example .env    # then fill it in
bunx roundtable doctor
bunx roundtable start
```

The project lists `webChat({ ... })` from pi-roundtable-webchat in `plugins`, with an OpenID Connect verifier, an access map from the token's roles, and one persona whose `selection` names its tools.
It listens on `127.0.0.1:3000`; serve it over HTTPS through a reverse proxy, and set `CHAT_ORIGINS` to the pages that open the chat.
Before anyone signs in, read the web chat README's [provider settings](../packages/webchat/README.md#provider-settings): name people by a claim that stays the same across your app registrations, pin your tenant, and accept access tokens only.

### Leaving Discord out of an existing configuration

Remove `discord` and the host runs without it: no Discord plugin, no agent server, no agents, and no skills.
Every claim that runs turns through `context.turns` still works, over the chat surfaces your plugins bring.

- `agents`, `skills` (anything but `false`), and `ops.agent` are configuration errors; report errors to a conversation with `ops: { conversation: "<surface>:<id>" }`.
- `http` is optional; without it no listener opens.
- `notify_owner` is not registered.
- `schedule_*` and `delegate_task` work only in a conversation a chat surface carries; the web chat takes no background turns yet, so leave them out of a web persona's `selection`.
- `roundtable doctor` skips the Discord checks.

See [a host without Discord](plugins.md#a-host-without-discord) and [the web chat](plugins.md#web-chat-pi-roundtable-webchat) in the plugin guide, and the README's [threat model](../README.md#threat-model) before you let several people in.

## Rolling back to 0.7

Every 0.8 migration adds a table or a nullable column, so 0.7.19 starts on a database 0.8 has used.
It ignores the `conversations` table and the `speaker_id` column, and approvals follow 0.7's rules again.
