---
type: Fixed
packages: [core]
---
`discord.catchUp`: a message addressed to the bot while the old process shuts down is no longer refused with "please send this again". The process records nothing, posts once per channel a notice that it will answer after the restart, and the next process answers the message. The notice is recorded in the journal, so catch-up does not take it for an answer. A message recorded just as the shutdown begins is released again for the next process.

`discord.catchUp`: when the member fetch for a caught-up message fails for any reason other than the author having left (Discord code 10007), catch-up skips the message without recording it, so a later restart can retry it. Before this fix, the message was answered without the author's roles and was never retried.

`discord.catchUp`: a message the live connection delivered without a record, because the database was down at startup, is not caught up a second time by the same process.

`discord.catchUp`: the inbound journal is pruned to 30 days every six hours while the host runs, not only at restart. The docs now say what happens when `catchUp` is turned off later.

`discord.catchUp`: a mention that has a thread started from it, or a reaction from the bot, counts as answered. Before this fix, the first restart after catch-up was enabled re-delivered mentions answered in a thread, and the bot then posted a false "could not open a thread" notice.

`discord.catchUp`: caught-up messages reach routing before the newer live messages in the same channel. A live message waits until catch-up has listed the channels it reads. In one of those channels, it also waits until catch-up is done.
