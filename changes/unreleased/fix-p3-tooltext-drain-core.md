---
type: Fixed
packages: [core]
---
During the shutdown drain, the report turn of work that finished (delivered through `context.queue.finishing`) still runs, but it can no longer start team or delegated turns or transient tasks: a queue task that its own task starts is refused, and a transient task is refused while the new `QueuePort.draining` reads true, which `finishing` does not mask.
