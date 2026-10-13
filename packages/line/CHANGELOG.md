# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- First slice of the package: `line(options)`, the `LINE` service, a signed webhook that stores every event before it answers, an allowlist of chats, and a durable inbox worker. Stateless channel access tokens (`client_credentials` with the channel id and secret) are issued on demand, kept in memory and never logged. The inbox claims with `FOR UPDATE SKIP LOCKED` per chat, recovers expired leases, retries with backoff and sets an event aside as dead after 12 attempts. Delivery is at least once: a claim is renewed while its handler runs and fences every write that ends it, edits and unsends of one message run strictly in order and wait for an original that is backing off, and nothing of a blocked chat is handed out again.
