---
type: Changed
packages: [core]
---
Discord's two agent tools, `channel_arrange` and `channel_read`, and the `category` argument of `agent_create` and `group_create` are now contributed by the Discord plugin when the host has `discord.guild`; the team code no longer names them. Their names, text, tiers (`channel_read` member, `channel_arrange` admin) and the withholding from temp knights are unchanged, and an agent's turn is the only one that carries them, as before.

`defineTool` takes `withheldFromHelpers`, which keeps a plugin's tool out of temp knights' turns, and the creation tools take the arguments a place provider adds with `createArguments`, passed on as `hints`. `AgentOps.create` and `createGroup` take `hints` in place of `category`, and `AgentOps` no longer has `arrange` and `read`; `NewAgent.category` and the group's `category` still work and are deprecated in favor of `hints.category`, removed in 1.0.

`AgentChannels`, `AgentPost`, `CategoryLayout`, `ChannelMessage` and `DashboardBoard` are exported from `pi-roundtable/discord`; their export from `pi-roundtable/kit` is deprecated and goes in 1.0.
