---
type: Fixed
packages: [core]
---
`discord.catchUp`: during the shutdown, a message addressed to the bot is promised an answer after the restart, and recorded as left, only when routing refuses it because the host stops, that is when a claim would have answered it. A message in a channel the bot does not serve, or one no claim admits, no longer gets a false "will answer this once back" notice.

`discord.catchUp`: a message that arrived during the shutdown and could not be recorded as left no longer gets the "send it again" notice, which together with catch-up answering it from the window could answer it twice; it gets no notice and the next process's catch-up answers it.
