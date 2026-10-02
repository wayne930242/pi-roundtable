# Changelog

## [Unreleased]

## [0.7.1] - 2026-10-02

First release published by the lockstep workflow; no changes to the package.

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
