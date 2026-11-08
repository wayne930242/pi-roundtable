# Agent notes

Release steps live in `.github/PACKAGE-RELEASES.md`; read it before bumping versions or pushing a tag.
Never edit a `CHANGELOG.md` for a change that is not yet released: add `changes/unreleased/<branch>.md` (format in `changes/README.md`; `type: none` when no user sees the change). A pull request that changes shipped source without one fails CI. `bun scripts/release.ts <version>` assembles the fragments and moves every version and range; it commits, tags and pushes nothing.
A new migration needs its id recorded: `bun scripts/migration-ids.ts --record` (the baseline test fails until then, and refuses a renamed or removed id).

## Layout

- `src/core` holds no source file of its own; a new file goes into its layer's directory. `kernel/` imports nothing else of the core, the area directories (`agents/`, `routing/`, `identity/`, `modules/*`, ...) build on it, `plugin-api/` is what a plugin is written against, and `host/` assembles the host: only `host/` and `testing/` import it. `scripts/boundaries.ts` checks these directions, and that no two core directories import each other at run time; break a new cycle by moving the shared name down a layer.
- `src/core/agents`, `routing`, and `threads` are the team's and work for any channel type: they name no Discord (`discordKey`, `"discord"`, `guild`). `scripts/discord-names.baseline.json` records the mentions still there, each file at its count; a count may only go down, so put a new place behind the surface contract rather than raise one, and lower or remove the entry when a file shrinks (`bun scripts/boundaries.ts --discord-names` prints the current list).
- No TypeScript file under `src`, `packages`, `scripts`, or `examples` passes 500 lines (700 for a test). `scripts/file-size.baseline.json` records the files already over, each at its count; a count may only go down, so split a file rather than raise it, and lower or remove its entry when it shrinks (`bun scripts/file-size.ts` prints the current list).

## Tests

- `servicePair` in `pi-roundtable/testing` wraps a service in a Proxy, so a class with `#private` fields (for example `PgScheduleStore`) throws "Cannot access invalid private field" through it. Pass bound methods or a closure-based object.
- A database test must not leave a host-migrated table dropped: the shared migration ledger makes later `testHost` boots skip recreating it.
- Keep a PostgreSQL data directory outside the repository, for example `~/.cache/pi-roundtable-<task>/pgdata`. The public scan in `scripts/workspaces.test.ts` walks the whole tree, gitignored directories included, and fails on files a running server creates and deletes.
- Run `initdb` and start the server in separate steps, never in one parallel tool batch: the server needs the data directory first.
- A gate script that runs several checks ends with an explicit `GATE-OK` or `GATE-FAILED` line. Printing only the tail once hid a lint failure that was then pushed.
