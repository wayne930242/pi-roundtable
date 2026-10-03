# pi-roundtable-web

An owner-only web console for [pi-roundtable][roundtable].
It serves one page on a route of the host's HTTP listener, where the owner can browse conversations, read their transcripts, view and edit the assistant's memory notes, and watch the agent team, with live updates.

The console reads what the host already stores: the conversation files under the data directory, the memory addon, and the agent team.
It adds no database, no cookie, and no account system.
Every request must pass an authentication check that you configure, and the plugin refuses to start without one.

## What the console shows

The console has five optional panes; the original three remain the default.
The `panes` option chooses which ones a host serves.

| Pane | What it shows |
|---|---|
| Overview | Every active agent with its model, thinking level, state (working where, waiting, or idle), context use, schedule count, and last activity; every group with its members, host, and busy count. An agent links to its Discord channel and its transcript, and a group to its Discord channel. |
| Conversations | Every conversation stored on disk, in four sections: owner channels (direct messages and channels where the owner talks to the assistant), agent channels, group conversations (each member's conversation inside a group), and outside-agent conversations opened over MCP. Each row shows the channel's name (when the host has a Discord connection), when it was last active, its size, and how many archives it has. An outside-agent conversation shows its first message, when it appears in the first 256 KB of the file, and when it began. |
| Notes | The owner's memory in three tabs, core, notes, and events, with search. The owner can add a note, edit its text, kind, and date, and delete it after a confirmation. The memory addon's own validation applies, so a refusal shows its reason and saves nothing. |
| Skills | The full host catalog, source, groups and carriers; each available skill opens its ordered frontmatter and Markdown body. |
| Connectors | Upstream gateway enabled/reachable/tool status, virtual-server tool lists, and the agents or profiles that use them; an optional administration link. |

Opening a conversation shows its **transcript**: the user's and the assistant's messages, the tools the assistant called with a short preview of their arguments, and each tool's result (collapsed).
A conversation that was started over keeps its archives, and the page can show any of them.
The system prompt and the model's private reasoning are never shown.
A transcript reads at most 8 MB of the newest files and returns at most the last 1000 entries, and it says when it cut the beginning.

The page follows changes without a reload.
A turn starting or ending, a queued message, a change in the agent team, or a note written through the console reaches an open page through a server-sent event stream within about a quarter of a second, and a burst of changes arrives as one event.
Relative times refresh every 30 seconds.
Times and event dates use the host's time zone (`env.timeZone`).

Conversation cleanup is opt-in through `features.cleanup`.
Overview includes stored owner workspaces and outside conversations, and can include separately stored party channels through `features.party`.
Start-over archives a conversation through the host's hook; deletion is restricted to stored owner/outside conversations and a busy refusal becomes HTTP 409.
Confirmation dialogs explain that memory and schedules remain.
Without the cleanup hook, conversations remain read-only.
`GET api/dashboard` is a compatibility view of Overview with channel keys and `agentGuildId`, `channelId`, and `sessionId` aliases for existing clients.

## Requirements

- Bun 1.3 or later, and pi-roundtable `>=0.7.0 <0.8.0` as a peer dependency.
- The host must run on the machine that holds its data directory: the console reads `<dataDir>/sessions` from disk.
- The `memory` addon for the Notes pane (it is on by default; switch the pane off with `panes` when you run without memory).
- A way to authenticate the owner in front of the listener, such as Cloudflare Access, or a verifier of your own (see [Authentication](#authentication)).
- A Discord connection is optional: with the Discord entry's `DISCORD` service the console names channels, and without one it shows channel ids.

The package ships its page prebuilt in `dist/`, so installing it needs no build step and no bundler on the host.
A git checkout has no `dist/` until you run `bun run build`, and the plugin stops at startup with that instruction when the page is missing, so a broken install never serves a blank page.

## Install

```sh
bun add pi-roundtable-web
```

Add the plugin to `roundtable.config.ts`:

```ts
import type { RoundtableConfig } from "pi-roundtable";
import { cloudflareAccess, webConsole } from "pi-roundtable-web";

export default {
	// ...the settings `init` wrote...
	plugins: [
		webConsole({
			verifier: cloudflareAccess({
				teamDomain: "example.cloudflareaccess.com",
				audience: process.env.CONSOLE_ACCESS_AUD ?? "",
				email: "owner@example.com",
			}),
			origin: "https://console.example.com",
			ownerId: "<the owner's Discord user id>",
			dataDir: "./data",
		}),
	],
} satisfies RoundtableConfig;
```

The plugin adds the route `/console` (a redirect to `/console/`) and `/console/…` to the `public` listener, and a line with the console's address to the dashboard message.

## Options

| Option | Default | What it does |
|---|---|---|
| `verifier` | none, required | Decides whether a request comes from the owner. `cloudflareAccess(...)` is built in; pass your own function to use another proxy. |
| `origin` | none, required | The console's own origin as the browser sees it, such as `https://console.example.com`: scheme and host (and port), no path. Requests that change data must carry it as their `Origin`, and the dashboard line links to it. |
| `ownerId` | none | The id the owner's memory is kept under. Required when the Notes pane is served. |
| `dataDir` | `./data` | The host's data directory; the console reads `<dataDir>/sessions`. Set it to the `dataDir` of your configuration. |
| `mountPath` | `/console` | The path the console is served under: one or more segments of letters, digits, `.`, `_`, `~`, and `-`. |
| `listener` | `public` | The id of the listener whose address serves the console. |
| `panes` | `overview`, `conversations`, `notes` | Ordered subset of those panes plus `skills` and `connectors`. Disabled panes answer 404. Skills/connectors require their feature ports at setup. |
| `routing` | `hash` | `path` retains links such as `/console/skills`, with history navigation and an authenticated page fallback. |
| `features` | none | Trusted host integrations, or a factory receiving public plugin setup context; see below. |
| `presentation` | English | `{ locale, messages }`: locale controls dates and document language; English source strings are dictionary keys for labels, descriptions, confirmations, and API errors. |
| `title` | `Roundtable` | The page's heading and title. |
| `relayNotes` | the remote MCP note | Text that an outside agent's relayed message begins with, taken off before the owner's words are shown. Set it to the same value as the `relayNote` of [pi-roundtable-mcp][mcp] when you changed that one. |
| `exclude` | none | A function from a channel key to `true` for conversations the console must neither list nor read, such as the channels of another plugin that keeps its own sessions in the same directory. |

The options are checked when the plugin is created, so a bad setting stops the host at startup: no verifier, an `origin` with a path, a `mountPath` of `/` or with `..` in it, an unknown or repeated pane, or Notes without an `ownerId`.

The console also needs the agent server for the Overview pane and the memory addon for the Notes pane.
The host refuses to start with a message naming the missing service when one of them is absent for a pane you serve.

## Host feature ports

`features` may be an object or a synchronous/asynchronous factory `(context) => features`.
Use the setup context to bind existing services; no database tables or session paths are renamed.
The host wrapper must declare any additional required service keys in its plugin's `requires`.

| Port | Contract |
|---|---|
| `party` | `contains(key)` separates party channels from owner transcripts; `list()` returns `PartyView[]` with channel, profile, enabler, enabled time, container state, busy count and optional last activity. |
| `schedules` | `count(key)` returns the workspace schedule count. |
| `cleanup` | `startFresh(key)` archives/waits for active turns and returns its kind; `deleteConversation(key)` returns `deleted` or `busy`. The package validates key shape, ownership, existence and exclusions before calling either hook. |
| `skills` | `catalog()` supplies public `SkillView[]`; `read(name)` reads only that catalog entry and returns `{ frontmatter, body }`. The host bounds disk reads; the API caps body at 1 MB and frontmatter at 64 KB and flattens metadata in source order. |
| `connectors` | `gateways()`, `servers()`, `usedBy(server)` provide status/tools/usage. Optional `adminUrl` accepts HTTP(S) or an absolute local path, never script URLs. |

`sessionSummary(directory)` is a public helper for a trusted host to summarize separately stored party session files.
It reports live bytes, archive count and last activity without revealing message contents.
Generic source and defaults are English; keep application names and localized wording in the host's presentation dictionary.
Authenticated HTML carries inert, escaped presentation metadata so the first API failure is localized too, without inline scripts.
The page ships prebuilt, so application adapters do not need their own React build or a second server implementation.

```ts
webConsole({
  // ...verifier, origin, ownerId...
  mountPath: "/console",
  routing: "path",
  panes: ["overview", "notes"],
  presentation: { locale: "fr", messages: { "Start over": "Recommencer" } },
  features: (context) => ({
    cleanup: {
      startFresh: (key) => context.conversations.startFresh(key),
      deleteConversation: (key) => context.conversations.deleteConversation(key),
    },
  }),
});
```

When serving Skills and Connectors, provide those hooks as well; a missing port fails startup rather than silently dropping a pane.

## Authentication

The console never decides who the owner is.
It asks the `verifier` about every request under its path, before it reads anything, and answers `403 Forbidden` with no detail when the verifier refuses, throws, or rejects.

A verifier is a function that receives the `Request` and returns `{ admitted: true }` or `{ admitted: false, reason }`.
The reason goes to the host's log and is never sent to the client, so keep secrets out of it.
`admit()` and `refuse(reason)` build the two answers.

### Cloudflare Access

`cloudflareAccess(options)` is the built-in verifier.
Cloudflare Access sits in front of your tunnel or proxy, signs in the owner, and adds a signed token to each request it forwards as the `Cf-Access-Jwt-Assertion` header.
The verifier admits a request only when the token is signed by your team's published keys, was issued by your team, is addressed to this application, and carries an email you allow (compared without regard to case).
It checks the token on every request and fetches the team's signing keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, caching them and following their rotation.
If the keys cannot be fetched and none are cached, requests are refused.

| Option | What it is |
|---|---|
| `teamDomain` | Your Access team domain, `<team-name>.cloudflareaccess.com`, with no scheme or path. |
| `audience` | The Application Audience (AUD) tag of the Access application that protects the console. |
| `email` | The email, or a list of emails, that may use the console. |

To set it up:

1. Route a hostname to the host's listener, for example with a Cloudflare Tunnel whose public hostname (`console.example.com`) points at the listener's port or unix socket.
   Use a hostname you do not share with anything that must stay open.
2. In the Cloudflare dashboard, open Zero Trust, then Access controls, then Applications, and add a **Self-hosted** application for that hostname.
   Add the path `console` to the application's public hostname to protect only the console, or leave the path empty to protect the whole hostname.
3. Give the application one **Allow** policy that includes only the owner's email.
   Do not add a Bypass or an Everyone policy.
4. Open the application's configuration, and under Additional settings copy the **Application Audience (AUD) Tag**.
   Keep it in an environment variable and pass it as `audience`.
5. Take your team name from Zero Trust settings, the `<team-name>` of `<team-name>.cloudflareaccess.com`, and pass the full domain as `teamDomain`.
6. Set the plugin's `origin` to the address you opened in step 1, `https://console.example.com`.

A request to the console from a browser that has not signed in is sent by Access to its login page and never reaches the host.
The host still refuses any request that arrives without a valid token, so a listener that becomes reachable without Access, through a wrong route or a second tunnel, does not open the console.

### A verifier of your own

Behind another authenticating proxy, write the verifier for what that proxy sends.
This one trusts a header that a reverse proxy sets after it has authenticated the owner, which is safe only when the proxy removes the header from client requests and the listener cannot be reached except through the proxy, for example on a unix socket (`http.socketPath`) that only the proxy's user can open:

```ts
import { admit, refuse, webConsole } from "pi-roundtable-web";

const OWNER = "owner@example.com";

export const web = webConsole({
	verifier: (request) =>
		request.headers.get("x-authenticated-email")?.toLowerCase() === OWNER
			? admit()
			: refuse("not the owner"),
	origin: "https://console.example.com",
	ownerId: "<the owner's Discord user id>",
});
```

A verifier can also verify a signed token itself, with `jose` or any other library, which does not depend on the network path and is the stronger choice when the proxy can sign what it sends.
It may be asynchronous; a thrown error or a rejected promise counts as a refusal.

## Threat model

**What the console protects.**
The conversations hold everything the owner said to the assistant and what the assistant answered, including tool calls and their results, and the memory notes shape every later turn.
The console serves that to one owner and nobody else.
It has no roles, no per-user views, and no audit trail beyond the host's log, which records only that a request was refused and why.

**Authentication is the verifier, and only the verifier.**
The console sets no cookie and keeps no session.
The built-in Cloudflare Access verifier checks a signature, so a client that can reach the listener directly still cannot forge a token.
A custom verifier that trusts a plain header is exactly as strong as the guarantee that clients cannot set that header: use a unix socket or a firewall rule so that only the proxy reaches the listener, and have the proxy strip the header from inbound requests.
The console does not rate-limit failed requests; do that at the proxy.

**Cross-site requests.**
A request that changes data (`POST`, `PATCH`, `DELETE`) is refused unless its `Origin` header is exactly the configured `origin`, after the verifier has admitted it.
Reads change nothing.
A page on another site that makes the owner's browser send a request therefore cannot write notes, and it cannot read the answers either, because the console sends no CORS headers.

**Cross-site scripting and framing.**
The page is a prebuilt bundle served from the same origin.
Every response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`, and the page carries a Content-Security-Policy of `default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, so it loads only its own script and style and cannot be framed.
Path routing uses `base-uri 'self'` for the package-inserted, validated mount base.
Transcript text, notes, and channel names are rendered as plain text, and no link is taken from a transcript.
Skill documents render Markdown with raw HTML escaped, no fetched images, and only HTTP(S) links; relative links remain non-navigating text.
Links to Discord are built by the page from channel ids, not taken from stored text.

**Errors reveal nothing to the client.**
Every API error is a fixed message.
It never repeats the request URL, a header, or a token, and a refusal answers `403 Forbidden` with that single word.
The console logs a failure with the error that was thrown and nothing from the request: no URL, no headers.
The text of an error that your own code throws, such as a memory store's, is logged as it is.

**Path handling and resource limits.**
A conversation is named by a channel key that must match `discord:<id>`, `agentgroup:<id>.<agent>`, or `mcp:<uuid>` exactly, and an archive is chosen from the folder's own listing, so no request can name a path.
A note request body is limited to 64 KB, a transcript to 8 MB read and 1000 entries, an entry's text to 20 000 characters, and the list of an outside agent's first message to the first 256 KB of its file.
Session directory, file and archive symlinks are not followed by the console.
At most 32 event streams stay open at once, and a stream whose client falls 16 events behind is closed, after which the page reconnects and refetches.

**What the transcript can reveal.**
A transcript shows the arguments of the assistant's tool calls (the first 200 characters) and the first 2000 characters of each result.
If your tools handle secrets, they can appear there.
Serve only the `notes` pane, or use `exclude`, when that is a concern.

**Out of scope.**
Transport security (terminate TLS at the proxy), protecting the data directory on disk, and other users of the host are not the console's job.
The console is for one owner on one host.

## Development

This package lives in `packages/web` in the pi-roundtable workspace.
Install at the repository root, then run the package scripts:

```sh
bun install --frozen-lockfile
bun run --cwd packages/web build       # builds the page into dist/
bun run --cwd packages/web typecheck   # the server and the page
bun run --cwd packages/web lint
bun run --cwd packages/web test
bun run --cwd packages/web fixture     # a local host with fixture data
```

`bun run fixture` starts the plugin on pi-roundtable's test harness over fixture conversations on port 4173, behind a stand-in for the authenticating proxy that signs a test Access token, and the same listener without it on port 4174, which must answer 403.
`/fixture/message` appends a message to the owner's conversation and `/fixture/work` toggles the agent between working and idle, so the live updates can be watched.

The page is React, bundled with Bun's bundler into relative URLs, so it works under any `mountPath`.
Pages use URL fragments by default (`#/notes`, `#/conversations/<key>`); `routing: "path"` uses mount-relative page paths instead.

The package shares the core's version and single `v*` release tag.
The shared `publish.yml` checks every workspace, then publishes each separately with provenance; this package's `prepack` builds the page.

[roundtable]: https://www.npmjs.com/package/pi-roundtable
[mcp]: https://www.npmjs.com/package/pi-roundtable-mcp
