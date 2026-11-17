---
type: Added
packages: [core]
---
New config keys `abortGraceSeconds` (default 10, 1 to 600) and `refuseWaitingSeconds` (default 15, 1 to 600), and `drain.refuseWaitingMs` in `RoundtableOptions`: how long a shutdown gives the turns it stops at the drain limit to end, and the messages still waiting behind a turn to be refused. The service manager's kill timeout must be longer than `drainSeconds` + `abortGraceSeconds` + `refuseWaitingSeconds` plus a few seconds of teardown; under a 30-second kill, for example, 12 + 5 + 8 leaves five.
