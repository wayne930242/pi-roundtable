# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.9.3] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.3; no package-specific behavior changes.

## [0.9.2] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.2; no package-specific behavior changes.
- The README named `>=0.8.0 <0.9.0` as the peer range of pi-roundtable; it is `>=0.9.0 <0.10.0`.

## [0.9.1] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.1; no package-specific behavior changes.

## [0.9.0] - 2026-10-09

- Admit only owners, each as their own principal: the verifier reports who signed in (`Verdict.actor`, built with `admitAs`), and the console reads the host's `IDENTITY`, never making or claiming a principal. An identity linked to anyone but an owner is refused, and so is one linked to no one, on a single-owner host too, with one warning per identity that names the line to add to `access.owners[].identities` and the `roundtable principal link` command. An identity of the `legacy` provider, an alias 0.9 keeps for a 0.8 id, is refused. A verifier that reports no actor is taken as the primary owner, or `ownerId`, with one warning. The plugin now requires `IDENTITY`.
  **Upgrading:** add your Access identity, `cloudflareAccessIdentity(teamDomain, sub)`, to your entry in `access.owners[].identities`, or the console answers 403 and logs the identity to add; see the README's "Upgrading from 0.8".
- `cloudflareAccess` reports the user as `oidc:<base64url(https://<teamDomain>)>:<sub>`, named by their email, and refuses a token that names no user; `cloudflareAccessIdentity(teamDomain, sub)` writes that identity for `access.owners[].identities`.
- The Notes pane shows the signed-in owner's own notes, and any principal's through a picker (`GET api/principals`, `?principal=<id>` on the notes API). `ownerId` is no longer required and is deprecated.
- A conversation the host's registry records shows whose it is, by display name, and whether it is private or shared (`ConversationView.principal`, `visibility`).

## [0.8.0] - 2026-10-07

- List the conversations the host's registry (`CONVERSATIONS`) records beside the ones found by their directory names, under a new "Plugin conversations" section with their title and first message, and read their transcripts. A conversation from before the registry is still found by name.

## [0.7.18] - 2026-10-05

- Release in lockstep with pi-roundtable 0.7.18; no package-specific behavior changes.

## [0.7.5] - 2026-10-03

- Show a skill of any size, and add `skills.errorDetail` to show why one cannot be read.

## [0.7.4] - 2026-10-03

- Show a `channel name unavailable` detail for a channel Discord cannot name.

## [0.7.3] - 2026-10-03

- Add feature ports (notes, skills, connectors, cleanup), page presentation and routing options, and the matching console pages.

## [0.7.2] - 2026-10-02

First release published by the lockstep workflow; no changes to the package.
The `v0.7.1` tag published nothing.

## [0.7.0] - 2026-10-02

Prepared for the first npm publication.
The earlier `0.1.0` was local-only and was never published on npm.

### Changed

- Move into the pi-roundtable workspace with preserved Git history and lockstep version `0.7.0`.
  The core peer range is `>=0.7.0 <0.8.0`, and the shared `publish.yml` releases all packages from one `v*` tag.

### Added

- `webConsole(options)`: a plugin that serves a web console on a route of the host's HTTP listener, `/console` by default. The Overview pane shows the agent team, the Conversations pane lists the owner, agent, group-member (`agentgroup_<channel>_<agent>`), and outside-agent conversations stored on disk and shows each transcript (and its archives), and the Notes pane views and edits the owner's memory. The `panes` option chooses the panes.
- Live updates over a server-sent event stream: a change in the channel queue or the agent team, or a note written through the console, reaches an open page as one coalesced `changed` event.
- A `verifier` option, required: `RequestVerifier`, a function from a request to `{ admitted: true }` or `{ admitted: false, reason }`. The plugin throws when the config is loaded if it is missing, so a host never serves the console unauthenticated. `admit()` and `refuse(reason)` build the answers.
- `cloudflareAccess({ teamDomain, audience, email, keys? })`, the built-in verifier: it admits a request whose `Cf-Access-Jwt-Assertion` token is signed by the team's keys, issued by the team, addressed to the application, and carries an allowed email.
- Requests that change data must carry the console's own `Origin` (the required `origin` option); every response carries `nosniff` and a same-origin referrer policy, and the page carries a Content-Security-Policy with `frame-ancestors 'none'`.
- Options `ownerId`, `dataDir`, `mountPath`, `listener`, `title`, `relayNotes`, and `exclude`, checked when the plugin is created.
- The page ships prebuilt in `dist/` with relative URLs, so it works under any `mountPath` and an operator needs no build step. `bun run build` rebuilds it from a checkout.
- Types for the API shapes (`ConfigView`, `OverviewView`, `ConversationsView`, `TranscriptView`, `NoteView`, and the rest).
