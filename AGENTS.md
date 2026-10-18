# Agent notes

Release steps live in `.github/PACKAGE-RELEASES.md`; read it before bumping versions or pushing a tag.

## Tests

- `servicePair` in `pi-roundtable/testing` wraps a service in a Proxy, so a class with `#private` fields (for example `PgScheduleStore`) throws "Cannot access invalid private field" through it. Pass bound methods or a closure-based object.
- A database test must not leave a host-migrated table dropped: the shared migration ledger makes later `testHost` boots skip recreating it.
- Keep a PostgreSQL data directory outside the repository, for example `~/.cache/pi-roundtable-<task>/pgdata`. The public scan in `scripts/workspaces.test.ts` walks the whole tree, gitignored directories included, and fails on files a running server creates and deletes.
- Run `initdb` and start the server in separate steps, never in one parallel tool batch: the server needs the data directory first.
- A gate script that runs several checks ends with an explicit `GATE-OK` or `GATE-FAILED` line. Printing only the tail once hid a lint failure that was then pushed.
