# Changes

A branch that changes what a user of a published package sees adds one file here instead of editing a `CHANGELOG.md`: `changes/unreleased/<branch-name>.md`.
Two branches never share a file, so their changelog entries never conflict.
`bun scripts/release.ts <version>` assembles the files into the root and workspace changelogs and deletes them; see [the release steps](../.github/PACKAGE-RELEASES.md#subsequent-lockstep-releases).

```md
---
type: Fixed        # Added | Changed | Deprecated | Removed | Fixed | Security | none
packages: [core, web]   # core is the root pi-roundtable; the others are directories under packages/
---
One changelog entry per paragraph, written as the changelog would say it.

A second paragraph is a second entry.
```

- `type` is the changelog section. `none` marks a change no user sees (a refactor, a test, an internal script); give the reason as the text, and leave `packages` out.
- An entry lands in the changelog of every package named. A fragment that names only workspaces also adds its entries to the root changelog, led by `pi-roundtable-<name>:`; add `root: false` to keep it out.
- A package that no fragment names gets `Release in lockstep with pi-roundtable X (summary); no package-specific behavior changes.` from `release.ts --summary`.
- Entries written by hand under `## [Unreleased]` in a changelog are kept and come first.
- CI (`scripts/check-fragments.ts`, pull requests only) requires a new file here when a pull request changes shipped source (`src/`, `packages/*/src/`, `packages/*/web/`, `templates/`, or a manifest's `exports` or `bin`), and reads every fragment.
