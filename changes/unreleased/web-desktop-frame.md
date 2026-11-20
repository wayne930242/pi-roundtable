---
type: Fixed
packages: [web]
---
On a wide screen a room's header and the chat column beside it no longer scroll out of view: a block's screen-reader text (forms, tables, checklists) was placed against the room instead of its message list and stretched the room past the screen, so bringing a message into view moved the whole frame. The message list now holds what a message positions, and a page that fills the screen clips instead of hiding its overflow.

In the chat column beside a room, the top row (the person's picture and "+") stays at the top while the list scrolls, and the bottom bar (all features and search) stays at the bottom even when the list is short.
