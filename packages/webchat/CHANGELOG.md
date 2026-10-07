# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

- First release. `webChat(options)` adds a WebSocket chat to a host's HTTP listener for people an OpenID Connect provider signs in: a `web:` chat surface, the claim that runs each message as a turn of its conversation's persona through `context.turns`, and a REST API (`POST tickets`, `GET`/`POST conversations`, `GET conversations/<id>/messages`) under one path. Every conversation is private to the person who opened it: the claim checks the host's conversation registry inside the conversation's queue before each turn.
- Protocol version 1 (`roundtable.webchat.v1`): client frames `send`, `stop`, `approval`, `answer`, and `auth`; server frames `ready`, `accepted`, `typing`, `stoppable`, `progress`, `reply`, `failed`, `prompt`, `prompt_closed`, `reauth`, and `error`; close codes 4401 and 4403. A browser connects with a one-time ticket in the `ticket.<ticket>` subprotocol, another client with a bearer header; the token is never read from a URL.
- `oidcJwtVerifier(options)`: JWKS fetched and cached, `iss`, `aud`, `exp`, `nbf` with clock skew, an asymmetric algorithm allowlist, configurable subject, name, and roles claims, and a further `check`. Speaker ids are `oidc:<base64url(issuer)>:<subject>` (`oidcSpeakerId`, `parseOidcSpeakerId`).
- `webAccess(map)`: tiers from the token's roles or speaker ids; owners only by speaker id; a person with no tier is not admitted.
- Secure defaults: `origins` required, connections per person and per route, frame size and rate limits, prompts that only the conversation's person answers at the tier the call needs.
