---
type: Added
packages: [coding, drawing]
---
`pi-roundtable-coding` exports `DEFAULT_TOOL_TEXT`, the shipped description and argument text of every repository tool, so a host sets `toolText` for only the wording that differs and sees what an upgrade changed. The `presentation` hooks `list`, `changeReport`, `taskStarted` and `taskQueued` now receive the package's own text as a last argument, so a host can append to it instead of replacing it.

`pi-roundtable-drawing` takes a `toolText` option, the same for its five tools, and exports `DEFAULT_DRAWING_TOOL_TEXT`; unset text keeps the package wording, and a tool or argument the plugin does not have stops the start.
