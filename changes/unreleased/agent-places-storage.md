---
type: Added
packages: [core]
---
The agent server keeps a new table, `agent_places`, with one row per agent or group per surface that holds its place (`team_id`, `kind`, `name`, `surface`, `external_id`). Two migrations come with it: `agent-server/agent-places` creates the table once, and `agent-server/agent-places-from-channels` runs at every boot and makes the Discord rows equal the `agents.channel_id` and `agent_groups.channel_id` columns, so a rollback to an older build, which writes only the columns, converges at the next boot. The store writes the row and the column in one transaction; nothing reads the table yet, and keys, tools and text are unchanged.

A team that was stored under a former id (`formerIds`) has its place rows moved with the rest of its rows, and a team that left its Discord guild loses the rows of the Discord places it left, as it loses their channel ids. A row that stays under the former id, because the team holds its key or its place id already, is named in a warning at boot. Each boot converges the place rows of its own team only, so hosts of several teams over one database leave each other's rows alone.
