---
type: Fixed
packages: [core, sandbox]
---
Sandbox's `channelContext` option now accepts `starter` and `authors`, which its type already allowed but its startup check rejected.

Channel context no longer looks up a thread's starter on every turn: it skips the lookup once the starter was handed over and reuses the fetched window's copy when it holds it.
