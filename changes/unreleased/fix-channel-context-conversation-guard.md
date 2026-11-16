---
type: Fixed
packages: [core, sandbox]
---
`ChannelContextOptions.conversation` that throws, or returns something other than a string or `undefined`, is now logged and counts as `undefined` instead of rejecting the read; the docs say to set it as the host default or on every read of a channel, since an unnamed read is a conversation of its own.

The sandbox's `channelContext` refuses `conversation` (a clear error) and ignores a host default of it: its history is one file per channel that never starts fresh for another asker, so the option would only hand the window over again.
