---
type: Added
packages: [core]
---
`InboundMessage.reference.channel` is the channel key of the message a reply quotes, which the Discord surface now sets on live and caught-up messages alike. A claim compares it with the message's own `channel` to tell a reply within the conversation, such as one to a forum post's starter, from a reply to a message of another channel, before it acts on `reference.attachments`.
