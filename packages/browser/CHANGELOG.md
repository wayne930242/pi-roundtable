# Changelog

## [Unreleased]

## [0.22.0] - 2026-10-21

- First release, in lockstep with pi-roundtable 0.22: `browserAgent(options)` and its `browser_task` tool, the `BrowserDriver` port (`start(context)` returns the worker's tools, skills and a `dispose`), and the default `agentBrowserDriver(options)`: agent-browser and Chromium in a Docker container with no network, a host-side egress proxy that refuses every non-public destination, one `agent_browser` tool with a command policy, and the agent-browser guide of the image's own version loaded into the worker. Requires pi-roundtable `>=0.22.0 <0.23.0`, whose `WORKER_SESSIONS` service it uses.
