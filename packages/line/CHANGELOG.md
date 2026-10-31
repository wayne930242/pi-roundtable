# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.27.2] - 2026-10-31

- Release in lockstep with pi-roundtable 0.27.2; no package-specific behavior changes. The core peer range stays `>=0.27.0 <0.28.0`.

## [0.27.1] - 2026-10-31

- Release in lockstep with pi-roundtable 0.27.1; no package-specific behavior changes. The core peer range stays `>=0.27.0 <0.28.0`.

## [0.27.0] - 2026-10-31

- Release in lockstep with pi-roundtable 0.27.0; no package-specific behavior changes. The core peer range moves to `>=0.27.0 <0.28.0`.

## [0.26.3] - 2026-10-30

- Release in lockstep with pi-roundtable 0.26.3; no package-specific behavior changes. The core peer range stays `>=0.26.0 <0.27.0`.

## [0.26.2] - 2026-10-30

### Changed

- `ChatSurface.label`: LINE names itself so an agent's prompt says where the conversation is.
- Release in lockstep with pi-roundtable 0.26.2. The core peer range stays `>=0.26.0 <0.27.0`.

## [0.26.1] - 2026-10-30

- Release in lockstep with pi-roundtable 0.26.1; no package-specific behavior changes. The core peer range stays `>=0.26.0 <0.27.0`.

## [0.26.0] - 2026-10-30

The core peer range is now `>=0.26.0 <0.27.0`.

### Added

- `lineProfileSource(api)`: a `ProfileSource` for provider `line` over LINE's `/v2/bot/profile/{userId}`, to register with `PROFILES` from a plugin's `setup`: `services.get(PROFILES).register(lineProfileSource(services.get(LINE).api))`. Its picture hosts are `profile.line-scdn.net` and `obs.line-scdn.net`, and it is not `modelVisible`: a host that lets agents read LINE names lists `line` in `profiles.modelVisible`. Needs pi-roundtable 0.26.

## [0.25.0] - 2026-10-29

- Release in lockstep with pi-roundtable 0.25.0; no package-specific behavior changes. The core peer range is now `>=0.25.0 <0.26.0`.

## [0.24.2] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.2; no package-specific behavior changes. The core peer range stays `>=0.24.0 <0.25.0`.

## [0.24.1] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.1; no package-specific behavior changes. The core peer range stays `>=0.24.0 <0.25.0`.

## [0.24.0] - 2026-10-29

- Release in lockstep with pi-roundtable 0.24.0; no package-specific behavior changes. The core peer range is now `>=0.24.0 <0.25.0`.

## [0.23.2] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.2; no package-specific behavior changes. The core peer range stays `>=0.23.0 <0.24.0`.

## [0.23.1] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.1; no package-specific behavior changes. The core peer range stays `>=0.23.0 <0.24.0`.

## [0.23.0] - 2026-10-29

- Release in lockstep with pi-roundtable 0.23.0; no package-specific behavior changes. The core peer range is now `>=0.23.0 <0.24.0`.

## [0.22.5] - 2026-10-25

- Release in lockstep with pi-roundtable 0.22.5. `engines.bun` is now `>=1.4.4` (was `1.3.0`) so no supported setup runs a Bun with the Brotli decoder bug (CVE-2026-111497). The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.4] - 2026-10-25

- Release in lockstep with pi-roundtable 0.22.4; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.3] - 2026-10-23

- Release in lockstep with pi-roundtable 0.22.3; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.2] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.2; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.1] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.1; no package-specific behavior changes. The core peer range stays `>=0.22.0 <0.23.0`.

## [0.22.0] - 2026-10-21

- Release in lockstep with pi-roundtable 0.22.0. The core peer range moves to `>=0.22.0 <0.23.0`.

## [0.21.0] - 2026-10-20

- Release in lockstep with pi-roundtable 0.21.0. The core peer range moves to `>=0.21.0 <0.22.0`.

## [0.20.0] - 2026-10-18

- Release in lockstep with pi-roundtable 0.20.0. The core peer range moves to `>=0.20.0 <0.21.0`.

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

- The `line` surface tells the model that LINE shows plain text only: its `formatting` text is appended to the system prompt of every turn that replies in a LINE chat, after the persona. `line({ formatting })` replaces it and `false` tells the model nothing. Needs pi-roundtable with `ChatSurface.formatting`.
- `LINE_FORMATTING`: the built-in guidance text, for a host that wants the same words elsewhere, such as in the description of a tool that sends to LINE.
- Release in lockstep with pi-roundtable 0.17.0. The core peer range moves to `>=0.17.0 <0.18.0`.

## [0.16.0] - 2026-10-16

### Added

- `LINE.screen(handler)` and the types `LineScreen` and `LineScreenVerdict`: one screen of the webhook, asked for every event of a request whose signature and destination passed, in order and before anything is stored, that answers `"keep"` or `"consume"`. A consumed event is never stored, routed or handed to the subscriber, and a request whose events are all consumed is a `200` that counts as accepted. A screen that throws or answers anything else fails the request with `500` and stores nothing. The screen is handed a deeply frozen copy of the event, so it cannot change what is stored. A second `screen()` while one is attached throws; until one is attached every event is kept.
- `LINE.api` and the types `LineApiPort`, `LineCallOptions`, `LineProfile`, `LineQuotaStanding` and `LineBotInfo`: LINE's API through the plugin's own token source, timeout and `401` retry. `profile` (a member's or a one-to-one user's display name and picture; undefined for a `404`), `memberCount`, `quota` (the gate's reading with the host's `cap`), `botInfo` (`userId`, `basicId`, name and picture, asked once and kept; callers that ask together share one request and its timeout), `reply` (1 to 5 messages on a reply token), `probeToken` and `onTokenFailure`. Every call takes `{ signal, timeoutMs }`.
- `onTokenFailure(listener)` on `LINE.api`: told the code (`token_refused`, `token_unreachable`, `token_malformed`) of each failed issue of the channel access token, whichever part of the plugin asked, once per issue however many callers shared it. `probeToken()` issues quietly and tells no listener. A listener that throws, or returns a rejecting promise, is ignored.
- `senderNameProblem(name, options?)`, the type `SenderNameProblem` (`empty`, `edge_space`, `too_long`, `control_character`, `forbidden_word`), and the values `SENDER_NAME_MAX` and `SENDER_DEFAULTS`: why LINE would refuse a sender name, for a host that checks a name before it queues a push. `validateSender` uses it and keeps its messages.
- `LineBridgePort.api` and `LineBridgePort.screen`.

### Changed

- `SENDER_DEFAULTS` and its `forbiddenWords` list are frozen, and `senderNameProblem` reads options without a word list as the defaults.
- A sender name with a C1 control character (U+0080 to U+009F) is now refused as `bad_sender`, like C0 and DEL already were.

## [0.15.4] - 2026-10-15

### Added

- `LineOutboxResultEvent.attempts`: how many tries the push took, the one that ended it included (1 for a push LINE refused at once, 2 after a `5xx` and then a refusal), so a subscriber no longer reads `line_outbox`.
- Migration `outbox-requested` adds the nullable `line_outbox.requested_at`, set just before a push's request is made and cleared when the push is claimed again.

### Fixed

- A stop no longer gives back an attempt whose request may have reached LINE. A push interrupted by the worker stopping used to be put back with its attempt uncounted even when the request was already out, so the count (and `outbox.maxAttempts`) understated the tries; it is now given back only when the stop came before the request.

The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.3] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.3; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.2] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.2; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.1] - 2026-10-15

- Release in lockstep with pi-roundtable 0.15.1; no package-specific behavior changes. The core peer range stays `>=0.15.0 <0.16.0`.

## [0.15.0] - 2026-10-14

- Release in lockstep with pi-roundtable 0.15.0; no package-specific behavior changes. The core peer range moves to `>=0.15.0 <0.16.0`.

## [0.14.1] - 2026-10-14

- Release in lockstep with pi-roundtable 0.14.1; no package-specific behavior changes. The core peer range stays `>=0.14.0 <0.15.0`.

## [0.14.0] - 2026-10-14

### Added

- `LINE.health().webhooks.rejected.signatureForBot` counts the requests that failed the signature check and whose body names this bot's user id as its `destination`; they are still counted in `rejected.signature` as well. A scanner does not know the bot's id, so this counter rising while `accepted` stays flat means a wrong channel secret or URL. The body is read only within the existing size limit and is neither logged nor kept; before the plugin knows the bot's id the count stays zero.

### Changed

- `WebhookHealth.rejected` has the new required field `signatureForBot`, so a caller that built a `WebhookHealth` or a `LineBridgePort` of its own must add it.
- Release in lockstep with pi-roundtable 0.14.0. The core peer range moves to `>=0.14.0 <0.15.0`.

## [0.13.0] - 2026-10-13

### Added

- `LINE.health()` gains `webhooks: WebhookHealth` (new type, exported): `{ accepted, rejected: { signature, destination, malformed }, lastAcceptedAt?, lastRejectedAt? }`, the counts and times of what the webhook has answered since the plugin was set up. `signature` is a missing or wrong signature (401), `destination` a signed webhook for another bot (403), `malformed` a body over the cap or not an events object (413, 400). Nothing of a request but its count is kept.

### Changed

- `LineBridgePort.health()` returns the new `webhooks` field, so a caller that built a `LineBridgePort` of its own, to test a plugin that reads `LINE`, must add it.
- Release in lockstep with pi-roundtable 0.13.0. The core peer range moves to `>=0.13.0 <0.14.0`.

## [0.12.1] - 2026-10-13

- Release in lockstep with pi-roundtable 0.12.1; no package-specific behavior changes. The core peer range stays `>=0.12.0 <0.13.0`.

## [0.12.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.12.0; no package-specific behavior changes. The core peer range moves to `>=0.12.0 <0.13.0`.

## [0.11.0] - 2026-10-13

- Release in lockstep with pi-roundtable 0.11.0; no package-specific behavior changes. The core peer range moves to `>=0.11.0 <0.12.0`.

## [0.10.0] - 2026-10-13

### Added

- The consumer. `LINE.subscribe(handler)` takes the one subscriber (a second is refused; the returned function detaches it) and the package's own inbox processor hands it typed events: `message` (text, image, video, audio, file, sticker, location, and `unsupported` for a type it does not know), `edited`, `unsent`, `joined` (`notice` says whether the join notice went out), `left`, `memberJoined`, `memberLeft`, and `outboxResult`. A `message` is answered with `{ refs }` (anything else fails with `bad_refs`), opaque references stored one to many in `line_message_refs` and given back on `edited` and `unsent`; a redelivery of a recorded message is not handed out again and stores nothing twice. The subscriber's third argument has `keep(ref)`, to store the reference of each post as it lands under the same lock and tombstone check as the final store (a ref kept after an unsend is handed back as `unsent` at once and `keep` resolves `{ unsent: true }`); a handler that throws after keeping some refs leaves them stored for the retry and for a later `unsend`.
- Tombstones. An `unsend` writes a tombstone, nulls every inbox payload of the message and deletes its metadata in one transaction under a per-message lock, then hands the refs to the subscriber and forgets them once it returns. A `message` checks the tombstone before it calls the subscriber and again wherever its refs are stored (`keep` or the final store); an unsend that lands meanwhile has the new refs handed straight back. Only a crash between a post and its `keep` can leave a post the package does not know of. Edits arrive out of order and the latest one wins.
- `LINE.content(messageId, { kind, signal })`: message content into memory only, capped by `media.maxBytes` (default 10 MiB) and answered as `{ bytes, contentType }`, `{ tooLarge }` or `{ expired, reason }`; a video or audio waits for `/content/transcoding` for at most `media.transcodingMaxMs` in all, requests included (each request is given what is left of the wait). It uses the content host, reissues the token once on a `401`, stops on the signal, and never fetches a message that was unsent.
- Reply and quote tokens are kept per message in `line_messages` for a later reply mode, never logged or handed to the subscriber, and deleted with the message.
- The `line-retention` service and the `retention` option: inbox events that are done, skipped, dead or never handled, and message metadata, refs and tombstones, are removed after 7 days by default; it logs counts only. A subscriber that stays detached longer than the window loses the unsends and refs that waited for it. New migration `messages` (the released `inbox` migration is untouched).

- The outbox. `LINE.outbox.enqueue(sourceKey, messages, { sender?, origin? })` queues message objects for a chat on the allowlist. `sender` (`{ name, iconUrl }`) is validated before anything is queued: a name of 1 to 20 characters without a forbidden word (`sender.forbiddenWords`, default `LINE` and `LY`, whole words in any case and width, where a change of script between Latin and other letters ends a word; LINE still has the last word), an `https` icon URL of at most 2000 characters. Objects of one chat and sender queued within `outbox.coalesceMs` (2 seconds) share a push of at most five, in order; the pushes of a chat go out in order. Every push has a UUID retry key stored when its row is created, reused on every attempt for 24 hours and never replaced (a push still unsent then is `dead`, counted from its first request even if a stop cut that request short). `2xx` and `409` are `sent`, `429`, `5xx` and no answer back off and retry (up to `outbox.maxAttempts`), any other `4xx` is `dead` with a code (`sender_name_refused`, `sender_icon_refused`, or `http_<status>`). A quota gate reads LINE's quota and consumption (cached 60 seconds), counts the recipients (1, or the member count of a group or room) and this process's reservations, and refuses a push that would pass the lower of the quota and `quota.monthlyCap`. LINE calls its consumption figure approximate, so a sent push (or one whose outcome is unknown) stays reserved until consumption has grown by its recipients or `quota.holdMs` (10 minutes) has passed; keep `monthlyCap` below the quota with headroom. The subscriber hears an `outboxResult` (`sent`, `dead`, `refused`) per `origin`, at least once. The `line-outbox` service, migration `outbox` (tables `line_outbox` and `line_notices`) and `retention.outboxMs` (7 days) are new; message objects are nulled when a push finishes.
- The join notice. `joinNotice: { text, sha256 }` answers a `join` with one Reply, on the event's reply token, only when the SHA-256 of the text's UTF-8 bytes equals `sha256`, in any chat the bot joins, allowlisted or not; never as a push. A malformed digest throws when the plugin is made; a digest that does not match sends nothing. `joined.notice` is now `"sent"`, `"failed"` (LINE refused the Reply, its token lapsed, or the digest did not match) or `"unconfirmed"` (no notice configured, the Reply got no answer, or the first try was cut short), and the outcome is recorded before the Reply so a redelivered join never replies twice. `digestOf(text)` is exported.
- `route: true` hands the text of messages of allowed chats to the host's router as messages of the `line` surface, inside the transaction that records the message and never for one unsent meanwhile (at least once: only a failed commit right after the hand-over can repeat it) (off by default; the README warns never to admit `line` through `everyone`).
- The `line` chat surface (channel = source key), which queues what the host writes as text pushes and passes `describeSurfaceContract`, and `senderIconRoute: { path, png }`, which serves fixed PNG bytes with a one-year cache header so a sender can name a stable `iconUrl`.
- The retention sweep hands strays back first: refs stored for a message that has a tombstone, more than `retention.strayMs` (default 15 minutes) ago, whose tombstone is that old too, go to the subscriber as `unsent` until they are gone. A handler that outlived its lease could keep a ref after the unsend had run and its take-back was refused, and nothing else would have handed the ref over.

### Changed

- A ref a handler kept and also returns at the end is no longer handed back a second time when the message was unsent meanwhile.
- **Breaking (published in 0.9.13):** `LINE.attachProcessor` is removed in favour of `LINE.subscribe`: a raw processor could read events without the tombstone rules. There is no deprecated shim. Code that attached a processor must subscribe instead; the next lockstep release is 0.10.0. `InboxProcessor` and its types stay exported for the inbox options.

## [0.9.13] - 2026-10-13

### Added

- First slice of the package: `line(options)`, the `LINE` service, a signed webhook that stores every event before it answers, an allowlist of chats, and a durable inbox worker. Stateless channel access tokens (`client_credentials` with the channel id and secret) are issued on demand, kept in memory and never logged. The inbox claims with `FOR UPDATE SKIP LOCKED` per chat, recovers expired leases, retries with backoff and sets an event aside as dead after 12 attempts. Delivery is at least once: a claim is renewed while its handler runs and fences every write that ends it, edits and unsends of one message run strictly in order and wait for an original that is backing off, and nothing of a blocked chat is handed out again. A handler is bounded by `maxHandleMs` (10 minutes: its signal is aborted and the event fails with `handler_timeout`), the worker refills free slots on a kick, a poll or a finished handler while others are still running, and what a chat the bot left still has waiting is dropped with its payload, apart from `unsend` events, which are still delivered so a message the customer took back is taken down. The processor's signal is also aborted when the worker stops or loses the event's lease, the processor is looked up after the claim, and `maxHandleMs`, `leaseMs` and `pollMs` above 2147483647 ms are refused.
