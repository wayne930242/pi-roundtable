---
type: Fixed
packages: [core, mcp]
---
A questionnaire card's "Write answers / note…" form no longer shows the open draft to whoever presses it: each person's form is prefilled only with the text answers and note they wrote themselves, so someone the card is not for no longer sees the owner's unsent text (a regression in 0.51.0).

`DISCORD.readAttachment` rejects a call's `maxBytes` that is not a positive whole number with an `AttachmentReadError` whose code is the new `invalid`, instead of a `RangeError`; `discordPlugin` throws a `ConfigError` for an `attachmentRead.maxBytes` outside 1 byte to 100 MiB, the bound the config file already had.

The agent panel's buttons open their forms (edit, model) as the interaction's first answer, with nothing awaited before them: the model form uses the host's models from the last time it asked, and the owner check moves to the submit, where someone else now gets the refusal instead of no answer.

pi-roundtable-mcp: `/<root> connector add` shows its form before the owner check, through the new `OwnerCommandHandlers.form`, and a member who submits it gets the refusal. `ownerCommandModule` gains the optional `form` handler, and `ownerRefusal` (the refusal panel for a guard's hint) is exported from `pi-roundtable/discord`.

`readAttachmentText` (`readAttachmentText({ name, contentType?, bytes, offset?, limit? })`) from `pi-roundtable/discord` reads a file's bytes as text the way the core's `read_attachment` tool does: a text file decoded, a PDF's text extracted, in pieces of `ATTACHMENT_TEXT_LIMIT` (60,000) characters with `nextOffset` for the next. It resolves with `AttachmentText` (`kind`, `text`, `offset`, `nextOffset?`, `total`, `pages?`) and rejects with an `AttachmentTextError` whose `code` is `unsupported`, `unreadable` or `invalid` (`AttachmentTextErrorCode`; the request is an `AttachmentTextRequest`). Pair it with `DISCORD.readAttachment` to read a Discord file's text in a plugin's own tool. The `read_attachment` tool now names a binary it refuses with the name escaped, and a PDF it cannot parse as `could not be read as a PDF`.
