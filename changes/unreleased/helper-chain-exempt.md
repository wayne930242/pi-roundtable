---
type: Changed
packages: [core]
---
Messages between an agent and its own temp knights no longer count toward the cap of 8 agent messages without the owner in between: the parent's `message_agent` to its temp knight, and the temp knight's to its parent, count on their own, toward a cap of 40 (`MAX_HELPER_MESSAGES`) that only stops the two writing to each other forever. The cap of 8 still holds for messages between independent agents, in the same run.
