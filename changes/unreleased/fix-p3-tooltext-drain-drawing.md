---
type: Fixed
packages: [drawing]
---
`toolText` no longer accepts a name `Object.prototype` has (`toString`, `constructor`) as a tool, a misspelled `draw_cards` argument stops the start even when the host has no decks, and `DEFAULT_DRAWING_TOOL_TEXT` is frozen at every depth, so writing into it throws instead of changing the wording of every later `drawing()` in the process; a spread of it still composes.
