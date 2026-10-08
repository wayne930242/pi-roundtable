# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Personal background turns and delegated reports run privately as the router-checked principal, with replies pushed only to that principal's connections; the claim rejects other targets, principals, and unregistered or shared conversations.
- A private inbox provider with offline `knows`, durable `webchat_notices` storage, additive `notice` frames, `GET <path>/notices` pagination, and idempotent `POST <path>/notices/<id>/read`. Inbox entries never become fake transcript turns.

### Changed

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
