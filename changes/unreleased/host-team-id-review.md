---
type: Fixed
packages: [core]
---
A team that moves between Discord guilds clears the channel ids of the rows from any former id that is not its current guild, so start creates fresh channels instead of archiving the team. Two former ids that hold the same key no longer fail every boot: the one listed first moves, and a warning names the rows that stay behind. A team without Discord channels also clears the channel ids its own rows hold. `testPlugin` gives the agent claim the team's Discord guild again.
