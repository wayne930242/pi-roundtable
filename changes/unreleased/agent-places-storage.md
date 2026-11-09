---
type: Added
packages: [core]
---
The agent server keeps a new table, `agent_places`, with one row per agent or group per surface that holds its place (`team_id`, `kind`, `name`, `surface`, `external_id`). Two migrations come with it: `agent-server/agent-places` creates the table once, and `agent-server/agent-places-from-channels` runs at every boot and makes the Discord rows equal the `agents.channel_id` and `agent_groups.channel_id` columns, so a rollback to an older build, which writes only the columns, converges at the next boot. The store writes the row and the column in one transaction; nothing reads the table yet, and keys, tools and text are unchanged.

`moveTeam` also moves the rows of tables scoped by `team_id`, and takes `places: [{ surface, keep }]` to drop the moved place rows of a surface whose space was not the team's.
