---
type: Added
packages: [core]
---
Channel context lists each message's files after its text, one `<attachment id="…" message="…" name="…" title="…" description="…" type="…" size="…"/>` line per file, which the message's character limit no longer cuts; at most `CONTEXT_ATTACHMENT_LINES` (10) per message, then `<more-attachments count="N"/>`. A file's link is no longer in the block (it expired anyway), a message with only files is kept, and two posts with different files are no longer merged as near repeats. `ChannelContextAttachment` and `ChannelContextSourceAttachment` gain `id`, `title` and `description`.

`InboundMessage.attachments` (`AttachmentRef`) carry the file's `id`, the `messageId` of the message that carries it, and its `title` and `description` when the uploader gave them, for the addressed message, the one it replies to, and a forward.

`DISCORD.readAttachment({ channelId, messageId, attachmentId, maxBytes? })` reads one file's bytes: it fetches the message again in the channel the caller names and downloads from the fresh address Discord gives, never from a URL a caller or a model supplies, and resolves with `AttachmentBytes` (`id`, `name`, `contentType`, `size`, `bytes`, `title?`, `description?`) or rejects with an `AttachmentReadError` whose `code` is `not-found`, `too-large`, `gone` or `unavailable`. The cap is the host's new `discord.attachmentRead.maxBytes` (default `ATTACHMENT_READ_MAX_BYTES`, 10 MiB; at most 100 MiB), which a call may lower. `AttachmentReadRequest` and `AttachmentReadErrorCode` are its types, from `pi-roundtable/discord`.

`fakeDiscord({ attachments, attachmentMaxBytes })` serves files (`FakeDiscordAttachment`) through `DISCORD.readAttachment` with the real checks and errors.
