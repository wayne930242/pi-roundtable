---
type: Fixed
packages: [coding]
---
`DEFAULT_TOOL_TEXT` is frozen at every depth, so writing into it throws instead of changing the wording of every later `coding()` in the process; a spread of it, as the README shows, still composes.
