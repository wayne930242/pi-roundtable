# pi-roundtable-webchat

A WebSocket chat adapter for [pi-roundtable][roundtable].
People an OpenID Connect provider signs in chat with the assistant from a web page or a browser extension, each in private conversations of their own.
A turn's text and tools show as it runs, and a held tool call asks the person on an approval card.
Source lives in [`packages/webchat`][source] in the pi-roundtable repository and releases in lockstep with the core.

[roundtable]: https://www.npmjs.com/package/pi-roundtable
[source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/webchat

The plugin adds three things to a host:

- a chat surface whose conversations have keys `web:<conversation>`;
- the claim that runs each message as a turn of its conversation's persona, through `context.turns` and the host's runtime;
- a REST API and a WebSocket under one path of the host's HTTP listener.

It needs no Discord: a host whose `roundtable.config.ts` has no `discord` key and lists this plugin is a web-only assistant.
`roundtable init --adapter web` creates such a project.

## Requirements

- Bun 1.3 or later, and pi-roundtable `>=0.7.0 <0.8.0` as a peer dependency.
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
	owner: { id: "operator", name: "Ada" },
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
			access: {
				admins: { roles: ["Helpdesk.Admin"] },
				members: { roles: ["Helpdesk.User"] },
			},
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
| `access` | Who may chat, and at which tier: a `WebAccessMap`, or `webAccess(map)`. |
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
`selection` (`{ tools, groups }`) names the tools its turns get; without it a turn gets the plugins' `agentSelection`.
The kinds `owner` and `agent` belong to the host and are refused.

### Access

A `WebAccessMap` is `{ owners?, admins?, members? }`.
`admins` and `members` name people by `users` (speaker ids), by `roles` (the names in the token's roles claim), or `everyone` the verifier accepts; the highest tier a person qualifies for wins.
`owners` is a list of speaker ids only: no claim a provider issues can make anyone the owner.
A person the map gives no tier is not admitted: no ticket, no socket, no conversation, no turn.
A map that admits no one throws.

### `oidcJwtVerifier`

| Option | What it sets |
|---|---|
| `jwksUrl` | The provider's signing keys (`jwks_uri`): https, or http on a loopback address. Fetched when first needed, cached for `cacheMaxAgeMs` (10 minutes), and fetched again for a key id it lacks at most every `refetchCooldownMs` (30 seconds). |
| `issuers` | The accepted `iss` values. |
| `audiences` | The accepted `aud` values. |
| `speakerIssuer` | The issuer speaker ids are made from; required when `issuers` lists several issuers of one provider, so one person keeps one id. |
| `subjectClaim` | The claim naming the person; default `sub`. A provider's stable object id claim may suit better. |
| `nameClaim` | The claim to show them by; default `name`, then `preferred_username`, then the subject. |
| `rolesClaim` | The claim holding their roles or groups, an array of strings; default `roles`. |
| `algorithms` | Accepted signature algorithms; default `RS256` and `ES256`. Symmetric algorithms and `none` are refused. |
| `clockSkewSeconds` | How far `exp` and `nbf` may be off the local clock; default 60. |
| `check` | A further check on the verified claims, such as a tenant claim; `false` refuses the token. |

It checks the signature, `iss`, `aud`, `exp` (required), and `nbf`, then the subject claim and `check`.
A refused token throws `TokenRefused`, whose `reason` goes to the host's log and never to the client.
The speaker id of a person is `oidc:<base64url(issuer)>:<subject>`: `oidcSpeakerId(issuer, subject)` makes it, and `parseOidcSpeakerId(id)` turns it back into the pair.
Use it to name owners in the access map.

## Connecting

The token is never read from a URL.

- **A browser** asks for a one-time ticket with `POST <path>/tickets` and `Authorization: Bearer <token>`, then opens `<path>/socket` offering two subprotocols: `roundtable.webchat.v1` and `ticket.<ticket>`.
  A ticket is spent by the first upgrade, lasts 30 seconds, and never outlives its token.
- **Another client**, such as a service, sends `Authorization: Bearer <token>` on the upgrade and offers `roundtable.webchat.v1`.

The server echoes `roundtable.webchat.v1`.
An upgrade from an origin not in `origins`, or without one, is refused with 403; without a valid ticket or token with 401; for a person the access map does not admit with 403; past the person's connection limit with 429.

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
| `{ type: "ready", protocol, speaker, personas, expiresAt }` | Sent first, and again after a fresh token: who you are (`{ id, name, tier }`), the personas you may open (`{ kind, label }`), and when the token expires. Open prompts follow it. |
| `{ type: "accepted", id, conversation }` | Your message `id` was taken into `conversation`, a new one when you named none. |
| `{ type: "typing", conversation, on }` | The assistant is, or is no longer, working in the conversation. |
| `{ type: "stoppable", conversation, on }` | A stop applies, or no longer applies. |
| `{ type: "progress", conversation, event }` | What the running turn writes and which tools it runs: `{ type: "text", delta }`, `{ type: "tool_start", id, tool, preview? }`, or `{ type: "tool_end", id, tool, ok }`. Never the thinking, never a tool's full arguments. |
| `{ type: "reply", conversation, text, thinking?, files? }` | The turn's answer in full markdown, with its files inline as `{ name, data }` (base64). |
| `{ type: "failed", conversation, stopped }` | The turn ended without an answer: it failed, or it was stopped. The cause stays in the host's log. |
| `{ type: "prompt", conversation, prompt }` | The turn asks you: `{ id, kind: "approval", title, message }`, or `{ id, kind: "ask", title, question, options, multi, allowOther }`. |
| `{ type: "prompt_closed", conversation, prompt, outcome }` | The prompt closed: `approved`, `declined`, `answered`, `expired`, or `cancelled` (the turn stopped). |
| `{ type: "reauth", expiresAt }` | Your token expires soon: send `auth` with a fresh one. |
| `{ type: "error", code, ref? }` | A frame was refused. `ref` is the `send` id or prompt id it was about. |

Error codes: `bad_frame` (it does not parse, its text is blank or too long, or an answer the question does not allow), `unknown_conversation`, `forbidden` (someone else's conversation or prompt, or an approval above your tier), `unknown_persona` (none of that kind you may open), `unknown_prompt`, and `too_many_conversations`.

Close codes: `4401` when the token expired without a fresh `auth`, or a fresh one was refused; `4403` when the person is no longer admitted, or a fresh token names someone else.
The host's own limits close with `1008` (too many frames), `1009` (a frame too big), and `1006` (a client that stopped reading).

## REST API

Every call sends `Authorization: Bearer <token>`; a missing or refused token gets 401 with `WWW-Authenticate: Bearer`, and a person the access map does not admit 403.
A request from a browser origin not in `origins` gets 403; an allowed origin gets CORS headers and its preflight is answered.

| Call | Answer |
|---|---|
| `POST <path>/tickets` | 201 `{ ticket, expiresAt }`. |
| `GET <path>/conversations` | `{ conversations: [{ conversation, persona, title?, createdAt, lastActiveAt }] }`: your own, the most recently active first. |
| `POST <path>/conversations` with `{ persona, title? }` | 201 `{ conversation, persona }`: a new conversation to write in. |
| `GET <path>/conversations/<conversation>/messages?limit=50` | `{ messages: [{ role, text }] }`: its last messages, at most 500. Someone else's conversation is 403. |

## Security model

- **Private conversations.** A conversation belongs to the person who opened it.
  The host's conversation registry records its person at its first turn, and the claim checks that record inside the conversation's queue before every turn; only that person may list it, read it, write in it, stop it, or answer its prompts.
  Conversation ids are random UUIDs, and the claim runs only messages this plugin accepted from a verified socket.
- **Tokens.** Tokens are checked on every REST call, every upgrade, and every `auth` frame, and never read from a URL.
  A socket is closed when its token expires.
- **Origins.** `origins` is required and checked on every upgrade and every browser request, so another site cannot open a socket or call the API with a browser's credentials.
- **Limits.** Each person holds at most `connectionsPerPrincipal` sockets, and the route at most `maxConnections`; frames are limited in size and rate.
- **Approvals.** A held call's card goes to the conversation's person only, and needs the tier the call needs.
  A card whose tier the person lacks is never shown, so the call stays held.
- **Owner.** Nobody becomes the owner through a token's claims; list owners by speaker id.
  Owner-tier tools stay out of web turns unless an owner is chatting.

## Limits

| Limit | Default |
|---|---|
| `connectionsPerPrincipal` | 5 sockets per person |
| `unusedConversationsPerPrincipal` | 20 conversations opened but not written in |
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
- Schedules and delegated reports: the claim takes no background turns, so a schedule or a report aimed at a web conversation is skipped. Leave the `schedule_*` and `delegate_task` tools out of a web persona's `selection`.
- Agent teams: the web chat has no agent rooms.
- A person signed in on two providers, or on Discord and the web, has two speaker ids, and so two memories, until principals arrive in pi-roundtable 0.9.

## Testing

`pi-roundtable/testing`'s `describeSurfaceContract` runs the chat surface contract on this surface in this package's tests, and the end-to-end test runs a host with a self-made JWKS and a scripted model.
