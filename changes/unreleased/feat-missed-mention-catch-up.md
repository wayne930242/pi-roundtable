---
type: Added
packages: [core]
---
`discord.catchUp: { windowMinutes?, maxMessages? }` (off by default) answers, once the connection is ready after a restart, the messages addressed to the bot that came while no process was listening, which Discord does not deliver again: a person's mention, reply to the bot, or direct message from the last `windowMinutes` (default 10) that the bot did not answer, the newest `maxMessages` (default 20), oldest first, through the usual claims and gates. Each addressed message is recorded in the new `discord_inbound_journal` table before routing hears it, so neither a second restart nor the live gateway answers it again.

`InboundMessage.caughtUp` is set on a message delivered that way, so a claim may say its answer comes late.
