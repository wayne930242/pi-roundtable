# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.22.0] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.0. The core peer range moves to `>=0.22.0 <0.23.0`.

## [0.21.0] - 2026-10-20

- Release in lockstep with pi-roundtable 0.21.0. The core peer range moves to `>=0.21.0 <0.22.0`. The web chat honours `ApprovalOptions.speakerOnly` without further change: it shows prompts to the conversation's person only, and no owner is on it.

## [0.20.0] - 2026-10-18

### Added

- Questionnaires: `ready.prompts` advertises them, a client that sees it may send `prompt_features`, and a `questionnaire` prompt is sent only to connections that declared support covering it. The client answers with a new `answers` frame (`bad_frame` for a malformed or non-fitting answer, `forbidden` from another person). The protocol name and `ready.protocol` stay v1, so old clients and old servers keep working; a person whose tabs have not declared is asked one question at a time. A questionnaire that no open connection can show (the declaring tab closed or narrowed its declaration, or none was connected) waits 60 seconds for one to declare, then expires so the model is told it went unanswered and a re-ask uses the one-question fallback. The public `ClientFrame`, `ServerFrame` and `PromptFrame` types gain `answers`, `prompt_features`, `kind: "questionnaire"` and `ready.prompts`, so a TypeScript client that switches exhaustively on `kind` needs a new case. This needs `pi-roundtable` 0.20.

### Changed

- An `answer` is checked by the core's shared `checkAnswer`; its behaviour is unchanged.

## [0.19.2] - 2026-10-18

- Release in lockstep with pi-roundtable 0.19.2. The core peer range stays `>=0.19.0 <0.20.0`.

## [0.19.1] - 2026-10-18

- Release in lockstep with pi-roundtable 0.19.1. The core peer range stays `>=0.19.0 <0.20.0`.

## [0.19.0] - 2026-10-17

- Release in lockstep with pi-roundtable 0.19.0. The core peer range moves to `>=0.19.0 <0.20.0`.

## [0.18.0] - 2026-10-17

- Release in lockstep with pi-roundtable 0.18.0. The core peer range moves to `>=0.18.0 <0.19.0`.

## [0.17.3] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.3; no package-specific behavior changes. The core peer range stays `>=0.17.0 <0.18.0`.

## [0.17.2] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.2; no package-specific behavior changes. The core peer range stays `>=0.17.0 <0.18.0`.

## [0.17.1] - 2026-10-16

- Release in lockstep with pi-roundtable 0.17.1; no package-specific behavior changes. The core peer range stays `>=0.17.0 <0.18.0`.

## [0.17.0] - 2026-10-16

### Added

- `entraV2Check({ tenant, scope, guests? })` (and the type `EntraV2CheckOptions`): the `check` of `oidcJwtVerifier` for Microsoft Entra ID v2 access tokens of one tenant. It requires `tid` to be the tenant, `ver` to be `"2.0"`, `scp` to list the scope, and `acct` to be `0` or `"0"` (a member); `guests: true` also admits `1` or `"1"`. A token without `acct` is refused either way.
- The subpath `pi-roundtable-webchat/testing` with `testIssuer` (and the types `TestIssuer`, `TokenSpec`): a self-made OpenID provider on a local port, for tests of a host that verifies tokens. The package now ships `src/testing`; test files stay out.
- Release in lockstep with pi-roundtable 0.17.0. The core peer range moves to `>=0.17.0 <0.18.0`.

## [0.16.0] - 2026-10-16

- Release in lockstep with pi-roundtable 0.16.0; no package-specific behavior changes. The core peer range moves to `>=0.16.0 <0.17.0`.

## [0.15.4] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.4; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.3] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.3; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.2] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.2; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.1] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.1; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.0] - 2026-10-14

Release in lockstep with pi-roundtable 0.15.0. The core peer range moves to `>=0.15.0 <0.16.0`.

### Changed

- The approval prompt's `message` is the card text the core builds, and for a tool whose parameter schema is known it is now a list of labelled fields in markdown (`**label**: value`, long and multi-line values in fenced blocks) instead of one JSON block; a client that read the JSON out of `message` should read `approval.input`, which is unchanged and whole. A tool without a schema keeps the JSON block.
- `PromptOutcome` gains `withdrawn`: a client that switches over the outcomes must handle it (close the prompt as for `cancelled`).

### Added

- `prompt_closed` may carry the outcome `withdrawn` (new in `PromptOutcome`) and a `note`: the plugin that asked for an approval took it back (`ApprovalOptions.supersede`), and `note` is its reason, when it gave one as a text. The prompt is removed from the open ones a reconnect resends, and an answer to it finds `unknown_prompt`. A client that does not know the outcome should close the prompt as it does for `cancelled`. The turn reads a withdrawn approval as cancelled; the core tells the model it was withdrawn.
- `client_call` may carry `approval: { prompt }` (`ClientCallOptions.approval` in the core): the id of the approval prompt the tool's call acts on, written into the frame unchanged when the tool passes one and absent otherwise. The server accepts a text of 1 to 128 characters and fails the call otherwise.

## [0.14.1] - 2026-10-14

- Release in lockstep with pi-roundtable 0.14.1; no package-specific behavior changes. The core peer range stays `>=0.14.0 <0.15.0`.

## [0.14.0] - 2026-10-14

- Release in lockstep with pi-roundtable 0.14.0; no package-specific behavior changes. The core peer range moves to `>=0.14.0 <0.15.0`.

## [0.13.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.13.0; no package-specific behavior changes. The core peer range moves to `>=0.13.0 <0.14.0`.

## [0.12.1] - 2026-10-13

- Release in lockstep with pi-roundtable 0.12.1; no package-specific behavior changes. The core peer range stays `>=0.12.0 <0.13.0`.

## [0.12.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.12.0; no package-specific behavior changes. The core peer range moves to `>=0.12.0 <0.13.0`.

## [0.11.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.11.0; no package-specific behavior changes. The core peer range moves to `>=0.11.0 <0.12.0`.

## [0.10.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.10.0; no package-specific behavior changes. The core peer range moves to `>=0.10.0 <0.11.0`.

## [0.9.13] - 2026-10-13

- Release in lockstep with pi-roundtable 0.9.13; no package-specific behavior changes.

## [0.9.12] - 2026-10-11

- Release in lockstep with pi-roundtable 0.9.12; no package-specific behavior changes.

## [0.9.11] - 2026-10-11

### Added

- Client calls: a connection may declare functions it can run for the assistant's tools, and a tool asks it through `turn.client` (`ClientPort`, new in pi-roundtable 0.9.11; this package needs pi-roundtable 0.9.11 with it, because its source imports types that release adds, so upgrade the two together; on an older core at run time the field is ignored and tools see no client). The client sends `client_hello` (`{ version: 1, tools }`); a call becomes `client_call` (`{ conversation, call, name, args, timeoutMs }`) on the one connection the turn's message arrived on, never the person's others, and is answered with `client_result` (`{ call, ok, value, parts? }` or `{ call, ok: false, code, message? }`) from that same connection; `client_cancel` (`turn_stopped`, `timeout` or `turn_ended`) tells the client to stop. A connection that never sends `client_hello` is unaffected: its turns carry no client.
- `PUT <path>/conversations/<id>/client-calls/<call>/parts/<n>`: the binary parts of an answer, such as a screenshot, are uploaded over REST before the answer names them, since a frame stays at 64 KiB. Only `image/jpeg`, `image/png` and `image/webp` are accepted, with their bytes checked against the type.
- `ready.clientCalls` (`{ timeoutMs, maxTimeoutMs, maxValueBytes, maxParts, maxPartBytes }`) advertises what a call may take; a server before this omits it. The error code `unknown_call` answers a `client_result` for a call not open on that connection.
- `limits.clientCalls`: `timeoutMs` (default 30 seconds), `maxTimeoutMs` (60 seconds), `maxValueBytes` (48 KiB), `maxParts` (2), `maxPartBytes` (2 MiB) and `perMinute` (60 calls a minute per connection; the configuration is refused when it reaches the `rate` frame rate, since each answer is a frame). `ClientCallLimits` types it. One call is open on a connection at a time; a closed connection ends its call as `disconnected`, with no second chance after a reconnect.

### Changed

- The default `rate.messages` is 120 frames a minute per socket, up from 60, since a client's answers count with the person's own frames. `maxMessageBytes` stays 64 KiB.
- The REST preflight also allows `PUT`.

## [0.9.10] - 2026-10-10

### Added

- A turn run for a message carries the `Origin` header its connection's upgrade was accepted with, as `origin` on `context.turns.run`, so a tool reads it as `ToolTurn.origin`. It is trimmed and lower-cased and kept only when it is a serialized `scheme://host[:port]` of at most 256 characters; a connection that sent none, or an `Origin` of another shape, leaves it undefined. It is read from the transport at the upgrade, never from a frame or the message text. Needs pi-roundtable 0.9.10 or later to reach tools; on an older core the extra field is ignored.

## [0.9.9] - 2026-10-10

### Added

- A privacy note in the README for the core's `attachments.retention`: a host can have the files messages used removed after a period, which also gives the person's `usedAttachmentBytesPerPrincipal` allowance back. The plugin needs no setting of its own for it. `memoryAttachments` (the test double) implements the port's new optional `expireUsed`.

## [0.9.8] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.8; no package-specific behavior changes.

## [0.9.7] - 2026-10-10

### Added

- An approval `prompt` frame carries an optional `approval: { action, tool, input, files? }`, the held call as data: its whole input (cut only past a size limit, below), and the files it sends by path with their size in bytes. `title` and `message` are unchanged, so a client that ignores `approval` works as before. `PromptFrame` types it with core's `ApprovalDetails`. The serialized `approval` is bounded: over 256 KiB (UTF-8 JSON) each long string value of `input` is cut to its start plus `… [N chars]` (N in code points) and `approval.truncated` is `true`; `files` are then left out, and an input that still cannot fit is sent as `{}`.
- A `progress` frame's `tool_end` event carries an optional `refused: "declined" | "expired" | "pending" | "held"` when a hold refused the call, so a client can tell that from a failed tool without guessing from the order of frames; it is absent for a success and for a real failure.

### Changed

- A card that cannot be shown to the person (an approval above their tier) now resolves `unavailable` instead of `expired`, so a held call reports `refused: "held"`; a card that was shown and timed out is still `expired`. No frame is sent for the first.

## [0.9.6] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.6; no package-specific behavior changes.

## [0.9.5] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.5; no package-specific behavior changes. 0.9.4 was tagged but never published.

## [0.9.3] - 2026-10-10

### Fixed

- Uploads that arrive together can no longer pass `unsentUploadBytesPerPrincipal`: the room an upload may fill is reserved per person before its body is read (its declared `Content-Length`, or the room left when none is declared), so ten slow uploads against a 64 MiB allowance take at most 64 MiB, and their request buffers are bounded by it. A body longer than its declared length is cut off and refused (413).
- A file name loses line and paragraph separators and bidi controls too (they become underscores), and a request `Content-Type` that is not a plain `type/subtype` is refused (415) even under a `/*` entry of `attachmentTypes`, so neither can add to the model's prompt.
- Long non-ASCII file names no longer fail on Linux (see pi-roundtable 0.9.3).

### Added

- The limit `usedAttachmentBytesPerPrincipal` (1 GiB): what one person's messages may keep across all their conversations. A `send` that would pass it is refused whole with the error code `attachment_quota` (REST 429), and its files stay waiting. Deleting a conversation through the core gives its bytes back. It is enforced by the core of pi-roundtable 0.9.3; with 0.9.2 the limit is ignored.

## [0.9.2] - 2026-10-10

### Added

- File attachments. A person uploads a file to one of their conversations with `POST <path>/conversations/<id>/files?name=<file name>` (the body is the file, its `Content-Type` the type; answers 201 `{ file, name, contentType, size }`), then names it in a `send` frame's new `attachments` field. The turn runs with the files as the core's attachments: images reach the model, every file is listed under `## Attachments`, and `read_attachment` and a tool's `turn.attachment()` read them. An rrweb recording is an ordinary `application/json` file.
- `ready` carries `attachments: { maxBytes, perMessage, types }`, so a client shows an upload control only when the server takes files; the subprotocol stays `roundtable.webchat.v1`, and a client that sends no `attachments` sees no change.
- The error code `unknown_attachment` (a `send` named a file that is not waiting for the person in that conversation; the whole message is refused) and the REST errors `payload_too_large` (413), `unsupported_media_type` (415) and `too_many_uploads` (429).
- The limits `attachmentBytes` (10 MiB, at most the core's 25 MiB), `attachmentsPerMessage` (8), `uploadsPerHour` (60), `unsentUploadBytesPerPrincipal` (64 MiB), `attachmentTypes` (PNG, JPEG, WebP, GIF, JSON, plain text, PDF; an entry may end in `/*`) and `unsentUploadTtlMs` (24 hours). The first bytes of an image or PDF must match its type. An upload no message used is deleted after its time; a swept file, a file of another conversation or person, or a file a message already used is `unknown_attachment`.
- Nothing needs configuring. The plugin needs `context.attachments` from pi-roundtable 0.9.2 and refuses to set up without it, and a host that has no `dataDir` fails at startup with a message naming it.

### Fixed

- The README named `>=0.8.0 <0.9.0` as the peer range of pi-roundtable; it is `>=0.9.0 <0.10.0`.

## [0.9.1] - 2026-10-10

- Release in lockstep with pi-roundtable 0.9.1; no package-specific behavior changes.

## [0.9.0] - 2026-10-09

### Added

- Personal background turns and delegated reports run privately as the router-checked principal, with replies pushed only to that principal's connections; the claim rejects other targets, principals, and unregistered or shared conversations.
- A private inbox provider with offline `knows`, durable `webchat_notices` storage, additive `notice` frames, `GET <path>/notices` pagination, and idempotent `POST <path>/notices/<id>/read`. Inbox entries never become fake transcript turns.

### Changed

- The private conversation claim declares `takesSystemReports: false`.
  Configuring `ops.conversation` on the webchat surface now fails at startup with core `ConfigError`, even though personal background turns are supported; use a shared conversation on another surface or `ops.agent` for system error reports.

- Webchat resolves core `IDENTITY` at every token admission. Ownership, quotas, tickets, prompts and connection groups use `principalId`; `ready.speaker` adds it without changing `roundtable.webchat.v1`. A token switching principal closes with 4403, while linked identities of one principal can renew the same connection. Client frames recheck core admission and tier, so revoked admission or a relinked actor cannot keep acting on an old socket, and approvals do not use stale roles. Existing M1 conversations keep their OIDC principal ids unchanged.
- Removed the plugin's `access` option and `WebAccessMap` / `webAccess` exports. Configure the host's top-level `access` with surface-prefixed roles and linked identities instead; passing the removed option fails with migration guidance. OIDC verification also reports `ActorFacts` for the core resolver.

- A message the router drops after its claim admitted it (pi-roundtable 0.9's `Admission.dropped`, when the author's record finds them someone else) frees its place in the person's turn budget, as a message the claim drops does, and its person, told it was accepted, gets a `failed` frame for its conversation (`stopped: false`), as for a turn the host refused.
- The surface's `prompts` take the core's `PromptScope` (pi-roundtable 0.9): a prompt goes to the scope's principal, by `principalId`, when the conversation is theirs, and an approval above their `tier` expires at once without being shown, whatever the scope escalates to, since the owners are not on the web chat. Who answers is unchanged: the conversation's person only, at the tier the call needs.

## [0.8.0] - 2026-10-07

- First release. `webChat(options)` adds a WebSocket chat to a host's HTTP listener for people an OpenID Connect provider signs in: a `web:` chat surface, the claim that runs each message as a turn of its conversation's persona through `context.turns`, and a REST API (`POST tickets`, `GET`/`POST conversations`, `GET conversations/<id>/messages`) under one path. Every conversation is private to the person who opened it: the claim checks the host's conversation registry inside the conversation's queue before each turn.
- Protocol version 1 (`roundtable.webchat.v1`): client frames `send`, `stop`, `approval`, `answer`, and `auth`; server frames `ready`, `accepted`, `typing`, `stoppable`, `progress`, `reply`, `failed` (also when the host refuses a turn before it runs, such as when its conversation cannot be recorded), `prompt`, `prompt_closed`, `reauth`, and `error`; close codes 4401 and 4403. A browser connects with a one-time ticket in the `ticket.<ticket>` subprotocol, another client with a bearer header; the token is never read from a URL.
- `oidcJwtVerifier(options)`: JWKS fetched and cached, `iss`, `aud`, `exp`, `nbf` with clock skew, an asymmetric algorithm allowlist, configurable subject, name, and roles claims, and a further `check`. By default it refuses a token with no scope (`scp` or `scope`) or app roles, so an ID token cannot pass for an access token (`requireScopeOrRoles`), and an app-only token (`idtyp: "app"`, `rejectAppOnly`). The README's provider settings cover a stable subject claim, pinning the tenant, merging issuers of one tenant only, and who `everyone` admits. Speaker ids are `oidc:<base64url(issuer)>:<subject>` (`oidcSpeakerId`, `parseOidcSpeakerId`).
- `webAccess(map)`: tiers from the token's roles or speaker ids; owners only by speaker id; a person with no tier is not admitted.
- Secure defaults: `origins` required, connections per person and per route, frame size and rate limits, prompts that only the conversation's person answers at the tier the call needs.
- Turn and conversation limits per person: `turnsPerPrincipal` (default 2) turns running or queued at once across their conversations, and at most one turn queued behind a conversation's running one; a message over either is refused with the `busy` error and never queued. `newConversationsPerHour` (default 60) bounds the conversations a person opens an hour, over the socket or `POST conversations`, past which they get `too_many_conversations` (429 over REST).
- Tickets per person: a person holds at most `connectionsPerPrincipal` unspent WebSocket tickets, and asking for one more drops their own oldest, so one person cannot push out everyone else's tickets (`TicketBookOptions.perPrincipal`, default 5).
- Configuration checked at load, for JavaScript configurations too: an access map whose `owners`, `users`, or `roles` is not a list of strings, or whose `everyone` is not a boolean, and a persona whose `kind` is not a non-empty string or whose `minTier` is not a tier, throw. A string where a list belongs would have matched its substrings, and an unknown `minTier` would have let every tier open the persona.
