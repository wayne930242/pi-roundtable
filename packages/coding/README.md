# pi-roundtable-coding

A repository shelf and an out-of-process Pi coding desk for [pi-roundtable][roundtable].
Agents and owner sessions get five repository tools; coding jobs commit locally and report back, while shipping stays behind the owner's approval.
This package is a reference for the plugin guide's [Helpers for a Pi session of your own][helpers].

## Requirements

- Bun 1.4.2 or newer on a POSIX host (Linux or macOS).
- pi-roundtable `>=0.8.0 <0.9.0` as a peer dependency; this package uses only its public main, kit and testing entries.
- Pi `>=1.0.0 <2`, shared with the host's core dependencies.
  A core-only host still pinned to Pi 0.99.x must update its Pi dependencies before adding coding, so cross-package extension and session types resolve to one Pi version.
- Git, plus GitHub CLI (`gh`) for the default clone implementation.
- A Git host token with read access to repositories being cloned and write access to those being pushed, or a host login holding that token.
- Pi model credentials available through the host's Pi login or the provider's environment variables.

The default clone uses `gh repo clone owner/repo` and inherits `GH_TOKEN` or the host's `gh auth login` credentials.
Configure Git's credential helper for later `git fetch` and `git push` (for GitHub, `gh auth setup-git`).
Use a least-privilege token and restrict its repositories; tokens are never package options, tool arguments or remote URLs.
The package does not print subprocess output or Git authentication diagnostics and never logs credentials.
The coding worker inherits the host environment and can read files accessible to that host user: do not give it credentials you would not give a trusted coding agent.
A custom `clone(repo, destination)` can use another Git host's CLI, credential helper or SSH login, and must create a Git clone with an `origin` remote.
No network calls are needed by the offline test suite.

## Setup

```sh
bun add pi-roundtable-coding pi-roundtable
```

```ts
// roundtable.config.ts
import { coding } from "pi-roundtable-coding";

export default {
  // ...the settings created by pi-roundtable init...
  plugins: [
    coding({
      shelfDir: "/srv/roundtable/repos",
      model: "anthropic/claude-sonnet-4-6",
      thinking: "medium",
      timeoutMs: 60 * 60_000,
      // Default []: every repo_push is held for approval.
      ownerRepos: [],
    }),
  ],
};
```

The model is an explicit `provider/model-id` available on this host, not selected by this package.
`agentDir` defaults to Pi's host login directory and controls its `auth.json` and `models.json` locations.
No automatic extension, skill, prompt-template or theme discovery is enabled for workers.
Only repository context files within the clone are included as standing instructions.

To load installed Pi extension packages (for example a model provider), pass their absolute package directories in `workerPackages`.
Resolve them from your configuration rather than from a core checkout:

```ts
import { packageDir } from "pi-roundtable/kit";

const workerPackages = [packageDir("your-provider-package", import.meta.url)];
```

Install the provider package on the host first and pass `workerPackages` to `coding`.
Workers activate only `SHELL_TOOLS` (`bash`, `read`, `edit`, `write`); extension packages are trusted executable code, not a way to grant extra model tools.

## Tools and flow

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `repo_add` | `repo` | Clone `owner/repo` into `shelfDir/owner/repo`; refuse invalid names and existing clones. |
| `repo_list` | `fetch?` | List paths, branches, upstream ahead/behind counts, dirty files, last commits, prose summaries, CI hints and linked skills. |
| `repo_task` | `repo`, `task`, `skills?` | Start a background worker, returning its job number immediately. The host's own turns, such as a report's, may not. |
| `repo_change_report` | `repo` | Fetch and post the commits and diffstat ahead of the default branch; return its full SHA. |
| `repo_push` | `repo`, `sha` | Push the exact reported SHA to the reported default branch, without force, after the hold gate permits it. |

All five tools have `minTier: "owner"` and are contributed through `defineTool` for agent and owner session selections.
The operator remains responsible for any tool-tier overrides.
A custom owner claim with a restricted `ToolSelection` must include the exported `REPO_TOOLS` names; include `skill_list` separately when the host skills addon is enabled.
The host's skills addon resolves explicit skills, or the calling agent's carried skills when omitted; an owner call carries none unless it names them.
Missing or unknown skills refuse the task by default; requesting skills while the addon is off also refuses it.
`skipUnavailableCarriedSkills: true` opts into skipping unavailable implicit skills and disclosing them in the task-start text or through `presentation.taskStarted`.
Explicit skill requests still refuse missing or unknown skills.
A private conversation whose person holds the owner role, as `IDENTITY.tierOf` tells, gets the public `skillListExtension`, whatever its kind.
A member's private conversation and any shared conversation, an owner's included, get none; so does every conversation when the identity service is absent or its lookup fails.
Agent sessions keep the core's existing `skill_list` instead of registering it twice.
The role is read when the session is built, so a role granted or removed later applies once the session is rebuilt.

A worker reads the repository's instructions, edits and checks the work, and commits using repository conventions.
One worker may use a repository at a time, with up to three per channel.
Reports and pushes refuse a repository while its coding worker is still running.
The plugin also reserves repositories during report and push operations, refusing concurrent shipping calls and new coding tasks.
The worker's report includes its final answer, declined or unanswered actions, branch, HEAD, new commits and uncommitted files.
Failures and timeouts also report the final Git state when it can be read.
By default reports are sent to the caller's surface; `onResult(result)` can instead enqueue a background conversation turn through your host integration.
Dates are formatted using `context.env.timeZone`, not a process-wide zone.

Shipping is separate from coding:

1. Review the worker's changes and verification evidence.
2. Call `repo_change_report`; the clone must be clean, ahead of `origin/HEAD`, and missing none of its commits.
3. Call `repo_push` with the full SHA from that report.
4. The host holds the push and asks the owner before running it.

`ownerRepos` is an exact list of `owner/repo` names, not a prefix or wildcard; its default is empty.
Listed repositories skip the plugin's `repo_push` hold, though other host hold rules can still hold the call.
A trusted `isOwnerRepo(repo)` host policy can grant additional exemptions, including repositories created after startup; only literal `true` grants one.
The package validates the repository name before consulting it.
Never derive this policy from model input, clone files, or remote repository instructions.
Neither exemption bypasses shell pushes, risky worker actions, or other linked host rules.
The report and approval card name the full SHA, current default branch and credential-free push destination.
The clone must have exactly one push destination; HTTP remote URLs with user information, query strings or fragments are refused before fetching.
A changed HEAD, dirty clone, changed remote default branch, changed push destination, missing report or non-fast-forward remote causes refusal.
Report receipts live in memory, so request a fresh report after restarting the host.

## Approvals and work time

Every worker tool call crosses a private Bun IPC channel to the parent process before execution.
The parent consults `shellHoldRule`, additional `holds`, and the host's linked hold rules; a recognized risky action asks the owner's surface prompts using `approvalCard`.
When `threads` is configured, progress and cards stay in a thread opened under the resolved run's `origin`; if no thread can open, calls remain held rather than falling back to another channel's approval cards.
Without `threads`, the resolved report channel's prompts are used.
`threadText` controls the initial post, held-action post, approval title and final report; the thread is archived before `onResult` is called, and a failed thread post/close does not discard result delivery.
`promptSlot` tracks these cards and `workTimeout` excludes their waiting time from the worker's budget (one hour by default).
`timeoutMs` must be positive and finite, and at most 2,147,483,647 ms to fit the host timer.
An approved call runs; a declined, expired, missing or failed card blocks it and instructs the worker not to retry or work around the refusal.
Unapproved actions appear in the report rather than running later automatically.
By default worker answers are capped at 20,000 characters and the Held list keeps ten entries of at most 1,000 characters each, with explicit truncation and omission notices; `limits` changes each bound.
A worker failure carries its exit category and numeric code; git and gh stderr and the worker's own error text reach the report only after `scrubDiagnostic` masks credentials, and are cut at `diagnosticChars`.
Card expiration is determined by the host's surface implementation, not this package.

The worker runs in a fresh Bun child process with an unsaved Pi session and uses the public `runWorkerTask` helper.
Timeout and shutdown kill its POSIX process group and wait for exit; normal completion also removes shell descendants left in that group.
The service advertises running jobs through `busy()` so the host can drain them before shutdown.
Jobs are in memory; they do not resume after a crash.
The injectable `worker` runner must observe aborts and settle its run; this is a trusted test/integration seam.

## Security model

This is a host coding desk, **not a sandbox**.
The worker can run local checks, read the host's accessible files, use the network and commit changes.
Its standing instructions delegate shipping to the calling agent; repository tools and extra package tools are not activated inside the worker.
`repo_push` is the supported shipping route and always uses a previously reported full SHA and a non-force push.
The public shell rule holds recognized shell pushes, destructive commands, privileged commands and recognized writes outside the configured worker workspace (the clone by default), even for owner-owned repositories.
It is a heuristic guard: scripts, interpreters, symlinks, Git hooks, package extensions and detached grandchildren are not an OS isolation boundary.
A trusted package or arbitrary shell program can bypass heuristic detection; only run code and repositories you trust, under a dedicated low-privilege host user.
Use an isolated container or VM when host access is unacceptable.

The shelf validates names with the public `checkRepoName` helper and checks real paths before operating on a clone, refusing paths that escape the shelf or Git directories that escape a clone.
Metadata discovery skips symlinks, directories and special files, reads at most 64 KiB per file, and refuses symlinked workflow directories.
Git commands use argument arrays, not interpolated shell commands.
Host-side Git operations disable repository hooks and fsmonitor; the coding worker's own Git operations retain repository conventions.
Local Git credential helpers and other executable Git configuration still run as the host user and can be written by a worker, so repository configuration is a trusted boundary, not an approval boundary.
Keep external processes from changing shelf paths or Git refs during approval and push; these checks do not serialize unrelated host writers.
Model output, diffs and tool inputs can contain sensitive repository content, so report channels and approval cards must remain owner-trusted.

## API and options

`coding(options)` is the plugin factory.
The `CODING` service exposes `shelf: RepoShelf` and `desk: CodingDesk` for trusted owner integrations; direct service calls are not the host tool approval gate.

| Option | Default | Purpose |
| --- | --- | --- |
| `shelfDir` | required | Managed clone directory. |
| `model` | required | Worker provider/model ID. |
| `thinking` | `medium` | Pi thinking level. |
| `ownerRepos` | `[]` | Exact push-hold exemptions. |
| `isOwnerRepo` | none | Trusted host policy for additional push-hold exemptions; must return literal true. |
| `pushHoldText` | repository, sha, target and branch | Trusted wording for the approval card of a held `repo_push`; it never changes who is held. |
| `adoptClones` | `[]` | Startup `{ from, repo }` moves of standalone clones; existing shelf destinations are never replaced. |
| `resolveRun` | configured model/thinking, caller channel | Per-caller model, thinking, report channel and optional thread origin. |
| `postChangeReport` | caller surface reply | Post the record using the calling identity and channel. |
| `presentation` | English package text | Separate change-report post/result text, task-start/omitted-skill wording, and the `repo_list` result (`list(repos, { shelfDir, fetched })`). |
| `toolText` | package wording | Trusted description and argument descriptions for each repository tool, as `{ repo_task: { description, parameters: { task: "…" } } }`; it never changes a tool's arguments or approval rules. |
| `threads` | none | Public `DispatchThreads`-compatible progress and approval thread port. |
| `threadText` | English package text | Thread introduction, held-action notice, approval title and final report. |
| `workerWorkspace` | individual clone | Trusted shell-policy write boundary; not an OS sandbox. |
| `workerPrompt` | generic worker instructions | Trusted standing prompt replacement; it cannot bypass approval or cleanup. |
| `workerBlockText` | "The owner declined / has not approved this call. Do not retry it or work around it; list it under Held in your report." | Trusted wording of what the worker reads when a call is declined or held, from `(answer, action)`; it never changes who is held, and the desk lists only unanswered calls as held. |
| `limits` | 20,000 report characters, 10 held entries of 1,000 characters | `{ reportChars?, heldEntries?, heldChars? }`: what a report keeps of a long run; each is a whole number of at least 1, or `Infinity` for no bound. |
| `diagnosticChars` | `600` | Longest git, gh and worker error text kept in a failure; a whole number of at least 1, or `Infinity`. |
| `skipUnavailableCarriedSkills` | `false` | Skip and disclose unavailable implicit skills; explicit skill requests still refuse them. |
| `workerPackages` | `[]` | Absolute installed extension paths. |
| `agentDir` | Pi host directory | Pi credentials and model configuration. |
| `timeoutMs` | `3600000` | Work-time limit in ms, excluding owner wait; 0 < value <= 2147483647. |
| `holds` | none | Additional worker hold check. |
| `clone` | `ghClone` | Git-host clone implementation. |
| `worker` | `PiCodingWorker` | Trusted worker runner replacement. |
| `onResult` | surface reply | Report delivery integration. |

`RepoShelf`, `CodingDesk`, `PiCodingWorker`, `CodingWorkerFailure`, `REPO_TOOLS`, `codingReport`, `reportPost` and their option/result types are exported for testing and host integrations.
`resolveRun(turn)` receives the public `ToolTurn`, including the calling agent scope and channel.
It returns `{ model, thinking, channel, origin? }`; skill selection still follows the caller, not the resolved report destination.
`onResult` receives those fields plus loaded `skillNames` and the optional progress `thread` in `result.job`, so a host can enqueue its own localized conversation turn.
`adoptClones` and `RepoShelf.adopt` keep existing clone contents and path layout without database migrations.
No database or Discord-specific types are required.

## Development and publishing

This package lives in `packages/coding` in the pi-roundtable workspace.
Run these commands from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/coding test
bun run --cwd packages/coding typecheck
bun run --cwd packages/coding lint
```

Tests use temporary bare Git origins, `testPlugin`, fake workers and a real child Pi session with an offline faux provider.
They cover cloning/listing, reports, push holds and approved pushes, owner exceptions, work-time exclusion, bad names, closed approval paths and child-process exit.
CI runs those checks.
The shared `publish.yml` workflow repeats them, checks that every workspace version and core peer range match the single `v*` tag, then uses npm trusted publishing with provenance.
The owner performs the initial npm publication and configures this package's trust against `publish.yml`; no separate repository or package-specific tag is needed.

## License

MIT; see [LICENSE](LICENSE).

[roundtable]: https://www.npmjs.com/package/pi-roundtable
[helpers]: https://github.com/wayne930242/pi-roundtable/blob/master/docs/plugins.md#helpers-for-a-pi-session-of-your-own
