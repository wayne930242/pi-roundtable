---
type: Added
packages: [core, web]
---
The agent team reads where its agents and groups are through the place providers: an agent's keys, who owns a key, the routing table, a group's seats and log names, a message the outbox replays, and the agent server's claim of a space. A provider that keeps its places in `agent_places` (a chat network the core has never heard of) now gets its places as keys, owners, routes and reply targets with no change to the core. Every key a Discord team has stays what it was, so sessions, schedules and held actions carry over. A row of a surface no provider serves on the host is ignored, which replaces the old "no Discord channels" switch.

`AgentTeam.placesOf(name)`, `AgentTeam.teamId`, `AgentDirectory.placeOwner(key)` and the `places` of the `TeamStatus` views (`TeamPlace`) are new, all optional on their interfaces. `roomsOf` lists every place, the stored ones first.

`Agent.channelId`, `AgentGroup.channelId`, `AgentSeed.channelId`, `AgentDirectory.agentByChannel` and `groupByChannel`, `AgentTeam.guildId` and `discordGuild`, and the `channelId` of the `TeamStatus` views are deprecated and removed in 1.0; read `placesOf` and `placeOwner`. The team still keeps them up to date.

The web console reads the team's `places` for its channel links and its `teamId` for the team's name.

The stand-in Discord of `testHost` contributes Discord's place provider when the test host has an agent guild, as the built-in plugin does. A plugin that replaces `DISCORD` with a Discord of its own, in a host with an agent guild, must contribute that provider too: `discordPlaceProvider` from `pi-roundtable/discord`, given the `guild`, the `connection` and a `logger` (`DiscordPlaceProviderOptions`), is the built-in one, with the keys, group seats and log names Discord's teams have always had, so contribute it with `places`. A host with an agent guild and a Discord that has no such provider now refuses to start, naming it, instead of leaving the agents unanswered.

A key of a surface no provider serves is no room: a message kept for one is dropped on the next start without a model turn, as before, and a group seat whose home is such a key posts there.
