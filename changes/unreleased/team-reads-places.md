---
type: Added
packages: [core, web]
---
The agent team reads where its agents and groups are through the place providers: an agent's keys, who owns a key, the routing table, a group's seats and log names, a message the outbox replays, and the agent server's claim of a space. A provider that keeps its places in `agent_places` (a chat network the core has never heard of) now gets its places as keys, owners, routes and reply targets with no change to the core. Every key a Discord team has stays what it was, so sessions, schedules and held actions carry over. A row of a surface no provider serves on the host is ignored, which replaces the old "no Discord channels" switch.

`AgentTeam.placesOf(name)`, `AgentTeam.teamId`, `AgentDirectory.placeOwner(key)` and the `places` of the `TeamStatus` views (`TeamPlace`) are new, all optional on their interfaces. `roomsOf` lists every place, the stored ones first.

`Agent.channelId`, `AgentGroup.channelId`, `AgentSeed.channelId`, `AgentDirectory.agentByChannel` and `groupByChannel`, `AgentTeam.guildId` and `discordGuild`, and the `channelId` of the `TeamStatus` views are deprecated and removed in 1.0; read `placesOf` and `placeOwner`. The team still keeps them up to date.

The web console reads the team's `places` for its channel links.
