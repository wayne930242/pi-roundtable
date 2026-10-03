# Changelog

## 0.7.10

- Compact Pi worker sessions with the core's tiers (300,000 tokens through a host compactor, Pi's summary past 500,000), through the new `compaction` option (`PiCompactor`: `engine`, `compact(request, { channel, signal })`, `timeoutMs`, `maxRequestBytes`) and the protocol types `PiCompactRequest`, `PiCompaction`, `PiCompactResponse`, `PiCompactionReport`, `PiCompactMessage` and `PiWorkerConfig`; the host logs every compaction and fallback per channel.
- A failed `runTurn` keeps its cause (`AgentRunError` message and `cause`, whether it timed out) and logs it; the broker logs upstream failures with channel, status, latency and the error body; a timed-out worker's last 200 log lines are logged before its container is removed (`PiContainerDriver.logs`).
- Behavior change: Pi containers log to journald tagged `sandbox/<channel>` by default, instead of two 10 MiB `local` files, so the Docker daemon must run with journald (pass `PiDockerContainerDriver` a `log` option for another driver) (`PiContainerSpec.log`, `PiDockerContainerDriver` option `log`, `defaultContainerLog`), and the worker logs model, broker, tool and compaction failures.

## 0.7.5

- `ScopedSandboxDelegator` limits a title to 200 characters by default again, and accepts `maxTitleChars`, `maxReportChars` and `diagnosticChars`.

## 0.7.4

- Let `SandboxResearchWorker` run the host's own web tools (`tools`, `scope`, `aborted`), and make `ScopedSandboxDelegator` refuse and fail with readable reasons (scrubbed) instead of generic text, with no title limit.

## 0.7.3

- Add the opt-in Pi subscription mode (`PiSandboxRuntime`, `PiSandboxBroker`, `PiDockerContainerDriver`), worker-initiated transport, controlled `safeFetch`, bounded media in and reply files out, scoped delegation and a research worker, with the sealed default unchanged.
- Add `assertPublicUrl`, `safeFetch` `followRedirects` and `headers`, and a research-worker `fetchContent` hook for hosts that keep a library's own extractors.
- Keep upstream error status, body and back-off headers through the rich broker, re-arm the metadata-only startup window for a restarted worker, and refuse compressed Teredo addresses.
- Stream rich broker responses without fixed total caps (the turn deadline is the bound), bind the host-judged thinking level so the worker can only ask for less, and replace guest-planted symlinks on start and start-fresh instead of following them.

## 0.7.2

- First release published by the lockstep workflow; no changes to the package. The `v0.7.1` tag published nothing.

## 0.7.0

- Move into the pi-roundtable monorepo at `packages/sandbox`, preserving Git history.
- Align the version, core development dependency, and peer range with core 0.7.0 (`>=0.7.0 <0.8.0`).
- Use the shared checks and lockstep publication workflow; the Docker integration remains opt-in locally and runs explicitly in Linux CI.

## 0.1.0

- Add sealed text-only guest channels for pi-roundtable 0.6.1 using Docker on Linux.
- Add a per-turn Unix broker with fixed model forwarding, host-only credential swapping, tool and MCP allow-lists, and bounded requests.
- Add persistent channel and speaker memory inside each isolated workspace.
- Add owner-only sandbox on, off, and status commands using the shared channel queue.
- Ship the minimal worker image, setup example, threat model, offline tests, optional Docker integration test, and CI/publish workflows.
