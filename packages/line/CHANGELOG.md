# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- The consumer. `LINE.subscribe(handler)` takes the one subscriber (a second is refused; the returned function detaches it) and the package's own inbox processor hands it typed events: `message` (text, image, video, audio, file, sticker, location, and `unsupported` for a type it does not know), `edited`, `unsent`, `joined` (`notice: "unconfirmed"` until a join notice is configured), `left`, `memberJoined`, `memberLeft`, and `outboxResult` (declared, not emitted yet). A `message` is answered with `{ refs }` (anything else fails with `bad_refs`), opaque references stored one to many in `line_message_refs` and given back on `edited` and `unsent`; a redelivery of a recorded message is not handed out again and stores nothing twice. The subscriber's third argument has `keep(ref)`, to store the reference of each post as it lands under the same lock and tombstone check as the final store (a ref kept after an unsend is handed back as `unsent` at once and `keep` resolves `{ unsent: true }`); a handler that throws after keeping some refs leaves them stored for the retry and for a later `unsend`.
- Tombstones. An `unsend` writes a tombstone, nulls every inbox payload of the message and deletes its metadata in one transaction under a per-message lock, then hands the refs to the subscriber and forgets them once it returns. A `message` checks the tombstone before it calls the subscriber and again wherever its refs are stored (`keep` or the final store); an unsend that lands meanwhile has the new refs handed straight back. Only a crash between a post and its `keep` can leave a post the package does not know of. Edits arrive out of order and the latest one wins.
- `LINE.content(messageId, { kind, signal })`: message content into memory only, capped by `media.maxBytes` (default 10 MiB) and answered as `{ bytes, contentType }`, `{ tooLarge }` or `{ expired, reason }`; a video or audio waits for `/content/transcoding` for at most `media.transcodingMaxMs` in all, requests included (each request is given what is left of the wait). It uses the content host, reissues the token once on a `401`, stops on the signal, and never fetches a message that was unsent.
- Reply and quote tokens are kept per message in `line_messages` for a later reply mode, never logged or handed to the subscriber, and deleted with the message.
- The `line-retention` service and the `retention` option: inbox events that are done, skipped, dead or never handled, and message metadata, refs and tombstones, are removed after 7 days by default; it logs counts only. A subscriber that stays detached longer than the window loses the unsends and refs that waited for it. New migration `messages` (the released `inbox` migration is untouched).

### Changed

- **Breaking (published in 0.9.13):** `LINE.attachProcessor` is removed in favour of `LINE.subscribe`: a raw processor could read events without the tombstone rules. There is no deprecated shim. Code that attached a processor must subscribe instead; the next lockstep release is 0.10.0. `InboxProcessor` and its types stay exported for the inbox options.

## [0.9.13] - 2026-10-13

### Added

- First slice of the package: `line(options)`, the `LINE` service, a signed webhook that stores every event before it answers, an allowlist of chats, and a durable inbox worker. Stateless channel access tokens (`client_credentials` with the channel id and secret) are issued on demand, kept in memory and never logged. The inbox claims with `FOR UPDATE SKIP LOCKED` per chat, recovers expired leases, retries with backoff and sets an event aside as dead after 12 attempts. Delivery is at least once: a claim is renewed while its handler runs and fences every write that ends it, edits and unsends of one message run strictly in order and wait for an original that is backing off, and nothing of a blocked chat is handed out again. A handler is bounded by `maxHandleMs` (10 minutes: its signal is aborted and the event fails with `handler_timeout`), the worker refills free slots on a kick, a poll or a finished handler while others are still running, and what a chat the bot left still has waiting is dropped with its payload, apart from `unsend` events, which are still delivered so a message the customer took back is taken down. The processor's signal is also aborted when the worker stops or loses the event's lease, the processor is looked up after the claim, and `maxHandleMs`, `leaseMs` and `pollMs` above 2147483647 ms are refused.
