---
type: Added
packages: [core, sandbox]
---
`ChannelContextOptions.conversation(message)` (and the host default `discord.channelContext.conversation`, code only) names the conversation a turn runs in, such as the principal of a person's private conversation in a forum post. What channel context remembers as handed over then belongs to that conversation: a turn of another conversation than the channel's last reads the window as if nothing had been handed over, the thread's starter too, so a second person who asks in a post gets the card, the comments and the earlier discussion that the first asker's turn already read. One record is still kept per channel, so it takes no more memory. Without the option nothing changes. The sandbox's `channelContext` accepts it.
