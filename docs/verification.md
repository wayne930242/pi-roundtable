# Verification

## Offline anchor

| Requirement | Evidence | Result |
| --- | --- | --- |
| Clone and list managed repositories | `src/coding.test.ts`: clones and lists shelf state, including branch/upstream/summary and duplicate refusal | pass |
| Generate a change report | Temporary bare origin: clean ahead-only report contains commits, full SHA, default branch and diffstat; dirty, empty and behind clones refuse | pass |
| Hold a push until approval, then execute | `testPlugin` exposes the linked push hold; the test keeps origin unchanged while awaiting a simulated owner answer, then executes the tool and verifies the remote SHA | pass |
| Owner-repository option | Exact-match exceptions pass; same-prefix and other-owner repositories remain held | pass |
| Worker timeout excludes owner waiting | Fake worker spends twice its budget awaiting a card, stays un-aborted, then times out after work resumes and reports Git state | pass |
| Reject bad repository names | Invalid names and traversal refuse through shelf and plugin tools | pass |
| Fail closed on unapproved worker calls | Missing, declined and failed cards are held/refused; real child Pi session does not write a refused file | pass |
| Out-of-process worker | Real Pi session uses an offline faux provider; its reported PID differs from the test process and is absent after completion | pass |
| Timeout/stop cleanup | Real worker aborted during approval exits; normal completion removes a same-group shell descendant | pass |
| Path containment | Escaping clone and owner-directory symlinks refuse | pass |
| Safe metadata discovery | README directories, symlinks and FIFOs are skipped; workflow file/directory links are skipped; reads stop at 64 KiB | pass |
| Destination and branch approval binding | Changed push URL or remote default branch refuses; credential-bearing HTTP URL refuses before fetch | pass |
| Host Git hardening | Configured fsmonitor and pre-push hook do not execute during list, report or push | pass |
| Timer and report bounds | Overflow, non-finite and non-positive timeouts refuse; fake worker Held inputs and answer are explicitly truncated | pass |
| Owner skill-list contract | Plugin configuration errors have PluginError type; owner-only skill-list factory excludes agent and study sessions | pass |
| Credential-safe failure diagnostics | Real child missing-model failure reports exit category/code and leaves no child PID | pass |
| Worker standing instructions | A real child includes regular repo AGENTS.md, excluding parent and symlinked instructions | pass |
| Package boundaries | Actual 13-file tarball excludes tests/faux provider/local state; an installed consumer registers all five tools and runs a real child approval hold with PID cleanup | pass |

The push test exercises the public host-linked hold rule and an explicit simulated approval boundary, not a live chat runtime.
The subprocess tests exercise real Pi tool execution and host approval replies without a model network or Git host network.
No live Git-host login, chat-surface interaction, deployment, remote creation, push of this package, tag or npm publication is claimed.

## Commands

- `bun test`: 19 passing tests, zero failures (115 assertions after review fixes).
- `bun run typecheck`: pass.
- `bun run lint`: pass.
- Public scanner invoked from the pi-roundtable checkout: `0 finding(s)`.
- `npm pack`: 13 public files; the child worker entry and all production modules are present.
- Installed-tarball smoke: `Installed tarball: five tools, real child approval hold and PID cleanup passed.`
- Smoke consumer and tarball were removed after verification; no worker process or server was left running.

## Fresh-context review dispositions

A read-only reviewer using `claude-bridge/claude-200k-opus-5-5` reviewed the entire initial package in a standalone context and independently ran the 11-test checkpoint, typecheck, lint and public scan.
It found one blocker, three hardening recommendations and five nits.
The following are author-applied fixes with post-review local verification, not a claim that the reviewer re-reviewed them.

| ID | Disposition | Verification |
| --- | --- | --- |
| B1 | Fixed: bounded regular-file metadata reads with no-follow opens and symlink-free workflow directories | Metadata regression test covers file links, directory links, directories, FIFO and read limit |
| S1 | Fixed: report binds exactly one credential-free push target; the card shows it and push checks it again | Destination mutation refuses and report/card contain branch and target |
| S2 | Hardened: host Git disables hooks and fsmonitor; local credential helpers and other executable configuration remain an explicit trusted-host boundary | Hook/fsmonitor marker never appears; README states remaining configuration risk |
| S3 | Fixed: reject timeout values above the host timer maximum | Overflow and other invalid values tested |
| N1 | Fixed: setup configuration errors use PluginError, not ToolRefusal | Public contract test checks the error class |
| N2 | Fixed: only kind owner receives the extra skill list | Owner, agent and study factories tested |
| N3 | Fixed: approval card names the reported branch and destination | Push description test checks both |
| N4 | Fixed: bound worker answers and Held entries, with explicit omission counts | Fake worker oversized output/input test |
| N5 | Fixed: credential-free structured worker exit diagnostics instead of raw stderr | Real child failure category and exit code test |

A further local correctness pass reserves repositories across plugin report/push operations and excludes symlinked context files from worker standing instructions.
The public source scanner reports zero findings after these changes.
Reflexive pass: initial validator and session-factory assumptions were gaps resolved by the source changes; no external agent-system rule changes were needed.
