---
type: Fixed
packages: [core, coding]
---
A deploy no longer cuts a coding worker short without a word. The shutdown drain (`drainSeconds`, now up to 14,400) waits for the desk's running and queued tasks and for reports still being delivered; at the limit it calls the new `Service.abort()` before `stop()`, and the coding desk then stops each worker with SIGTERM (the worker saves its tracked changes in a `wip:` commit, `stopGraceMs` of 5 seconds before SIGKILL), keeps its branch and worktree unmerged, and reports where they are.

New `QueuePort.finishing(task)`: a queue task started inside it, and what it awaits, is admitted although the host is shutting down, until the drain ends. The coding plugin delivers every report through it, so the report of a worker that ends during the drain is no longer refused with "the host is shutting down".
