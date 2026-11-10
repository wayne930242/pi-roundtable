---
type: Fixed
packages: [core]
---
A place provider's `createArguments` for `agent_create` or `group_create` may no longer reuse an argument the tool takes itself (`name`, `task`, `group`, ...) or one another provider adds: the boot stops with a `PluginError` naming both plugins, where the later one used to replace the earlier's schema silently. Only a string the model gives reaches `ensure` as `hints`, so give a string schema.

A team whose stored places of a surface other than Discord belong to another space (`placeSpaces`) drops the places moved in from a former team id of another space, as Discord's channels were already, instead of keeping them.

Restoring an archived agent or group whose stored place the provider finds `foreign` (a Discord channel of a server the team left, while the bot is still in it) makes a new place in the agent guild instead of moving the old channel inside the other server.

`discordAgentGuild` takes `own: { services, events }`, the services and event handlers the replacing plugin makes itself, and returns them merged with the dashboard's: spreading the result used to replace them. A handler of an event both hear (`serviceStarted`) runs after the dashboard's, and still runs when that one throws.

Discord's tools and dashboard find an agent's or group's channel and the owner of a channel through the places (`placeOwner`, `placesOf` and the status views' `places`), (an archived owner's channel that stays in an `Agents` or `Groups` category is named by its owner now, not shown as `<#id>`), not through the deprecated `agentByChannel`, `groupByChannel` and `channelId`, which they read only for an agent server written before places were providers. The agent server's refusal for `discord.entryChannel` without `discord.guild` has one text in the configuration check and in the Discord plugin.

`AgentChannels`, `AgentPost`, `AgentCategory`, `CategoryLayout`, `ChannelMessage` and `DashboardBoard` carry `@deprecated` in their declarations, saying that `pi-roundtable/kit` stops exporting them in 1.0 and `pi-roundtable/discord` exports them then.
