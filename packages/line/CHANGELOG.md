# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- First slice of the package: `line(options)`, the `LINE` service, a signed webhook that stores every event before it answers, an allowlist of chats, and a durable inbox worker. Stateless channel access tokens (`client_credentials` with the channel id and secret) are issued on demand, kept in memory and never logged. The inbox claims with `FOR UPDATE SKIP LOCKED` per chat, recovers expired leases, retries with backoff and sets an event aside as dead after 12 attempts. Delivery is at least once: a claim is renewed while its handler runs and fences every write that ends it, edits and unsends of one message run strictly in order and wait for an original that is backing off, and nothing of a blocked chat is handed out again. A handler is bounded by `maxHandleMs` (10 minutes: its signal is aborted and the event fails with `handler_timeout`), the worker refills free slots on a kick, a poll or a finished handler while others are still running, and what a chat the bot left still has waiting is dropped with its payload, apart from `unsend` events, which are still delivered so a message the customer took back is taken down. The processor's signal is also aborted when the worker stops or loses the event's lease, the processor is looked up after the claim, and `maxHandleMs`, `leaseMs` and `pollMs` above 2147483647 ms are refused.
