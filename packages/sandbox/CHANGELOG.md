# Changelog

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
