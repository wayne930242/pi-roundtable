---
type: Added
packages: [core, web]
---
`team.id` gives the team the id its rows are stored under, independent of `discord.guild` (default the guild's id, else `local`), and `team.formerIds` lists the ids it was stored under before: their rows move to the team's id at every boot, and a team without Discord channels loses the channel ids they carried. `AgentTeam.discordGuild` names the guild the team's channels live in, which the web console links by.
