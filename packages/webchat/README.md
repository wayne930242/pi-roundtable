# pi-roundtable-webchat

A WebSocket chat adapter for [pi-roundtable][roundtable].
People an OpenID Connect provider signs in chat with the assistant from a web page or a browser extension, each in private conversations of their own.
A turn's text and tools show as it runs, and a held tool call asks the person on an approval card.
Source lives in [`packages/webchat`][source] in the pi-roundtable repository and releases in lockstep with the core.

[roundtable]: https://www.npmjs.com/package/pi-roundtable
[source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/webchat

The plugin adds four things to a host:

- a chat surface whose conversations have keys `web:<conversation>`;
- the claim that runs each message as a turn of its conversation's persona, through `context.turns` and the host's runtime;
- a REST API and a WebSocket under one path of the host's HTTP listener;
- a durable private inbox for `notify`, with live `notice` frames and an authenticated REST inbox.

It needs no Discord: a host whose `roundtable.config.ts` has no `discord` key and lists this plugin is a web-only assistant.
`roundtable init --adapter web` creates such a project.

## Requirements

- Bun 1.3 or later, and pi-roundtable `>=0.8.0 <0.9.0` as a peer dependency.
- An HTTP listener on the host (`http` in the configuration), behind a reverse proxy that serves it over HTTPS.
- An OpenID Connect provider that issues access tokens for this API, with signing keys published as a JWKS.

## Install

```sh
bun add pi-roundtable-webchat
```

```ts
import { readFileSync } from "node:fs";
import type { RoundtableConfig } from "pi-roundtable";
import { oidcJwtVerifier, webChat } from "pi-roundtable-webchat";

export default {
	access: {
		owners: [{ principal: "operator", name: "Ada" }],
		admins: { roles: ["web:role:Helpdesk.Admin"] },
		members: { roles: ["web:role:Helpdesk.User"] },
	},
	database: { url: process.env.DATABASE_URL ?? "" },
	dataDir: "./data",
	model: "anthropic/claude-sonnet-5-5",
	http: { port: 3000, hostname: "127.0.0.1" },
	plugins: [
		webChat({
			verifier: oidcJwtVerifier({
				jwksUrl: "https://login.example.com/keys",
				issuers: ["https://login.example.com/"],
				audiences: ["api://helpdesk"],
			}),
			origins: ["https://chat.example.com"],
			personas: [
				{
					kind: "helpdesk",
					label: "Helpdesk",
					prompt: () => readFileSync("./persona/helpdesk.md", "utf8"),
				},
			],
		}),
	],
} satisfies RoundtableConfig;
```

Every mistake in these options throws when the configuration loads, so `roundtable doctor` names it before the host starts.

## Options

| Option | What it sets |
|---|---|
| `verifier` | Checks each bearer token and names the person: `oidcJwtVerifier({ ... })`, or your own `TokenVerifier`. |
| `personas` | The conversation kinds a person may open (`WebPersona`). |
| `origins` | Required. The browser origins allowed to open the socket and call the API, each exactly `scheme://host[:port]`, such as `https://chat.example.com` or `chrome-extension://<id>`. `"any"` admits every origin, for clients that are not browsers; never use it where a browser holds the token. |
| `listener` | The configured listener the route attaches to; default `public`, the one `http` names. |
| `path` | Where the API and the socket live; default `/chat`. |
| `surface` | The key prefix of the conversations; default `web`. Two web chats on one host need two prefixes, and two paths. |
| `limits` | Overrides of the limits below. |

### Personas

A `WebPersona` is `{ kind, label?, prompt?, minTier?, selection? }`.
`prompt()` is the system prompt of its conversations, contributed by this plugin; leave it out when another plugin contributes the persona of that kind.
`minTier` (default `member`) is the lowest tier that may see and open it; a person whose tier falls below it later can no longer write in its conversations.
`selection` (`{ tools, groups }`) names the tools its turns get; without it a turn gets the plugins' `agentSelection`, which grows with every plugin you add, so name the tools.
Schedules and delegated reports can run in the person's private web conversation, even after reconnect or restart.
Include their tools in `selection` only where intended: scheduling and delegation default to admin tier, and `notify` defaults to owner tier; top-level `toolTiers` can lower them deliberately.
Leave out `web_search` and `fetch_content` unless people may make the server fetch any address, internal ones included: they are member-tier tools, and a plugin that loads pi-web-access adds them to `agentSelection`.
The kinds `owner` and `agent` belong to the host and are refused.

### Access

Use the host's top-level `access`, not a `webChat` option.
The removed `webChat({ access })` option fails at configuration load with migration guidance; `WebAccessMap` and `webAccess` are removed too.
Token roles become `web:role:<role>` (or `<surface>:role:<role>` for a custom surface), and identities are written as `oidcSpeakerId(issuer, subject)`.
Replace old `users` rules with `identities`, and old web owners with `access.owners: [{ name, principal?, identities: [oidcSpeakerId(...)] }]`.
Replace the old webchat `everyone: true` with `everyone: ["<surface>"]`, substituting this chat's configured surface (default `"web"`).
Core `everyone: true` opens every surface, including Discord, rather than only people this web verifier accepts.
No IdP role can create an owner.
A person the core policy gives no tier is not admitted: no ticket, no socket, no conversation, no turn.

Each successful contact resolves through `IDENTITY`.
An admitted new person gets an opaque `p_` principal; existing M1 users claim their backfilled OIDC principal and keep their private conversations without rewriting them.
Ownership, limits, tickets, approvals and connection groups use `principalId`, not the external actor id.
Link another identity with `roundtable principal link <principal> <identity>` to share memory across Discord and web; the CLI reports the host's cache delay.
A fresh token may name another linked actor of the same principal, but a changed principal closes the socket with 4403.

### `oidcJwtVerifier`

| Option | What it sets |
|---|---|
| `jwksUrl` | The provider's signing keys (`jwks_uri`): https, or http on a loopback address. Fetched when first needed, cached for `cacheMaxAgeMs` (10 minutes), and fetched again for a key id it lacks at most every `refetchCooldownMs` (30 seconds). |
| `issuers` | The accepted `iss` values. |
| `audiences` | The accepted `aud` values. |
| `speakerIssuer` | The issuer speaker ids are made from; required when `issuers` lists several issuers of one provider, so one person keeps one id. |
| `subjectClaim` | The claim naming the person; default `sub`. Use a claim that stays the same across your app registrations, such as Entra's `oid`; see [provider settings](#provider-settings). |
| `nameClaim` | The claim to show them by; default `name`, then `preferred_username`, then the subject. |
| `rolesClaim` | The claim holding their roles or groups, an array of strings; default `roles`. |
| `algorithms` | Accepted signature algorithms; default `RS256` and `ES256`. Symmetric algorithms and `none` are refused. |
| `clockSkewSeconds` | How far `exp` and `nbf` may be off the local clock; default 60. |
| `check` | A further check on the verified claims, such as a tenant claim; `false` refuses the token. |
| `requireScopeOrRoles` | Refuse a token without a scope (`scp` or `scope`) or app roles (`roles`), the marks of an access token; default `true`, so an ID token cannot pass for an access token. Set `false` only for a provider whose access tokens carry neither. |
| `rejectAppOnly` | Refuse an app-only token, which names a service rather than a person (`idtyp: "app"`); default `true`. |

It checks the signature, `iss`, `aud`, `exp` (required), and `nbf`, then a scope or roles and no app-only token, then the subject claim and `check`.
A refused token throws `TokenRefused`, whose `reason` goes to the host's log and never to the client.
The speaker id of a person is `oidc:<base64url(issuer)>:<subject>`: `oidcSpeakerId(issuer, subject)` makes it, and `parseOidcSpeakerId(id)` turns it back into the pair.
Use it in the host's `access.owners[].identities` or with `roundtable principal link`.
The verifier also reports `ActorFacts` with the canonical OIDC provider, subject, name, prefixed roles and legacy id.
A custom verifier may supply `WebIdentity.actor` only with a provider beginning `oidc:` or equal to this chat's configured surface; `token`, `discord`, or another surface's provider is refused with `TokenRefused` before core identity resolution.
Otherwise the chat derives these facts from its id.

### Provider settings

The verifier is generic; what makes it safe is how you point it at your provider.
Microsoft Entra ID is the example below, and the same questions apply to any provider.

- **Name people by a claim that is stable across app registrations.** Many providers make `sub` pairwise: it differs for each application, so a web page and a browser extension registered as two apps would give one person two speaker ids, and two memories. Entra's `oid` is the same for a person in every app of the tenant: set `subjectClaim: "oid"`.
- **Pin the tenant in `check`.** An object id is unique only within its tenant, and a multi-tenant app takes tokens from every tenant. With Entra, check `claims.tid` against your tenant id.
- **Accept access tokens only.** `requireScopeOrRoles` refuses a token with no scope or app roles, as an ID token is. An Entra ID token may still carry `roles` when you assign app roles, so also require the delegated scope in `check` (`typeof claims.scp === "string"`); where you can, register the API apart from the web page's sign-in app, so a page's ID token never has the API's audience.
- **Refuse app-only tokens.** `rejectAppOnly` refuses `idtyp: "app"`. Entra writes `idtyp` only when the app asks for that optional claim; requiring `scp` refuses app-only tokens either way, since they carry roles and no scope.
- **Merge issuers of one tenant only.** `speakerIssuer` makes one person's id the same whichever listed issuer signed the token, such as Entra's v1 `https://sts.windows.net/<tenant>/` and v2 `https://login.microsoftonline.com/<tenant>/v2.0`. Never list issuers of different tenants or providers together: their subjects are separate namespaces, and two people could get one id.
- **Mind who `everyone` admits.** `everyone: ["<surface>"]` admits every person the verifier accepts on that surface, guest accounts of your tenant included; core `everyone: true` also admits people on every other surface. Prefer roles assigned to the users and groups who should chat; with Entra, the optional `acct` claim (`0` for a member of the tenant, `1` for a guest) lets `check` refuse guests.

```ts
const tenant = process.env.ENTRA_TENANT_ID ?? "";
const verifier = oidcJwtVerifier({
	jwksUrl: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
	issuers: [`https://login.microsoftonline.com/${tenant}/v2.0`],
	audiences: [process.env.ENTRA_API_CLIENT_ID ?? ""],
	subjectClaim: "oid",
	check: (claims) => claims.tid === tenant && typeof claims.scp === "string",
});
```

## Connecting

The token is never read from a URL.

- **A browser** asks for a one-time ticket with `POST <path>/tickets` and `Authorization: Bearer <token>`, then opens `<path>/socket` offering two subprotocols: `roundtable.webchat.v1` and `ticket.<ticket>`.
  A ticket is spent by the first upgrade, lasts 30 seconds, and never outlives its token.
  A person holds at most `connectionsPerPrincipal` unspent tickets; asking for one more drops their own oldest, never anyone else's.
- **Another client**, such as a service, sends `Authorization: Bearer <token>` on the upgrade and offers `roundtable.webchat.v1`.

The server echoes `roundtable.webchat.v1`.
An upgrade from an origin not in `origins`, or without one, is refused with 403; without a valid ticket or token with 401; for a person the core policy does not admit with 403; past the person's connection limit with 429.

```js
const { ticket } = await (
	await fetch("/chat/tickets", { method: "POST", headers: { authorization: `Bearer ${token}` } })
).json();
const socket = new WebSocket("wss://chat.example.com/chat/socket", [
	"roundtable.webchat.v1",
	`ticket.${ticket}`,
]);
socket.onmessage = (event) => console.log(JSON.parse(event.data));
socket.onopen = () =>
	socket.send(JSON.stringify({ type: "send", id: "1", persona: "helpdesk", text: "Hello" }));
```

## Protocol, version 1

Each WebSocket message is one JSON object with a `type`.
`WEBCHAT_PROTOCOL` and `WEBCHAT_PROTOCOL_VERSION` name the version; an incompatible change gets a new subprotocol name.
The TypeScript types are `ClientFrame` and `ServerFrame`.

### Client frames

| Frame | Meaning |
|---|---|
| `{ type: "send", id, persona, text }` | Opens a new conversation of `persona` with this message. `id` is your reference, echoed by `accepted` or `error`. |
| `{ type: "send", id, conversation, text }` | A message in one of your conversations. |
| `{ type: "stop", conversation }` | Stops the conversation's running turn. |
| `{ type: "approval", prompt, approved }` | Approves or declines an approval prompt. |
| `{ type: "answer", prompt, choices, text? }` | Answers a question prompt: the chosen options' labels, and your own text where the question allows it. |
| `{ type: "auth", token }` | A fresh token for the same person, sent after `reauth`. |

### Server frames

| Frame | Meaning |
|---|---|
| `{ type: "ready", protocol, speaker, personas, expiresAt }` | Sent first, and again after a fresh token: who you are (`{ id, name, tier, principalId }`), the personas you may open (`{ kind, label }`), and when the token expires. Open prompts follow it. |
| `{ type: "accepted", id, conversation }` | Your message `id` was taken into `conversation`, a new one when you named none. |
| `{ type: "typing", conversation, on }` | The assistant is, or is no longer, working in the conversation. |
| `{ type: "stoppable", conversation, on }` | A stop applies, or no longer applies. |
| `{ type: "progress", conversation, event }` | What the running turn writes and which tools it runs: `{ type: "text", delta }`, `{ type: "tool_start", id, tool, preview? }`, or `{ type: "tool_end", id, tool, ok }`. Never the thinking, never a tool's full arguments. |
| `{ type: "reply", conversation, text, thinking?, files? }` | The turn's answer in full markdown, with its files inline as `{ name, data }` (base64). |
| `{ type: "failed", conversation, stopped }` | The turn ended without an answer: it failed, the host refused it before it ran (for example when its conversation could not be recorded), or it was stopped. The cause stays in the host's log. |
| `{ type: "prompt", conversation, prompt }` | The turn asks you: `{ id, kind: "approval", title, message }`, or `{ id, kind: "ask", title, question, options, multi, allowOther }`. |
| `{ type: "prompt_closed", conversation, prompt, outcome }` | The prompt closed: `approved`, `declined`, `answered`, `expired`, or `cancelled` (the turn stopped). |
| `{ type: "notice", notice: { id, text, createdAt, readAt } }` | A durable private inbox entry; `readAt` is `null` until read. Fetch the REST inbox to recover entries missed while offline. |
| `{ type: "reauth", expiresAt }` | Your token expires soon: send `auth` with a fresh one. |
| `{ type: "error", code, ref? }` | A frame was refused. `ref` is the `send` id or prompt id it was about. |

Error codes: `bad_frame` (it does not parse, its text is blank or too long, or an answer the question does not allow), `unknown_conversation`, `forbidden` (someone else's conversation or prompt, or an approval above your tier), `unknown_persona` (none of that kind you may open), `unknown_prompt`, `too_many_conversations` (you hold `unusedConversationsPerPrincipal` conversations you have not written in, or opened `newConversationsPerHour` in the last hour), and `busy` (you have `turnsPerPrincipal` turns running or queued, or the conversation already has a turn queued behind its running one; the message was not taken, so send it again once a turn ends).

Close codes: `4401` when the token expired without a fresh `auth`, or a fresh one was refused; `4403` when the person is no longer admitted, or a fresh token names someone else.
The host's own limits close with `1008` (too many frames), `1009` (a frame too big), and `1006` (a client that stopped reading).

## REST API

Every call sends `Authorization: Bearer <token>`; a missing or refused token gets 401 with `WWW-Authenticate: Bearer`, and a person the core policy does not admit 403.
A request from a browser origin not in `origins` gets 403; an allowed origin gets CORS headers and its preflight is answered.

| Call | Answer |
|---|---|
| `POST <path>/tickets` | 201 `{ ticket, expiresAt }`. |
| `GET <path>/conversations` | `{ conversations: [{ conversation, persona, title?, createdAt, lastActiveAt }] }`: your own, the most recently active first. |
| `POST <path>/conversations` with `{ persona, title? }` | 201 `{ conversation, persona }`: a new conversation to write in. 429 `too_many_conversations` past either conversation limit. |
| `GET <path>/conversations/<conversation>/messages?limit=50` | `{ messages: [{ role, text }] }`: its last messages, at most 500. Someone else's conversation is 403. |
| `GET <path>/notices?limit=50&before=<id>` | `{ notices: [{ id, text, createdAt, readAt }] }`: only your principal's entries on this surface, newest first, at most 100. Omit `before` for the first page; use its last id to fetch the next. |
| `POST <path>/notices/<id>/read` | `{ notice }` with `readAt` set. Idempotent; unknown ids or another principal's notice return 404. |

Inbox text is truncated with `…` to at most 4096 UTF-16 units, or `messageChars` if smaller.
The cap is reduced further for a small `maxBufferedBytes`, reserving 256 bytes for the notice frame and allowing six JSON bytes per text unit; configurations below 262 bytes are refused.
Each principal retains only its newest 100 notices per surface, pruning oldest entries atomically with each insert (including concurrent deliveries).
List, read acknowledgements, pagination cursors and retention are isolated by surface as well as principal.
Offline inbox discovery requires a private conversation on this surface or a linked identity whose provider equals this surface; a generic `oidc:` link alone does not establish membership in every webchat inbox.
A REST notice page therefore contains at most 100 bounded entries, less than 2.5 MiB at the default text cap.

## Security model

- **Private conversations.** A conversation belongs to the person who opened it.
  The host's conversation registry records its principal before runtime use, including transcript reads, and the claim checks that record inside the conversation's queue before every turn; only that person may list it, read it, write in it, stop it, or answer its prompts.
  Conversation ids are random UUIDs, and the claim runs only messages this plugin accepted from a verified socket.
  The owner can still read every conversation through the owner console, pi-roundtable-web, and the operator through the database and the data directory.
- **Tokens.** Tokens are checked on every REST call, every upgrade, and every `auth` frame, and never read from a URL.
  By default only a person's access token passes: one without a scope or app roles, or an app-only one, is refused.
  A socket is closed when its token expires.
  Every valid client frame rechecks the stored verified facts against core identity: revoked admission or a changed principal closes with 4403, and approvals use the current tier, subject to the core's identity-cache delay.
- **Origins.** `origins` is required and checked on every upgrade and every browser request, so another site cannot open a socket or call the API with a browser's credentials.
- **Limits.** Each person holds at most `connectionsPerPrincipal` sockets, and the route at most `maxConnections`; frames are limited in size and rate.
  Each person has at most `turnsPerPrincipal` interactive turns running or queued at once, however many conversations or sockets they use, and a conversation at most its running interactive turn and one queued behind it; a browser message over either limit is refused with `busy` and never queued.
  Personal schedules and delegated reports use the core runtime's conversation queue separately from this interactive admission budget, so a busy browser cannot discard them; runtime stop and shutdown still apply.
  Each person opens at most `newConversationsPerHour` conversations an hour, over the socket or the REST API alike.
- **Approvals.** A held call's card goes to the conversation's person only, and needs the tier the call needs.
  A card whose tier the person lacks is never shown, so the call stays held.
- **Owner.** Nobody becomes the owner through a token's claims; grant owner in core configuration or the principal CLI.
  Owner-tier tools stay out of web turns unless an owner is chatting.

## Limits

| Limit | Default |
|---|---|
| `connectionsPerPrincipal` | 5 sockets per person |
| `unusedConversationsPerPrincipal` | 20 conversations opened but not written in |
| `newConversationsPerHour` | 60 conversations opened per person in any hour |
| `turnsPerPrincipal` | 2 turns running or queued per person, across conversations; a conversation holds its running turn and one queued |
| `messageChars` | 32 000 characters per message |
| `promptTimeoutMs` | 30 minutes before a prompt expires |
| `reauthLeadMs` | `reauth` 60 seconds before the token expires |
| `maxConnections` | 256 sockets on the route |
| `maxMessageBytes` | 64 KiB per client frame |
| `rate` | 60 frames a minute per socket |
| `maxBufferedBytes` | 4 MiB waiting for a slow client |
| `ticketTtlMs` | 30 seconds |

## What it does not do yet

- Attachments: messages carry text only.
- System error reports into a person's web conversation: the background claim accepts only `PERSONAL_TARGET` turns checked by core, whose author principal is the private conversation's principal.
  A system report cannot enter someone else's private conversation; configure ops reports on another surface.
- Agent teams: the web chat has no agent rooms.

## Testing

`pi-roundtable/testing`'s `describeSurfaceContract` runs the chat surface contract on this surface in this package's tests, and the end-to-end test runs a host with a self-made JWKS and a scripted model.
