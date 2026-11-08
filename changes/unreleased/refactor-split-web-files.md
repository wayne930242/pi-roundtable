---
type: none
---
Test and source layout only: the web console's API types live in eight modules behind the same `api-types.ts` barrel, `app-socket.test.ts` is split by theme with its shared test host reset after each test, and two flaky tests wait for their event instead of sleeping. No behavior changes.
