---
type: none
---
Test-only change: the coding package's two-worker tests get a 30-second budget for their git work, and their parked workers end when the desk stops them, so a stalled CI runner no longer fails the conflict test and then its afterEach hook as well.
