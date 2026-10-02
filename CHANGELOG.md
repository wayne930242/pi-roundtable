# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-10-02

First release: an owner-only web console for pi-roundtable 0.6, extracted from a private host.

### Added

- `webConsole(options)`: a plugin that serves a web console on a route of the host's HTTP listener, `/console` by default. The Overview pane shows the agent team, the Conversations pane lists the owner, agent, group, and outside-agent conversations stored on disk and shows each transcript (and its archives), and the Notes pane views and edits the owner's memory. The `panes` option chooses the panes.
- Live updates over a server-sent event stream: a change in the channel queue or the agent team, or a note written through the console, reaches an open page as one coalesced `changed` event.
- A `verifier` option, required: `RequestVerifier`, a function from a request to `{ admitted: true }` or `{ admitted: false, reason }`. The plugin throws when the config is loaded if it is missing, so a host never serves the console unauthenticated. `admit()` and `refuse(reason)` build the answers.
- `cloudflareAccess({ teamDomain, audience, email, keys? })`, the built-in verifier: it admits a request whose `Cf-Access-Jwt-Assertion` token is signed by the team's keys, issued by the team, addressed to the application, and carries an allowed email.
- Requests that change data must carry the console's own `Origin` (the required `origin` option); every response carries `nosniff` and a same-origin referrer policy, and the page carries a Content-Security-Policy with `frame-ancestors 'none'`.
- Options `ownerId`, `dataDir`, `mountPath`, `listener`, `title`, `relayNotes`, and `exclude`, checked when the plugin is created.
- The page ships prebuilt in `dist/` with relative URLs, so it works under any `mountPath` and an operator needs no build step. `bun run build` rebuilds it from a checkout.
- Types for the API shapes (`ConfigView`, `OverviewView`, `ConversationsView`, `TranscriptView`, `NoteView`, and the rest).
