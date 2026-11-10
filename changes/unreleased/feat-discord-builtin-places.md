---
type: Changed
packages: [core]
---
Discord's two agent tools, `channel_arrange` and `channel_read`, and the `category` argument of `agent_create` and `group_create` are now contributed by the Discord plugin when the host has `discord.guild`; the team code no longer names them. Their names, text, tiers (`channel_read` member, `channel_arrange` admin) and the withholding from temp knights are unchanged, and an agent's turn is the only one that carries them, as before.

`defineTool` takes `withheldFromHelpers`, which keeps a plugin's tool out of temp knights' turns, and the creation tools take the arguments a place provider adds with `createArguments`, passed on as `hints`. `AgentOps.create` and `createGroup` take `hints`; their `category`, `NewAgent.category` and the group's `category` still work, are passed on as `hints.category`, and are deprecated in favor of it, removed in 1.0.

`AgentOps.arrange` and `AgentOps.read` are deprecated and removed in 1.0: the Discord plugin's `channel_arrange` and `channel_read` took their place. Until then the agent server's team still answers them, with what the two tools do on a host with `discord.guild`, and with the refusal 0.45 gave on a host whose team has no Discord channels.

`AgentChannels`, `AgentPost`, `CategoryLayout`, `ChannelMessage` and `DashboardBoard` are Discord's agent guild internals; their export from `pi-roundtable/kit` is deprecated and moves to `pi-roundtable/discord` in 1.0.

The `#dashboard` message in the agent guild is now kept by the Discord plugin instead of the agent server: it starts when the agent server's `team` service is ready and refreshes when the team changes, with the same text. The `dashboard` contribution lines are unchanged, and `agent_list` still ends with the categories section, now written by Discord's place provider.

A plugin that replaces `DISCORD` on a host with `discord.guild` now contributes Discord's side of the agent guild itself, since the built-in Discord plugin is left out whole: spread `discordAgentGuild(context, { guild, connection, entryChannel })` from `pi-roundtable/discord` (`DiscordAgentGuildOptions`, `DiscordAgentGuild`) into what its setup returns. It holds the place provider, `channel_arrange` and `channel_read`, and the `#dashboard` message, names the coordinator's place from `entryChannel`, and writes the names in `agent_list`'s categories section; the built-in plugin contributes the same. A replacement that contributes only `discordPlaceProvider` has no channel tools and no dashboard, its coordinator is the first seeded agent, and its `agent_list` shows channel mentions. The startup refusal for a guild whose places no plugin serves names the guild's id and `discordAgentGuild`.

The agent server's plugin imports nothing of Discord. The Discord plugin takes `entryChannel` (with `agentGuild`) and gives it through its place provider as the coordinator's place, and the agent server takes `placeSpaces`, the spaces its stored places live in, in place of `guildId`. `AgentServerOptions.guildId` and `entryChannelId` still work and are deprecated, removed in 1.0; the configuration keys and their messages are unchanged. The agents' channel context is read through `CHANNEL_CONTEXT`, from the surface that holds the message's channel.
