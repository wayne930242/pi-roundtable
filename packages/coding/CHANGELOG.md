# Changelog

## [Unreleased]

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
