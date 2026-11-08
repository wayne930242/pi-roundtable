---
type: Fixed
packages: [web]
---
A device that was refused an answer as `answered` no longer keeps its own lock on the block: the server's record decides, so when the first device's send fails and the row comes back without the answer, the page opens the block again too (0.42.0 said so, but only the server half was in).
