---
type: Fixed
packages: [core, coding]
---
A deploy no longer cuts a coding worker short without a word. The shutdown drain (`drainSeconds`, now up to 14,400) waits for the desk's running workers and for reports still being delivered. A service can now tell the drain began (`Service.beginDrain()`): the coding desk then starts no queued task, reports each as "not started: host restarting, dispatch again after restart", and refuses `repo_task` with the same message. At the limit the drain calls the new `Service.abort()` before `stop()`, and the desk stops each worker with SIGTERM (the worker saves its tracked changes in a `wip:` commit, `stopGraceMs` of 5 seconds before SIGKILL), keeps its branch and worktree unmerged, and reports where they are.

A coding worker that is cancelled or runs out of time is killed at once and its branch is never merged into the clone, even when its worktree is clean; the report names the kept branch and worktree. Only a host shutdown saves a `wip:` commit. `CodingDesk.stop()` stops workers the same way and waits at most `stopWaitMs` (15 seconds) for reports.

New `QueuePort.finishing(task)` (absent on an older host): a queue task started inside it, and what it awaits, is admitted although the host is shutting down, until the drain ends. The coding plugin delivers every report through it, so the report of a worker that ends during the drain is no longer refused with "the host is shutting down". After the abort grace the host tells the turns still running in the queue to stop once more, so a report turn begun during the grace cannot run past the drain.

A coding worker that gets SIGTERM from outside the desk (a `systemctl kill`, a cgroup-wide stop, a manual `kill`) still saves its `wip:` commit but now reports a `stopped` failure; the desk refuses to merge that run, keeps its branch and worktree, and says so in the report. A run that already timed out is reported as timed out even when `interrupt()` or `stop()` lands afterwards.
