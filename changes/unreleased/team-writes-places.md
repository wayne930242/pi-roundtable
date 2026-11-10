---
type: Changed
packages: [core]
---
The agent team makes, brings back, keeps and posts in the places of its agents and groups through the place providers. At start it asks each stored provider to make a place for every active agent that has none (a temp knight lives in its rooms until reached), and checks the places it has stored: one the provider finds gone archives its owner, as a deletion does. A group's topic follows its members through the provider. Creating, archiving, restoring and deleting an agent or group, a temp knight's thread, a reply and the interim posts of a turn all go through the provider of the place, so a chat network the core has never heard of gets its agents' places made, answered in, closed, brought back and archived on deletion with no change to the core. The agent server no longer listens for deleted Discord channels itself: the team registers with each provider's `onRemoved`.

A team whose id stays while its agent guild changes no longer archives every agent at start. Its stored channels are another server's, which Discord's provider calls `foreign`: the rows are dropped and the places are made again in the agent guild.

`PlaceProvider.remove` now resolves to the rest of the archive tool's answer after `Archived "<name>"`, starting with its own separator (`; its channel <#id> is kept under Archive.`), so a place that could not be kept can say so in the tool's own words. The answers the tools give are unchanged. The agent store gains `setPlace` and `clearPlace` for the place an agent or group has on any surface, written beside the legacy `channelId` column of the Discord surface. The team classes are no longer Discord-named internally; `discordKey` moved to `src/core/contract/discord-key.ts` and `pi-roundtable/kit` still exports it.
