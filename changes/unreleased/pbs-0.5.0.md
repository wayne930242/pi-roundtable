---
type: Changed
packages: [core, web]
---
`pi-better-show` is pinned to 0.5.0. An interactive block (`options`, `suggest`, `form`, `checklist`, `review`) now has an "Other comments" box: the web app sends its text as the reserved field `pi-note`, keeps it in the block's recorded answer, and the owner's message to the agent ends with `Other comments: …`.

On Discord and LINE, a block read as text now says other comments are welcome (for example "Reply with a number. Other comments are welcome.").
