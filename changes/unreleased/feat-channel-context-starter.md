---
type: Added
packages: [core]
---
`ChannelContextOptions.starter` (also `discord.channelContext.starter`, default false): in a thread, the context always includes the thread's opening message, a forum post's first message or the message a text channel's thread started from, even when it lies outside the fetched window. It comes first, outside `keep`, follows the same filters (`authors`, empty text, own posts, messages handed over before) and is dropped silently when the thread has none or Discord will not return it.
