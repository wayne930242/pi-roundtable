# pi-roundtable-web

A web console for the owners of a [pi-roundtable][roundtable] host.
It serves one page on a route of the host's HTTP listener, where an owner can browse conversations, read their transcripts, view and edit the assistant's memory notes, and watch the agent team, with live updates.

The console reads what the host already stores: the conversation files under the data directory, the memory addon, and the agent team.
It adds no database, no cookie, and no account system of its own: who may enter is the host's `access` configuration.
Every request must pass an authentication check that you configure, and the plugin refuses to start without one; then only a person whose principal holds the owner role gets in.

## What the console shows

The console has five optional panes; the original three remain the default.
The `panes` option chooses which ones a host serves.

| Pane | What it shows |
|---|---|
| Overview | Every active agent with its model, thinking level, state (working where, waiting, or idle), context use, schedule count, and last activity; every group with its members, host, and busy count. An agent links to its Discord channel and its transcript, and a group to its Discord channel. |
| Conversations | Every conversation stored on disk, in four sections: owner channels (direct messages and channels where the owner talks to the assistant), agent channels, group conversations (each member's conversation inside a group), and outside-agent conversations opened over MCP. Each row shows the channel's name (when the host has a Discord connection), when it was last active, its size, and how many archives it has. An outside-agent conversation shows its first message, when it appears in the first 256 KB of the file, and when it began. A conversation the host's registry records also shows whose it is, by their display name, and whether it is private to them or shared. Every owner sees every conversation. |
| Notes | A principal's memory in three tabs, core, notes, and events, with search: the signed-in owner's own by default, and any principal's the host knows through a picker that appears when there is more than one. The owner can add a note, edit its text, kind, and date, and delete it after a confirmation, in whichever memory is shown. The memory addon's own validation applies, so a refusal shows its reason and saves nothing. |
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

- Bun 1.4.4 or later, and pi-roundtable `>=0.14.0 <0.15.0` as a peer dependency.
- The host must run on the machine that holds its data directory: the console reads `<dataDir>/sessions` from disk.
- The `memory` addon for the Notes pane (it is on by default; switch the pane off with `panes` when you run without memory).
- A way to authenticate the owners: a password, Cloudflare Access or a verifier of your own in front of the listener, or `none` on a listener only the owner reaches (see [Authentication](#authentication)).
- Each person who uses the console is an owner in the host's `access` configuration, with the identity the verifier reports for them among their `identities` or linked to them with `roundtable principal link`.
  This holds on a host with a single owner too: the console refuses an identity linked to no one.
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
			dataDir: "./data",
		}),
	],
} satisfies RoundtableConfig;
```

The owner signs in with the identity `cloudflareAccess` reports for them, so add it to their entry in `access.owners`, next to their Discord identity: see [Cloudflare Access](#cloudflare-access) for how to find it.

The plugin adds the route `/console` (a redirect to `/console/`) and `/console/…` to the `public` listener, and a line with the console's address to the dashboard message.

## Options

| Option | Default | What it does |
|---|---|---|
| `auth` | none, `auth` or `verifier` required | How requests are authenticated: `{ mode: "none" }`, `{ mode: "password" }` or `{ mode: "verifier", verifier }`; see [Authentication](#authentication). |
| `verifier` | none | Shorthand for `auth: { mode: "verifier", verifier }`: decides whether a request comes from someone your proxy authenticated, and reports who. `cloudflareAccess(...)` is built in; pass your own function to use another proxy. Giving both `auth` and `verifier` throws. |
| `origin` | none, required | The console's own origin as the browser sees it, such as `https://console.example.com`: scheme and host (and port), no path. Requests that change data must carry it as their `Origin`, and the dashboard line links to it. |
| `ownerId` | the primary owner | Deprecated. The owner's principal id that a request from a verifier reporting no actor stands for. The Notes pane no longer needs it: it shows each owner their own notes. |
| `dataDir` | `./data` | The host's data directory; the console reads `<dataDir>/sessions`. Set it to the `dataDir` of your configuration. |
| `mountPath` | `/console` | The path the console is served under: one or more segments of letters, digits, `.`, `_`, `~`, and `-`. |
| `listener` | `public` | The id of the listener whose address serves the console. |
| `panes` | `rooms`, `overview`, `schedules`, `conversations`, `notes` | Ordered subset of those panes plus `skills` and `connectors`. `rooms` is the owner app (see [App protocol](#app-protocol)); `schedules` needs it. Disabled panes answer 404. Skills/connectors require their feature ports at setup. An explicit list is kept as written. |
| `surface` | `app` | The key prefix of the app's rooms, a lower-case word that is not `discord`. |
| `cardGraceSeconds` | `120` | How long a turn waits on an approval or question card before it goes on without the answer; the card stays open. |
| `uploadMaxBytes` | `104857600` (100 MiB) | The most bytes of one file a person may upload in the app, and the most the agent takes from the app. See [Uploads](#uploads). |
| `routing` | `hash` | `path` retains links such as `/console/skills`, with history navigation and an authenticated page fallback. |
| `features` | none | Trusted host integrations, or a factory receiving public plugin setup context; see below. |
| `presentation` | English | `{ locale, messages }`: locale controls dates and document language; English source strings are dictionary keys for labels, descriptions, confirmations, and API errors. |
| `appearance` | `{ look: "modern" }` | `{ look }`: `modern` or `camelot`. The page's default look (also the manifest's splash colours); the owner can switch it in the app. |
| `title` | `Roundtable` | The page's heading and title. |
| `relayNotes` | the remote MCP note | Text that an outside agent's relayed message begins with, taken off before the owner's words are shown. Set it to the same value as the `relayNote` of [pi-roundtable-mcp][mcp] when you changed that one. |
| `exclude` | none | A function from a channel key to `true` for conversations the console must neither list nor read, such as the channels of another plugin that keeps its own sessions in the same directory. |

The options are checked when the plugin is created, so a bad setting stops the host at startup: no `auth` or `verifier`, both of them, an `origin` with a path, a `mountPath` of `/` or with `..` in it, an unknown or repeated pane, or an empty `ownerId`.

The console also needs the agent server for the Overview and Rooms panes, the modes service for Rooms, the schedule store for Schedules, and the memory addon for the Notes pane.
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
| `skills` | `catalog()` supplies public `SkillView[]`; `read(name)` reads only that catalog entry and returns `{ frontmatter, body }`. The host bounds disk reads and the API shows what `read` returns, flattening metadata in source order. A skill that cannot be read answers with a fixed message; set `errorDetail: true` to append the catalog's `missing` text or the read error's message (cut at 300 characters) when the host's reasons are safe to show. |
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

The console never makes an account.
One authenticator checks every request under its path before anything is read, whether it is a page, the API or the event stream, and the WebSocket upgrade of the owner app uses the same one.
You choose how with the `auth` option; the console then looks the person up in the host's `IDENTITY`, reading only, and admits them only when their principal holds the owner role.

| `auth` | Who is the owner | Use it when |
|---|---|---|
| `{ mode: "verifier", verifier }`, or the `verifier` option as shorthand | The person the verifier reports, linked to an owner's principal. | A proxy such as Cloudflare Access authenticates people in front of the listener. This is the one mode whose proof an agent on the host cannot forge. |
| `{ mode: "password" }` | The primary owner, once they give the password. | The console is reachable from the internet with no proxy that signs people in. |
| `{ mode: "none" }` | The primary owner, whoever reaches the listener. | Only the owner can reach the listener: a unix socket, or loopback TCP. |

Giving both `auth` and `verifier` throws, and so does giving neither: the plugin never starts without a way to authenticate.
Whatever the mode, a request that changes data must carry the console's own `Origin`.
It answers `403 Forbidden` with no detail when the verifier refuses, throws, or rejects, when the lookup fails, and when the person is no owner.

### Password

```ts
webConsole({
	auth: { mode: "password" }, // reads ROUNDTABLE_WEB_PASSWORD
	origin: "https://console.example.com",
	dataDir: "./data",
});
```

| Setting | Default | What it does |
|---|---|---|
| `passwordEnv` | `ROUNDTABLE_WEB_PASSWORD` | The environment variable that holds the password. It must be set and at least 12 characters, or the host stops at startup, naming the variable and never the value. |
| `sessionDays` | `30` | How long a login lasts, from 1 to 365 days. |
| `principal` | the primary owner | The owner's principal id the session speaks for. |

`<mount>/login` is a server-rendered form that needs no script.
A wrong password answers `401` after one second.
Ten wrong passwords in 15 minutes, counted for all visitors together, make every login answer `429` with `Retry-After` until the window passes, the right password included: behind a proxy the client's address is not trustworthy, so the limit is global.
The right one sets the cookie `rt_session`: signed, `HttpOnly`, `SameSite=Strict`, `Secure` when `origin` is https, and `Path=<mount>/`, and answers `303` to the console.
`POST <mount>/auth/logout` clears it.
Without a session a page navigation answers `303` to the login page and the API answers `401`; only `login`, `auth/login` and `auth/logout` are public.
The login and logout `POST`s need the console's own `Origin`.

The cookie is signed with a key derived from `<dataDir>/web/session.key` (32 random bytes, mode `0600`, made at the first start) and from a hash of the password, so changing the password signs everyone out, and the key file alone signs nothing a host with another password accepts.
A key file of the wrong size stops startup.

### None

```ts
webConsole({
	auth: { mode: "none" }, // the listener must be a unix socket, or TCP on 127.0.0.1, ::1 or localhost
	origin: "https://console.example.com",
});
```

`none` must be written out: it is never the default.
It reads the listener's address from the host (`context.listener`) and refuses to start for TCP on any other hostname, or with no hostname, which binds every interface, unless `trustNetwork: true` says a network in front of it keeps everyone else out.
A unix socket passes, with a warning when its mode lets other users write to it.
The console warns at every start that whoever reaches the listener is the owner.
It speaks for `principal` (default the primary owner) through the plugin identity `token:web-console`, which the plugin declares itself, so no `access.owners` entry is needed.

Read [Threat model](#threat-model) before choosing `none` or `password` on a host whose agents run a shell.

### Verifier

A verifier is a function that receives the `Request` and returns `{ admitted: true, actor, expiresAt? }` or `{ admitted: false, reason }`.
`actor` describes the person as an identity, `{ provider, subject, name }`, written `<provider>:<subject>` in `access.owners[].identities` and by `roundtable principal link`.
The reason goes to the host's log and is never sent to the client, so keep secrets out of it.
`expiresAt` says when the proxy's assertion lapses; `cloudflareAccess` fills it from the token's `exp`, and a connection that outlives requests, such as the owner app's WebSocket, ends then.
`admitAs(actor, expiresAt?)` and `refuse(reason)` build the two answers.

The console decides who the request comes from by what the verifier reported:

| The verifier reports | The console |
|---|---|
| An identity linked to an owner's principal | Admits them as that owner. |
| An identity linked to anyone else, such as a member, or to a disabled principal | Refuses. |
| An identity linked to no one, however many owners the host has | Refuses, and warns once with the full identity, the line to add to its owner's `access.owners[].identities`, and the `roundtable principal link <owner> <identity>` command that links it instead. |
| No actor (`admit()`, a verifier written for 0.8) | Admits the request as the primary owner, the first of `access.owners`, or as `ownerId` when set, and warns once. |

The console never resolves an identity the way a chat surface does: a visitor is never admitted as a new principal and never claims a 0.8 one.
It refuses an identity of the `legacy` provider too, as resolving refuses it: that is the alias 0.9 keeps for a 0.8 id, not anyone's sign-in.
A verifier may vouch for members as well as owners, through a proxy that lets the whole company in or an allowlist that grows, so the console never guesses whose an identity is: only a link says so.

### Upgrading from 0.8

The core [Migrating to 0.9](../../docs/migration-0.9.md) guide covers backfill, rollback, and the principal isolation boundary.
This console remains an owner administration surface, not a principal-private view: every admitted owner can inspect every conversation and principal's notes.

In 0.8 the console took everyone the verifier admitted as the owner.
It now admits a person only when the identity the verifier reports is linked to an owner, so link yours before you upgrade, or the console answers 403 after it:

1. Find your Access user id, the token's `sub`: sign in once after the upgrade, and copy the identity from the warning in the host's log, which gives it whole.
2. Add `cloudflareAccessIdentity(teamDomain, sub)` to your entry in `access.owners[].identities`, or run `roundtable principal link <your principal id> <identity>` on the host.

A verifier of your own that still answers `admit()` without an actor keeps working as before: its requests are the primary owner's, with a warning.

### Cloudflare Access

`cloudflareAccess(options)` is the built-in verifier.
Cloudflare Access sits in front of your tunnel or proxy, signs in the owner, and adds a signed token to each request it forwards as the `Cf-Access-Jwt-Assertion` header.
The verifier admits a request only when the token is signed by your team's published keys, was issued by your team, is addressed to this application, names a user, and carries an email you allow (compared without regard to case).
It reports the user as an OpenID identity of the team's issuer: `oidc:<base64url of https://<teamDomain>>:<sub>`, where `sub` is the user's Access id in the token, with their email as the name.
It checks the token on every request and fetches the team's signing keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, caching them and following their rotation.
If the keys cannot be fetched and none are cached, requests are refused.

| Option | What it is |
|---|---|
| `teamDomain` | Your Access team domain, `<team-name>.cloudflareaccess.com`, with no scheme or path. |
| `audience` | The Application Audience (AUD) tag of the Access application that protects the console. |
| `email` | The email, or a list of emails, that may use the console. The console still admits only those whose identity is an owner's. |

To set it up:

1. Route a hostname to the host's listener, for example with a Cloudflare Tunnel whose public hostname (`console.example.com`) points at the listener's port or unix socket.
   Use a hostname you do not share with anything that must stay open.
2. In the Cloudflare dashboard, open Zero Trust, then Access controls, then Applications, and add a **Self-hosted** application for that hostname.
   Add the path `console` to the application's public hostname to protect only the console, or leave the path empty to protect the whole hostname.
3. Give the application one **Allow** policy that includes only the owners' emails.
   Do not add a Bypass or an Everyone policy.
4. Open the application's configuration, and under Additional settings copy the **Application Audience (AUD) Tag**.
   Keep it in an environment variable and pass it as `audience`.
5. Take your team name from Zero Trust settings, the `<team-name>` of `<team-name>.cloudflareaccess.com`, and pass the full domain as `teamDomain`.
6. Set the plugin's `origin` to the address you opened in step 1, `https://console.example.com`.
7. Add each owner's identity to their entry in `access.owners`.
   Build it with `cloudflareAccessIdentity(teamDomain, sub)` from the user id shown in Zero Trust, or sign in once: the console refuses you and the host's log names the identity it saw (`oidc:…:<sub>`) with the line to add.
   Until you do, the console refuses that owner, on a single-owner host as well.

A request to the console from a browser that has not signed in is sent by Access to its login page and never reaches the host.
The host still refuses any request that arrives without a valid token, so a listener that becomes reachable without Access, through a wrong route or a second tunnel, does not open the console.

### A verifier of your own

Behind another authenticating proxy, write the verifier for what that proxy sends.
This one trusts a header that a reverse proxy sets after it has authenticated the person, which is safe only when the proxy removes the header from client requests and the listener cannot be reached except through the proxy, for example on a unix socket (`http.socketPath`) that only the proxy's user can open.
It reports the person as the identity `proxy:<email>`, which `access.owners[].identities` then lists for each owner:

```ts
import { admitAs, refuse, webConsole } from "pi-roundtable-web";

export const web = webConsole({
	verifier: (request) => {
		const email = request.headers.get("x-authenticated-email")?.toLowerCase();
		return email
			? admitAs({ provider: "proxy", subject: email, name: email })
			: refuse("no authenticated email");
	},
	origin: "https://console.example.com",
});
```

A verifier can also verify a signed token itself, with `jose` or any other library, which does not depend on the network path and is the stronger choice when the proxy can sign what it sends.
It may be asynchronous; a thrown error or a rejected promise counts as a refusal.

## Threat model

**What the console protects.**
The conversations hold everything the host's people said to the assistant and what the assistant answered, including tool calls and their results, and the memory notes shape every later turn.
The console serves that to the host's owners and nobody else.
Every owner sees every conversation and can read and change every principal's notes; it has no per-user views for members, and no audit trail beyond the host's log, which records only that a request was refused and why.

**Authentication is the `auth` mode; authorization is the owner role.**
Who holds the owner role is the host's `access` configuration or the `roundtable principal` CLI, never something the authentication reports, so one that admits a member admits no one.
With a verifier the console sets no cookie and keeps no session.
The built-in Cloudflare Access verifier checks a signature, so a client that can reach the listener directly still cannot forge a token.
A custom verifier that trusts a plain header is exactly as strong as the guarantee that clients cannot set that header: use a unix socket or a firewall rule so that only the proxy reaches the listener, and have the proxy strip the header from inbound requests.
With a verifier the console does not rate-limit failed requests; do that at the proxy.

**`none` trusts the listener, and `password` trusts the host's own user.**
The agents' shell runs as the service user and inherits the host's environment, so anything that user can reach, a prompt-injected agent can reach too: the environment variable that holds the password, `<dataDir>/web/session.key` and the listener's socket.
With `none`, an agent on the host can call the console as the owner with `curl --unix-socket`, approve its own held actions, and change modes: `Origin` is only a header to `curl`, and `curl` is not held.
With `password`, an agent can read the password and the session key and sign in.
Both resist the network, and neither resists a compromised agent on the host.
Only a verifier does, because an agent cannot forge a signed token it has no key for.
Choose `none` for a host whose agents have no shell, or whose listener a different user owns, and keep Cloudflare Access (or another signing proxy) for one whose agents run commands; the startup warning of `none` says so.
Password mode adds a login that cannot be brute-forced from the network (a one-second wait per failure, a global limit of ten in 15 minutes, a constant-time comparison, a 12-character minimum), a cookie a script on the page cannot read and another site cannot send (`HttpOnly`, `SameSite=Strict`, `Secure` over https), a logout, and a key that changes with the password.
The limit is global, so someone who guesses wrongly on purpose can keep the owner from signing in for 15 minutes; that is the price of not trusting a client's address.

**Cross-site requests.**
A request that changes data (`POST`, `PATCH`, `DELETE`) is refused unless its `Origin` header is exactly the configured `origin`, after the authentication has admitted it.
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
It never repeats the request URL, a header, or a token, and a refusal answers `403 Forbidden` with that single word (`401 Unauthorized` for a request without a password session).
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
Transport security (terminate TLS at the proxy), protecting the data directory on disk, and what members see are not the console's job.
The console is for the owners of one host; members talk to the host through its chat surfaces.

## App protocol

The `rooms` pane is the owner app: the same agent team as on Discord, in rooms of its own (`<surface>:agent.<name>`, `<surface>:group.<name>`, surface `app` by default; Home is the coordinator's room). A page opens one WebSocket at `<mount>/api/socket` with the subprotocol `roundtable.app.v1`. The upgrade passes the same authenticator as every request and must come from the console's own origin; the socket closes with `4401` when the credential lapses.

- Page to server: `hello {visible, focus?}`, `visibility`, `focus {room?}`, `send {id, room, text, uploads?}`, `stop {room}`, `approval {prompt, approved}`, `answer {prompt, answer}`, `answers {prompt, answers, note?}`, `cancel {prompt}`.
- Server to page: `ready {protocol, principal, name, uploads: {perMessage, maxBytes}}` (then every open card), `accepted`, `refused {id?, prompt?, code}` (`id` names a refused `send`, `prompt` a refused answer to a card), `message`, `progress` (only for the focused room), `activity {room, typing, stoppable, phase?, agent?, outcome?}` (`phase` is `working` during a tool call and `thinking` otherwise; `agent` names the member speaking in a group round; `outcome` is `done` or `failed` and comes only on the frame where `typing` turns false), `presence {agents: {<name>: {busy}}}` (after `ready` and when it changes; `busy` includes work in Discord channels), `edited` (a stored message changed its text, such as a thread's start line once the thread exists), `prompt`, `prompt_closed`, `mode`, `auto_approved`, `changed`.
- REST under `<mount>/api/`: `session`, `rooms`, `rooms/<key>/messages?before=&limit=`, `PUT rooms/<key>/mode`, `POST rooms/<key>/start-over`, `POST uploads`, `DELETE uploads/<id>`, `files/<id>`, `schedules`, `agents/<name>`, `PUT agents/<name>/character` (body `{character}`, at most 4 KiB; `400 {error, field}` for a look that is not a character), `models`; the agents' pictures are at `<mount>/avatars/<hash>.png`.

A room key from a page must be one of the app's rooms whose agent or group exists; every other key, Discord's included, is refused. Every write needs an owner, whose tier is read again, and REST writes also need the console's `Origin`. A card can be answered by any owner, except a card that is the speaker's alone, which only the speaker's principal answers. After `cardGraceSeconds` (default 120) a turn goes on without the answer and the card stays open for a day; an answer then starts a new turn in the room. The types are in `src/api-types.ts`.

### Characters in the page

Every agent is drawn as its composed character (`pi-roundtable/characters`). The page draws it from the spec the server sends, after a strict `parseCharacter` check: a spec that does not parse is logged and replaced by the look the agent's name suggests. The drawing is `composeSvg`'s output, the only markup the page injects, and it holds no inline style, so the content security policy is unchanged. The composer is a chunk of its own (about 19 KB gzipped) that starts loading with the page and is cached by the service worker.

- **Where.** The room list, the room's header and the agent's profile show the character live, the room list only while its agent is not idle; messages, the room switcher and a group's stack of up to three members stand still. The owner has no picture.
- **State.** `thinking`, `working`, `waiting` (a card is open), `done`, `error` and `sleepy` come from the `activity`, `presence` and prompt frames; `working` elsewhere (Discord, another room) counts, `done` lasts 2.5 s, a failed turn stays `error` until the next turn or the room is opened (at most ten minutes), and an agent quiet for eight hours, or between 01:00 and 06:00 local time with nothing in the last hour, is `sleepy`. Under `prefers-reduced-motion` the characters stand still and the state shows as a badge.
- **Accent.** The character's primary color, shaded to be readable in the scheme, is `--agent-accent` on the room's row, header, progress strip and composer.
- **Creator.** The profile's "Look" section edits a draft of the character: the 24 classes, eight palettes and custom primary, secondary and trim colors, and strips for hat, outfit, prop, hair, beard, accessory, build, skin and hair color, each drawn on the current look. "Suggest from role" and "Randomize" fill the draft, Save sends `PUT api/agents/<name>/character` and shows a refused field under its strip, and leaving with unsaved changes asks first. Every label is a message key, `character.class.<id>`, `character.<kind>.<id>` and `character.palette.<name>`, with the English name as the default.
- **Look.** `ConfigView.look` (the `appearance.look` option) goes on the page as `data-look` on `<html>`; Settings picks Modern or Camelot per device (`localStorage` `rt-look`), and the characters take the shield frame under Camelot.

### The Camelot look

`appearance.look: "camelot"` (or a device's own pick in Settings) dresses the page's details and leaves its skeleton alone. It is CSS and a few small elements: no image, no web font, and nothing new for the content security policy.

- **Colors.** Parchment (`#f4ead5`, surfaces `#fbf5e6`) by day and a night castle (`#0f1726`, surfaces `#16213a`) by night, with gold and a bronze accent that reads on parchment. Every text color meets 4.5:1 and every accent and control edge 3:1 on the surfaces it sits on; an agent's accent is shaded for Camelot's own surfaces (`accentOf(spec, "camelot-light")`). The scheme still follows the system or the person's pick.
- **Type.** Headings use the system serif stack (`Iowan Old Style`, Palatino, `Songti TC`, `Noto Serif TC`, Georgia); nothing is fetched.
- **Details.** Gold rules under page titles and the room header, with corner marks on the header; the shield frame on every character; a wax seal in the agent's accent that is stamped on an approval card when it is approved and stays on the closed card; and a candle and a row of runes on the progress strip, the candle flickering and the runes shimmering while the turn works. Each moves with `transform` or `opacity` only and stands still under `prefers-reduced-motion`.
- **Toolbar color.** The `theme-color` tags follow the look and the scheme: parchment or night castle under Camelot, the plain page's colors under Modern. The pre-paint script (`theme-init.js`) also puts `data-look` on the page, so a Camelot host never flashes the Modern look first.


### Dispatch threads

The app hosts the core's dispatch threads (`ChatSurface.threads`). A background dispatch started from a room (a coding task, a delegated task, `message_agent` between agents) puts one start line in that room and opens a thread, `<surface>:thread.<uuid>`, whose room holds the dispatch's progress and report. The start line links the thread, and the room list nests each thread under the room that started it, with the finished ones folded away. Only an agent's or group's room can host a thread, never a thread itself.

A thread's room is read only: a `send` to it is refused with `read_only`, and it has no modes. Its cards are the dispatch's own, such as a coding job's approvals, and any owner answers them there as in any room. Agents post in it under their own names. A closed thread stays readable (the list keeps the 30 newest closed ones), and the host closes the threads a restart left open, with a restart notice. `GET api/rooms` lists a thread with `parent` and, once closed, `closed: true`; opening and closing one sends `changed`.

### Uploads

An owner may send a file of any kind in a room, up to four to a message: the button, a paste (a copied image, say) or a drop. `POST <mount>/api/uploads` takes one file as `multipart/form-data` (field `file`) and answers `{id, name, type, size}`; the message then names it in `uploads`. A long text goes as a file too: the page turns a paste of 4,000 characters or more into a `pasted-text-<n>.txt` chip, and a message over 32,000 characters into `message.txt` with the line "(long text attached)"; the server still refuses a text over 32,000 characters.

- **Streamed, not buffered.** The body is read as a stream and written to disk as it arrives, so a large file costs disk, not memory. Only the first bytes are kept to tell what the file is. A file over `uploadMaxBytes` is refused with `413` (before it is read when the length says so, as it passes the limit otherwise), and nothing is left on disk.
- **Any type.** Images are checked by their first bytes (a file that says it is a PNG but is not one is refused with `415`); a file that is valid UTF-8 without NUL bytes is kept as text (`text/markdown`, `text/csv` or `application/json` by its name, else `text/plain`); a PDF by its first bytes keeps `application/pdf`; everything else is kept as `application/octet-stream` under the name it came with. What the browser said the type was (often empty, or `video/mp2t` for a `.ts` file) does not decide.
- **Bounded.** A person may have 16 files and 400 MiB waiting for a message, counting uploads on their way (`429` beyond that); a waiting file is deleted after a day, a sent one after 30. The page deletes a chip's upload when it is removed or its send fails (`DELETE <mount>/api/uploads/<id>`, the owner's own waiting uploads only), and a body that is cut short leaves no file behind.
- **Served safely.** A stored file is a download, never a page (`content-disposition: attachment`, `content-security-policy: sandbox`, `nosniff`); only the four image types are shown inline.
- **What the agent gets.** The turn's message names each file, and the host saves it for the agent's tools: the app hands the host the stored file's path, so a large file is copied from disk, never held in memory. The agent takes a file up to `uploadMaxBytes` (the surface's `maxAttachmentBytes`), not the 25 MiB a Discord attachment is held to. Images (four at most) are also shown to the model, and a text or PDF file can be read by the agent. A file over 25 MiB is kept as a file for tools: it is not shown to the model and `read_attachment` refuses it, and the turn's attachment list marks it "too large for read_attachment; kept as a file for tools", which a tool that takes files opens as it is.
- **Limits in front of the app.** The upload route asks the host's listener for a request body of `uploadMaxBytes` plus 64 KiB of form framing, so a larger `uploadMaxBytes` raises the listener's limit past its 128 MiB default (a listener the host fixed with its own `maxRequestBodyBytes` decides instead, and refuses a larger body with `413`). A reverse proxy has its own limit; Cloudflare's free plan caps request bodies at 100 MB, so a larger file needs a paid plan or an upload path that skips the proxy.

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
The fixture host has two owners, so the Notes pane shows its principal picker.

The page is React, bundled with Bun's bundler into relative URLs, so it works under any `mountPath`.
Pages use URL fragments by default (`#/notes`, `#/conversations/<key>`); `routing: "path"` uses mount-relative page paths instead.

The package shares the core's version and single `v*` release tag.
The shared `publish.yml` checks every workspace, then publishes each separately with provenance; this package's `prepack` builds the page.

[roundtable]: https://www.npmjs.com/package/pi-roundtable
[mcp]: https://www.npmjs.com/package/pi-roundtable-mcp
