# Changelog

## [Unreleased]

## [0.39.0] - 2026-11-08

### Added

- The owner sets the coding workers' host-wide limit on the web app's Settings page ("Coding workers", owner only), which shows the running and queued counts; a save applies at once. `CodingDesk.setMaxWorkers(n)` (1 to 64) starts queued tasks in order when raised and lets running workers finish when lowered; `CodingDesk.workers()` reads the counts. With `settingsInDatabase: true` the limit is kept in the `coding_settings` table and wins over `maxWorkers` at setup; `CODING_SETTINGS_MIGRATION` lets a host that wraps `coding()` declare its migration. `maxWorkers` now refuses more than 64. The page ships zh-TW wording, and `presentation.messages` rewords it.

## [0.38.1] - 2026-11-08

- Release in lockstep with pi-roundtable 0.38.1 (a quote in one's own app bubble is readable in every look; a list a model sends as JSON text reaches a tool as the list, so `helper_end` by name works); no package-specific behavior changes.

## [0.38.0] - 2026-11-08

- Release in lockstep with pi-roundtable 0.38.0 (display blocks: the web app draws cards, tables, steps, stats, mind maps, Mermaid diagrams, diffs and alerts in a message, and every other surface gets them as text); peer range `>=0.38.0 <0.39.0`, no package-specific behavior changes.

## [0.37.1] - 2026-11-07

- Release in lockstep with pi-roundtable 0.37.1 (an archived temp knight's or a dismissed thread's unread count leaves the tab title and dot without a reload); no package-specific behavior changes.

## [0.37.0] - 2026-11-06

- Release in lockstep with pi-roundtable 0.37.0 (a Presets page with recruits and transfer; the Edit knight sheet as tabs; a searchable skill picker; a lifted row that wiggles and resists its first pixels); peer range `>=0.37.0 <0.38.0`, no package-specific behavior changes.

## [0.36.0] - 2026-11-06

- Release in lockstep with pi-roundtable 0.36.0 (temp-knight presets managed from the knight sheet, shared between knights, and recruited by name); peer range `>=0.36.0 <0.37.0`, no package-specific behavior changes.

## [0.35.0] - 2026-11-06

- Release in lockstep with pi-roundtable 0.35.0 (temp-knight presets; the room drawer shows threads, swipes read and the rooms page swipes modes); peer range `>=0.35.0 <0.36.0`, no package-specific behavior changes.

## [0.34.0] - 2026-11-04

### Changed

- A worker's `bash` follows the core's empty `DEFAULT_SHELL_PASS`: it gets no `GH_TOKEN` unless the host's `shellEnv.pass` names it. The shelf's git and gh calls keep getting `githubToken` as `GH_TOKEN`.

## [0.33.0] - 2026-11-04

### Changed

- The worker process no longer inherits the host's environment: it gets the shell's whitelist (`SHELL_ENV_NAMES`), `PI_CODING_AGENT_DIR`, `TMPDIR`, the variables its model may read, found by the new `modelEnvNames(agentDir)` (each `$VAR` a `models.json` in Pi's agent dir names, and `CLAUDE_*` and `ANTHROPIC_*`), and the names the new option `workerEnv: { pass? }` lists (type `WorkerEnv`). Its `bash` gets only the whitelist and the host's `shellEnv`, never the model's credentials, and its tool results are masked like the host's. **Migration:** a worker on Pi's `auth.json` login, a `models.json` `$VAR` key, or a Claude Code or Anthropic variable needs nothing; a model that reads another variable needs it named, as in `workerEnv: { pass: ["OPENAI_API_KEY"] }`.
- The shelf's git and gh calls (clone, fetch, push, `repo_list` fetch) get the whitelist, git's config, identity and ssh variables, and a GitHub token as `GH_TOKEN` from the new option `githubToken` (a string or a function; type `GithubToken`), by default the host's `GH_TOKEN` read when the plugin sets up, so existing hosts keep working. No other host secret reaches them.

## [0.32.1] - 2026-11-04

- Release in lockstep with pi-roundtable 0.32.1 (optimistic mark-as-read, a Home button at the foot of the room drawer, Discord's -# subtext and line breaks in messages, the shared prompt's description in zh-TW, and the push device list centred); no package-specific behavior changes.

## [0.32.0] - 2026-11-03

- Release in lockstep with pi-roundtable 0.32.0 (plugins hear member joins and manage member roles on Discord); no package-specific behavior changes.

## [0.31.8] - 2026-11-03

- Release in lockstep with pi-roundtable 0.31.8 (the room drawer slides on from where the finger lets it go, without a frame shut); no package-specific behavior changes.

## [0.31.7] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.7 (menu rows hover in the quiet fill with 12 px padding wherever they are used; the message box draws no scrollbar below its tallest; a room row swiped right marks the room read); no package-specific behavior changes.

## [0.31.6] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.6 (channel context reads a peer bot's message up to `peerMessageChars`, default 4000); no package-specific behavior changes.

## [0.31.5] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.5; no package-specific behavior changes.

## [0.31.4] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.4; no package-specific behavior changes.

## [0.31.3] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.3; no package-specific behavior changes.

## [0.31.2] - 2026-11-02

- Release in lockstep with pi-roundtable 0.31.2; no package-specific behavior changes.

## [0.31.1] - 2026-11-01

- Release in lockstep with pi-roundtable 0.31.1; no package-specific behavior changes.

## [0.31.0] - 2026-11-01

- Release in lockstep with pi-roundtable 0.31.0; no package-specific behavior changes.

## [0.30.4] - 2026-11-01

- Release in lockstep with pi-roundtable 0.30.4; no package-specific behavior changes.

## [0.30.3] - 2026-11-01

- Release in lockstep with pi-roundtable 0.30.3; no package-specific behavior changes.

## [0.30.2] - 2026-11-01

- Release in lockstep with pi-roundtable 0.30.2; no package-specific behavior changes.

## [0.30.1] - 2026-11-01

- Release in lockstep with pi-roundtable 0.30.1; no package-specific behavior changes.

## [0.30.0] - 2026-11-01

- Release in lockstep with pi-roundtable 0.30.0; the peer range moves to `>=0.30.0 <0.31.0`. No package-specific behavior changes.

## [0.29.2] - 2026-10-31

- Release in lockstep with pi-roundtable 0.29.2; no package-specific behavior changes.

## [0.29.1] - 2026-10-31

- Release in lockstep with pi-roundtable 0.29.1; no package-specific behavior changes.

## [0.29.0] - 2026-10-31

- Release in lockstep with pi-roundtable 0.29.0; no package-specific behavior changes. The core peer range moves to `>=0.29.0 <0.30.0`.

## [0.28.0] - 2026-10-31

### Added

- Workers run in their own git worktrees, so several can work on one repository at once; a finished branch is rebased and fast-forwarded into the clone, and a conflict keeps the branch and worktree and lists its files in the report.
- With the new `modes` and `autonomy` options, workers follow the yolo and long-running modes of the owner conversation that started them, live, and the report lists what yolo approved.

### Changed

- A host-wide `maxWorkers` cap (default 4) with a FIFO queue (`maxQueued`, default 16) replaces the per-repository and per-channel limits; `start()` answers `queuePosition` for a queued task, queued tasks are dropped with a notice on stop, and `presentation.taskQueued` words the queued reply. The core peer range moves to `>=0.28.0 <0.29.0`.

## [0.27.1] - 2026-10-31

- Release in lockstep with pi-roundtable 0.27.1; no package-specific behavior changes. The core peer range stays `>=0.27.0 <0.28.0`.

## [0.27.0] - 2026-10-31

- Release in lockstep with pi-roundtable 0.27.0; no package-specific behavior changes. The core peer range moves to `>=0.27.0 <0.28.0`.

## [0.26.3] - 2026-10-30

- Release in lockstep with pi-roundtable 0.26.3; no package-specific behavior changes. The core peer range stays `>=0.26.0 <0.27.0`.

## [0.26.2] - 2026-10-30

- Release in lockstep with pi-roundtable 0.26.2. The core peer range stays `>=0.26.0 <0.27.0`.

## [0.26.1] - 2026-10-30

- Release in lockstep with pi-roundtable 0.26.1; no package-specific behavior changes. The core peer range stays `>=0.26.0 <0.27.0`.

## [0.26.0] - 2026-10-30

The core peer range is now `>=0.26.0 <0.27.0`.

## [0.25.0] - 2026-10-29

- Release in lockstep with pi-roundtable 0.25.0; no package-specific behavior changes. The core peer range is now `>=0.25.0 <0.26.0`.

## [0.24.2] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.2; no package-specific behavior changes. The core peer range stays `>=0.24.0 <0.25.0`.

## [0.24.1] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.1; no package-specific behavior changes. The core peer range stays `>=0.24.0 <0.25.0`.

## [0.24.0] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.0; no package-specific behavior changes. The core peer range is now `>=0.24.0 <0.25.0`.

## [0.23.2] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.2; no package-specific behavior changes. The core peer range stays `>=0.23.0 <0.24.0`.

## [0.23.1] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.1; no package-specific behavior changes. The core peer range stays `>=0.23.0 <0.24.0`.

## [0.23.0] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.0; no package-specific behavior changes. The core peer range is now `>=0.23.0 <0.24.0`.

## [0.22.5] - 2026-10-25

- Release in lockstep with pi-roundtable 0.22.5. `engines.bun` is now `>=1.4.4` (was `1.4.2`) so no supported setup runs a Bun with the Brotli decoder bug (CVE-2026-111497). The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.4] - 2026-10-25

- Release in lockstep with pi-roundtable 0.22.4; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.3] - 2026-10-23

- Release in lockstep with pi-roundtable 0.22.3; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.2] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.2; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.1] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.1; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.0] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.0. The core peer range moves to `>=0.22.0 <0.23.0`.

## [0.21.0] - 2026-10-20

- Release in lockstep with pi-roundtable 0.21.0. The core peer range moves to `>=0.21.0 <0.22.0`.

## [0.20.0] - 2026-10-18

- Release in lockstep with pi-roundtable 0.20.0. The core peer range moves to `>=0.20.0 <0.21.0`.

## [0.19.2] - 2026-10-18

- Release in lockstep with pi-roundtable 0.19.2. The core peer range stays `>=0.19.0 <0.20.0`.

## [0.19.1] - 2026-10-18

- Release in lockstep with pi-roundtable 0.19.1. The core peer range stays `>=0.19.0 <0.20.0`.

## [0.19.0] - 2026-10-17

- Release in lockstep with pi-roundtable 0.19.0. The core peer range moves to `>=0.19.0 <0.20.0`.

## [0.18.0] - 2026-10-17

- Release in lockstep with pi-roundtable 0.18.0. The core peer range moves to `>=0.18.0 <0.19.0`.

## [0.17.3] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.3; no package-specific behavior changes. The core peer range stays `>=0.17.0 <0.18.0`.

## [0.17.2] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.2; no package-specific behavior changes. The core peer range stays `>=0.17.0 <0.18.0`.

## [0.17.1] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.1; no package-specific behavior changes. The core peer range stays `>=0.17.0 <0.18.0`.

## [0.17.0] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.0; no package-specific behavior changes. The core peer range moves to `>=0.17.0 <0.18.0`.

## [0.16.0] - 2026-10-16

- Release in lockstep with pi-roundtable 0.16.0; no package-specific behavior changes. The core peer range moves to `>=0.16.0 <0.17.0`.

## [0.15.4] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.4; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.3] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.3; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.2] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.2; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.1] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.1; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.0] - 2026-10-14

- Release in lockstep with pi-roundtable 0.15.0; no package-specific behavior changes. The core peer range moves to `>=0.15.0 <0.16.0`.

## [0.14.1] - 2026-10-14

- Release in lockstep with pi-roundtable 0.14.1; no package-specific behavior changes. The core peer range stays `>=0.14.0 <0.15.0`.

## [0.14.0] - 2026-10-14

- Release in lockstep with pi-roundtable 0.14.0; no package-specific behavior changes. The core peer range moves to `>=0.14.0 <0.15.0`.

## [0.13.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.13.0; no package-specific behavior changes. The core peer range moves to `>=0.13.0 <0.14.0`.

## [0.12.1] - 2026-10-13

- Release in lockstep with pi-roundtable 0.12.1; no package-specific behavior changes. The core peer range stays `>=0.12.0 <0.13.0`.

## [0.12.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.12.0; no package-specific behavior changes. The core peer range moves to `>=0.12.0 <0.13.0`.

## [0.11.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.11.0; no package-specific behavior changes. The core peer range moves to `>=0.11.0 <0.12.0`.

## [0.10.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.10.0; no package-specific behavior changes. The core peer range moves to `>=0.10.0 <0.11.0`.

## [0.9.13] - 2026-10-13

- Release in lockstep with pi-roundtable 0.9.13; no package-specific behavior changes.

## [0.9.12] - 2026-10-11

- Release in lockstep with pi-roundtable 0.9.12; no package-specific behavior changes.

## [0.9.11] - 2026-10-11

- Release in lockstep with pi-roundtable 0.9.11; no package-specific behavior changes.

## [0.9.10] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.10; no package-specific behavior changes.

## [0.9.9] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.9; no package-specific behavior changes.

## [0.9.8] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.8; no package-specific behavior changes.

## [0.9.7] - 2026-10-10

### Added

- A held call's approval card is also given to the prompt as `ApprovalDetails`, so a surface that shows structured approvals (web chat) gets the call's whole input; other surfaces show the same text card.
- Requires `pi-roundtable` 0.9.7 or later: the desk imports `approvalDetails` from the kit, which 0.9.6 does not export, so the plugin fails to load against an older core even though the peer range allows it.

## [0.9.6] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.6; no package-specific behavior changes.

## [0.9.5] - 2026-10-10

0.9.4 was tagged but never published (its release checks failed on the recorded prompt texts); everything listed under it is released in 0.9.5.

### Added

- A coding worker posts its progress into its thread as it works, as the host's turns do: longer or structured text as ordinary messages, and short narration with the tools it called in one small-text progress message edited in place. Its approval cards come after the text written before them, the report is posted once at the end, and a failed post or edit is logged without failing the job. `interimText: "off"` (on `coding` and `CodingDeskOptions`) keeps today's thread of task, cards and report; `interimPrimaryChars` sets the length of primary text (default 400). It needs pi-roundtable 0.9.5's `DispatchThread.interim`.
- `CodingWorker.run` takes an optional fourth argument, `CodingProgress` (`messageEnd(message)`, `toolStart(name)`), which `PiCodingWorker` feeds from the worker's session over its IPC channel (message text and tool names only, never thinking).

### Changed

- A worker's approval card no longer expires after 30 minutes: the worker waits for the answer, with no countdown on the card, until it is stopped; the waiting does not count against `timeoutMs`.

### Fixed

- A worker's shell gets the host's scratch dir (`env.scratchDir`): TMPDIR points to it, and writes, redirects and removals inside it run without the owner's approval, as in the agents' shell. Before, every scratch-dir command a worker ran asked the owner.
- A worker whose host has a scratch dir is told it in its system prompt, after the host's own prompt or the default, so a task need not say where temporary files and test homes go.

## [0.9.3] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.3; no package-specific behavior changes.

## [0.9.2] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.2; no package-specific behavior changes.

## [0.9.1] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.1; no package-specific behavior changes.

## [0.9.0] - 2026-10-09

- The extra `skill_list` is offered by whom a conversation serves, not by its kind: only a private conversation whose person holds the owner role (`IDENTITY.tierOf`) gets it. A member's private conversation and any shared conversation, an owner's included, get none, and a failed or absent role lookup offers none. A host that ran its owner's conversation with kind `owner` but without `conversation: { visibility: "private", principalId }`, or without recording it private, loses the list until it does. Needs pi-roundtable 0.9, which gives `SessionContext.conversation`.
- `repo_task` refuses the host's own turns, whose speaker is `SYSTEM_PRINCIPAL`, such as an ops error report's or a Discord webhook report's: their text is untrusted input, and a coding task started there would run later as the owner's. Ask the owner to start it. Needs pi-roundtable 0.9, which exports `SYSTEM_PRINCIPAL`.

## [0.8.0] - 2026-10-07

- Release in lockstep with pi-roundtable 0.8.0; no package-specific behavior changes.

## [0.7.18] - 2026-10-05

- Release in lockstep with pi-roundtable 0.7.18; no package-specific behavior changes.

## [0.7.16] - 2026-10-04

- The worker's shell calls follow pi-roundtable 0.7.16's `shellHoldRule`: an `rm` whose operands all resolve inside the job's workspace, without being it, runs without a hold. Every `git push` stays held.
- A finished job frees its repository before its report is delivered, so the report turn can run `repo_change_report`, `repo_push` or the next `repo_task` there; `idle()` still waits for the delivery.

## [0.7.5] - 2026-10-03

- Add `workerBlockText`, `limits` and `diagnosticChars`; git, gh and worker error text and the report and held-action bounds can be raised or lifted by the host.

## [0.7.4] - 2026-10-03

- Add `toolText` and `presentation.list`, accept a 7–40 character sha prefix in `repo_push`, name git and gh stderr (scrubbed) in failures, carry a worker's own error text into the report, restore the earlier timeout, stop and refusal wording, stop listing declined calls as held, and report the channels the service works for.

## [0.7.3] - 2026-10-03

- Hook caller model/thinking/origin/channel, owner policy, clone adoption, threaded approvals and report formatting through options, and add `pushHoldText` for the held `repo_push` card.

## [0.7.2] - 2026-10-02

First release published by the lockstep workflow; no changes to the package.
The `v0.7.1` tag published nothing.

## [0.7.0] - 2026-10-02

Prepared for the first npm publication.
The earlier `0.1.0` was local-only and was never published on npm.

### Changed

- Move into the pi-roundtable workspace with preserved Git history and lockstep version `0.7.0`.
  CI checks the core and all packages; the shared `publish.yml` releases them from one `v*` tag.

### Added

- Add a managed repository shelf with clone, list, change-report and exact-commit push tools.
- Add background out-of-process Pi coding workers with host-side owner cards and a work timeout that excludes approval waits.
- Hold every repository push by default, with an explicit owner-repository allowlist.
- Add configurable Git host cloning, model, Pi extension packages, skill selection and result delivery.
- Document the host security boundary and provide offline integration tests and release workflows.
