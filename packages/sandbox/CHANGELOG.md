# Changelog

## 0.7.13

- `precheckScriptRunner` forwards only the tools approved with the script (pi-roundtable 0.7.13's `PrecheckScriptContext.tools`) among those `grant` allows, and takes `toolName(server, tool)`, the name the host's hold rules know a tool by (default the tool's own name).

## 0.7.12

- A host compactor gets at most half the time the turn has left (the runtime passes the broker its `deadline`, `PiHostContext.deadline`), so Pi's own summary still fits after it runs out; with under two seconds left the broker falls back to Pi's summary at once.
- The broker logs the first `error` event of a server-sent event stream that started with a 200 (`sandbox upstream call failed`, with the event's data, credentials removed), which the status alone never showed; the worker still receives the whole stream.

## 0.7.11

- `precheckScriptRunner` runs agents' precheck scripts (pi-roundtable 0.7.11) in a sealed container per run: no network, a read-only root, no capabilities, a non-root user, an empty workspace, and a per-run broker (`precheckBroker`) that forwards only single `tools/call` requests of the tools `grant(scope)` allows, with the host's credential (`PrecheckMcpServer`). The container runs `worker/precheck-main.ts` (`PRECHECK_ENTRYPOINT`, `PrecheckWorkerInput`), which gives the script `mcp.call`, `mcp.json`, `firedAt`, `timeZone`, `today`, and `schedule`.
- A script's workspace is mounted read-only (`ContainerSpec.workspaceReadOnly`), so it writes only to the container's bounded `/tmp`. The broker refuses an answer that carries the credential plainly, escaped, inside JSON text, base64-encoded, or as a key; joins an SSE event's `data:` lines; and refuses a second call while one is pending (409) without spending the budget. The script's console output goes to stderr and never into its answer, and `grant` receives the creator's `tier`.
- `ContainerSpec` takes `entrypoint`, and `DockerContainerDriver.exec` runs a sealed container with any input and a bounded output (`PrecheckContainerDriver`); `worker/Dockerfile` includes the precheck worker.

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
