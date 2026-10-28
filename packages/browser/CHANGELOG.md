# Changelog

## [Unreleased]

## [0.23.1] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.1; no package-specific behavior changes. The core peer range stays `>=0.23.0 <0.24.0`.

## [0.23.0] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.0; no package-specific behavior changes. The core peer range is now `>=0.23.0 <0.24.0`.

## [0.22.5] - 2026-10-25

- Release in lockstep with pi-roundtable 0.22.5. `engines.bun` is now `>=1.4.4` (was `1.4.2`) so no supported setup runs a Bun with the Brotli decoder bug (CVE-2026-111497). The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.4] - 2026-10-25

- Release in lockstep with pi-roundtable 0.22.4; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.
- The worker image builds on `node:24.22.1-bookworm-slim` (was the floating `node:24-bookworm-slim`), the first Node 24 with the Brotli decoder fix (CVE-2026-111497). Rebuild the image.

## [0.22.3] - 2026-10-23

- Release in lockstep with pi-roundtable 0.22.3; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.2] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.2; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.1] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.1; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.0] - 2026-10-21

- First release, in lockstep with pi-roundtable 0.22: `browserAgent(options)` and its `browser_task` tool, the `BrowserDriver` port (`start(context)` returns the worker's tools, skills and a `dispose`), and the default `agentBrowserDriver(options)`: agent-browser and Chromium in a Docker container with no network, a host-side egress proxy that refuses every non-public destination, one `agent_browser` tool with a command policy, and the agent-browser guide of the image's own version loaded into the worker. Requires pi-roundtable `>=0.22.0 <0.23.0`, whose `WORKER_SESSIONS` service it uses.
