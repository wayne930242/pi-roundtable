---
type: Fixed
packages: [core]
---
`discord.catchUp`: a message addressed to the bot that the old process does not run as it shuts down, whether it arrives during the shutdown or waits behind a running turn, is no longer refused with "please send this again". It is recorded as left in the journal (new migration `discord-inbound-journal-left`), and the channel is told once that the message will be answered after the restart. The next process answers it whatever was posted in the channel since. Restart notices are recorded, so catch-up does not take one for an answer. A process that loses a claim to another tries once more two seconds later. A chat surface takes such a message through the new optional `ChatSurface.refuseStopping`.

`discord.catchUp`: when the member fetch for a caught-up message fails for any reason other than the author having left (Discord code 10007), catch-up skips the message without recording it, so a later restart can retry it. Before this fix, the message was answered without the author's roles and was never retried.

`discord.catchUp`: a message the live connection delivered without a record, because the database was down at startup, is not caught up a second time by the same process.

`discord.catchUp`: the inbound journal is pruned to 30 days every six hours while the host runs, not only at restart. The docs now say what happens when `catchUp` is turned off later.

`discord.catchUp`: a mention that has a thread started from it, or a reaction from the bot, counts as answered. Before this fix, the first restart after catch-up was enabled re-delivered mentions answered in a thread, and the bot then posted a false "could not open a thread" notice.

`discord.catchUp`: caught-up messages reach routing before the newer live messages in the same channel. A live message waits until catch-up has listed the channels it may read (one database query). In one of those channels, it also waits until catch-up is done.
