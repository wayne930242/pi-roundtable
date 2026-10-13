# pi-roundtable-line

A LINE Messaging API transport for [pi-roundtable][roundtable].
It receives the events of a LINE Official Account's group chats on the host's HTTP listener, stores each one before it answers, and hands the stored events of the chats you allow to one consumer, in order and at least once.
Source lives in [`packages/line`][source] in the pi-roundtable repository and releases in lockstep with the core.

[roundtable]: https://www.npmjs.com/package/pi-roundtable
[source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/line

It covers intake (the credentials and token source, the webhook, the allowlist of chats, and the inbox worker) and the consumer side: typed events for one subscriber, tombstones for unsent messages, message content, and retention.
Sending, quota and the join notice follow in later releases of this package.

## Requirements

- Bun 1.3 or later, and pi-roundtable `>=0.9.0 <0.10.0` as a peer dependency.
- PostgreSQL, which the host already needs.
- An HTTP listener on the host that LINE can reach over HTTPS (the webhook URL is set in the channel's settings).
- A Messaging API channel: its channel id and channel secret.

## Install

```sh
bun add pi-roundtable-line
```

```ts
import type { RoundtableConfig } from "pi-roundtable";
import { line } from "pi-roundtable-line";

export default {
	// ...
	http: { port: 3000, hostname: "127.0.0.1" },
	plugins: [
		line({
			credentials: {
				channelId: process.env.LINE_CHANNEL_ID ?? "",
				channelSecret: process.env.LINE_CHANNEL_SECRET ?? "",
			},
		}),
	],
} satisfies RoundtableConfig;
```

Point the channel's webhook URL at `https://<your host>/line/webhook` and turn the webhook on.
The route attaches to the `public` listener; set `listener` for another, and `webhookPath` to move it.

## Credentials

The channel id and secret are all a stateless setup needs.
The package asks LINE for a channel access token (`POST /oauth2/v3/token`, `grant_type=client_credentials`), keeps it in memory until a minute before it lapses (about 15 minutes), asks again on demand, and asks again once when LINE answers a call with `401`.
Concurrent callers share one request.

```ts
credentials: { channelId, channelSecret, token: "stateless" } // the default
credentials: { channelId, channelSecret, token: { static: longLivedToken } } // a token a console issued
```

A static token cannot be replaced, so a `401` on it is final.
The channel secret also verifies the webhook signature.

Neither the secret nor a token is written to disk, logged, or put in an error message, and neither shows in `JSON.stringify` or `console.log` of the objects that hold them.
Errors carry a short code (`token_refused`, `api_unreachable`, `http_429`, ...) and LINE's request id, never a response body.

## The webhook

`POST /line/webhook` answers:

| Status | When |
|---|---|
| `200` | the events were stored (or there were none: LINE's Verify button) |
| `400` | the body is signed but is not a LINE events object |
| `401` | `x-line-signature` is missing or is not the HMAC-SHA256 of the raw body under the channel secret |
| `403` | the body's `destination` is not this bot (checked once the bot's user id is known) |
| `405` | not a `POST` |
| `413` | the body is over 1 MiB |
| `500` | the database could not store the events |

The signature is checked on the raw bytes, in constant time, before the body is parsed.
All events of a request are stored in one transaction, and `200` follows the commit.
An event with a `webhookEventId` already stored is not stored again, so LINE's redelivery (a channel setting of its own) is safe.

The bot's user id comes from `GET /v2/bot/info` when the host starts.
If LINE cannot be reached then, the plugin logs a warning with a code and keeps trying (at most every 30 seconds, when a webhook arrives); until it knows the id a webhook is vouched for by its signature alone.

## Chats and the allowlist

The first event from a chat the bot has not seen records it as `pending`: its key, when it was first and last seen, and counts.
Nothing a member wrote is stored, and the event's payload is dropped.
A chat is a key `line:group:<id>`, `line:room:<id>` or `line:user:<id>`.

```ts
import { LINE } from "pi-roundtable-line";

const { sources } = context.services.get(LINE);
await sources.pending(); // chats waiting for a decision
await sources.allow("line:group:C...");
await sources.block("line:group:C...");
await sources.summary("line:group:C..."); // adds the group's name, asked of LINE
```

| Status | Meaning |
|---|---|
| `pending` | seen, not decided; events are dropped unread |
| `allowed` | events are stored and handed to the consumer |
| `blocked` | events are dropped; `block` also drops what was waiting |
| `left` | the bot was removed; a `join` makes it `pending` again, because a new group needs a new decision |

The `join` and `leave` events carry no customer text and are kept for every chat that is not blocked.
Allowing a chat does not recover earlier events: they were dropped unread.
This package never creates anything for a chat; what a chat becomes is the consumer's business.

## The inbox worker

Stored events wait in `line_inbox`.
The worker runs inside the host as the `line-inbox` service and hands each event to the package's own processor, which turns it into a typed event for the one subscriber (see [The consumer](#the-consumer)).
Until a subscriber is attached, events stay in the inbox with their payload, are not counted as handed out, and are removed by retention if they wait past its window.

- Delivery is at least once. A handler that outlives its lease (its process died, or it could not renew) may run again for the same event, so a subscriber must be idempotent.
- A claim is `FOR UPDATE SKIP LOCKED` under a per-chat lock: while leases are kept no chat has two events in hand at once, across workers and processes, and events of a chat go out in order of LINE's event time among those that are due. An event that is backing off does not hold the ones behind it.
- A claimed event has a 2-minute lease that the worker renews every 40 seconds while the handler runs, so a slow handler is not taken for a crashed one. Every write that ends a handling is fenced by its claim: a handler that lost the event cannot change what the next claim wrote. The worker puts back events whose lease ran out when it starts and every minute after, other than ones it is handling itself, and that counts as a handing out, so an event that keeps crashing its worker ends up dead.
- A handler runs for at most `maxHandleMs` (10 minutes). The processor (and so the subscriber) receives an `AbortSignal` as its second argument that is aborted then; the lease is no longer renewed and the event fails with `handler_timeout` like any thrown error, so a handler that never settles cannot hold its chat or the shutdown. What it settles with later is ignored. The signal is also aborted when the worker stops (`signal.reason` has the code `worker_stopped`; a handler that then throws the reason or an abort error puts the event back without counting as a failure, while any other error it throws counts) and when the worker finds the event is no longer its own (`lease_lost`). Only a handler that honours the signal gives up: one that ignores it may still be running while the same chat's next event, or the event's own retry, is handed out, so a subscriber must be safe against its own overlap. To give up, throw (for example `throw signal.reason`) or return `{ retryInMs }`: a handler that returns `undefined` has handled the event, and it is marked done. The subscriber is looked up again just before it is called, so one detached or replaced while the event waited gets nothing. `maxHandleMs`, `leaseMs` and `pollMs` are at most 2147483647 (about 24 days), the longest delay a timer holds.
- The worker looks at the inbox on a kick, on every poll and whenever a handler ends, also while handlers are running, so a slow handler holds one of the `concurrency` slots and nothing else; expired leases are put back on the same schedule.
- A thrown error retries with exponential backoff and jitter (5 seconds doubling to 1 hour); after 12 handings out the event is `dead`. Only the error's lower-case `code` word is stored, never its message, because messages may quote what a customer wrote.
- An `unsend` or `messageEdited` event runs strictly after the message it acts on and after the earlier events on that message: it waits, however long, while any of them is still pending, being handled or backing off, and goes to the processor once they are done or dead. The wait does not count against `maxRequeues`. It waits until the soonest of them is due again, and at least `dependencyRetryMs` (5 seconds). A message that has not reached the inbox at all is waited for up to 10 minutes.
- Only events of `allowed` chats, and the `join`, `leave` and `unsend` of a chat that is not blocked, are handed out. When a chat is blocked, what it still has waiting is dropped with its payload, and an event that was in hand at that moment is dropped instead of retried. The same goes for a chat the bot left: when its `leave` is applied, what else it has waiting is dropped with its payload, and an event of a `left` or undecided chat is dropped at the claim, so nothing surfaces after a rejoin. An `unsend` is the exception, because it carries no content and only takes a mirrored message down: it is kept and delivered even after the bot left, while `block` drops it like anything else.
- A finished event keeps its row and loses its payload. U+0000 and lone surrogates in an event are replaced with U+FFFD when it is stored, so one odd event never costs the others of its request.

Options tune the worker: `inbox: { leaseMs, maxHandleMs, maxAttempts, backoffBaseMs, backoffCapMs, concurrency, pollMs, ... }`.

## The consumer

```ts
const detach = context.services.get(LINE).subscribe(async (event, signal) => {
	switch (event.type) {
		case "message": {
			// mirror event.body, then answer the opaque references to what you made
			return { refs: ["discord-message-1", "discord-message-2"] };
		}
		case "edited": // event.text, event.refs (the original's)
		case "unsent": // event.refs: take these down; may be heard more than once
		case "joined": // event.notice: "sent" | "unconfirmed" | "failed"
		case "left":
		case "memberJoined": // event.userIds
		case "memberLeft":
		case "outboxResult": // declared now; emitted once the outbox ships
	}
});
```

There is exactly one subscriber: a second `subscribe` throws, and the function it returns detaches the first.
With none attached the inbox worker claims nothing (events wait, uncounted).
The processor that serves it is the package's own; there is no way to read raw inbox events through the service, so the rules below cannot be bypassed.

| Event | What it carries |
|---|---|
| `message` | `messageId`, `userId`, `quotedMessageId`, and a `body`: `text`, `image`, `video`, `audio` (with `durationMs`), `file` (`fileName`, `fileSize`), `sticker` (`packageId`, `stickerId`, `keywords`), `location` (`title`, `address`, `latitude`, `longitude`), or `unsupported` for a type this version does not know, so nothing disappears silently |
| `edited` | the new `text` and the `refs` of the original, in the order the subscriber gave them; groups only, and only text can be edited |
| `unsent` | the `refs` to take down |
| `joined` | `notice`: `"unconfirmed"` while no join notice is configured |
| `left` | |
| `memberJoined`, `memberLeft` | `userIds` |
| `outboxResult` | reserved in the type; not emitted yet |

Every event has `eventId` (LINE's `webhookEventId`, the same on every redelivery), `sourceKey` and `timestamp`.
No event carries a reply token, a quote token or a URL.

A `message` is answered with `{ refs }`: opaque strings of at most 512 characters (at most 100 per message) that the package stores one to many in `line_message_refs`, in order, and gives back on `edited` and `unsent`.
Answering nothing is allowed; the message is then still recorded as mirrored.
A redelivery of a message that is already recorded is not handed to the subscriber again.
If the process dies between the subscriber's work and the commit of its references, the message is mirrored again; the subscriber should deduplicate on `eventId` if that matters.

### Unsent messages

An `unsend` event writes a tombstone for the message, nulls the stored payload of every event that mentions the message (its own, edits of it), and deletes the message's metadata, tokens included, in one transaction under a per-message lock.
Only then are the stored refs handed to the subscriber as `unsent`; they are forgotten once it has returned, so a subscriber that failed halfway is handed the same refs again.

- A `message` checks the tombstone before it calls the subscriber: an unsent message is never mirrored. Refs left over from a mirror that was cut short are still handed back.
- The refs a subscriber returns are stored under the same lock and the tombstone is checked again there. If the sender took the message back while the subscriber was working, the new refs are stored, handed straight back as `unsent`, and the message record is not written.
- An `unsend` for a message the package never saw (it arrived first, or is older than retention) still writes the tombstone and is heard with `refs: []`.
- An edit of a message that was unsent, was never mirrored, or is older than the last edit applied is skipped; edits arrive out of order, and the one with the latest time wins.

## Message content

```ts
const result = await context.services.get(LINE).content(event.messageId, {
	kind: event.body.kind === "text" ? undefined : event.body.kind,
	signal,
});
if ("bytes" in result) upload(result.bytes, result.contentType);
else if ("tooLarge" in result) placeholder("too large");
else placeholder(result.reason); // "expired" | "unsent" | "transcoding_failed"
```

The content is read into memory, never to disk, never logged, and never exposed at a URL.
`media: { maxBytes }` (default 10 MiB) caps it: a `content-length` over the cap is refused before reading, and a body without one is counted as it streams and dropped past the cap, giving `{ tooLarge: true }`.
LINE keeps content for a limited time; a missing one is `{ expired: true }`.
Pass the event's `kind` for a video or audio: the call then polls `/v2/bot/message/{id}/content/transcoding` (every `media.transcodingPollMs`, 2 seconds, up to `media.transcodingMaxMs`, 60 seconds) until it has `succeeded`; `failed` is `{ expired: true, reason: "transcoding_failed" }` and running out of time is a `transcoding_timeout` error, which the inbox retries.
The call uses the same token source as every other call (a `401` reissues the token once) and the content host `api-data.line.me`.
Pass the handler's `signal` and an aborted event stops the download.
A message that was unsent is never fetched.

## Reply and quote tokens

The reply token and the quote token of a mirrored message are kept in `line_messages` (`reply_token`, `reply_token_at`, `quote_token`) for a later reply mode.
They are never logged and never passed to the subscriber, and they are deleted with the message when it is unsent or when retention runs.

## Retention

The `line-retention` service sweeps once at start and every hour (`retention.intervalMs`):

| What | Removed after (option) |
|---|---|
| inbox events that are `done`, `skipped` or `dead` | 7 days (`retention.inboxMs`) |
| inbox events still `pending`, which no subscriber handled | 7 days (`retention.inboxMs`), payload and all |
| message metadata and tokens, refs, tombstones | 7 days (`retention.messagesMs`) |

It logs counts only, never ids, text or tokens, and counts as `busy` while a sweep runs so the shutdown waits for it.
A table that cannot be trimmed is logged by its code and the others go on.

## Safety

Do not admit a `line` surface through the core's `everyone` access: anyone who can add the bot to a group would reach the assistant.
This release contributes no surface and starts no turn.

## Tests

PostgreSQL-backed tests run when `ROUNDTABLE_TEST_DATABASE_URL` is set and are skipped otherwise.
No test reaches LINE: the plugin takes a `fetch` option, and the tests inject a fake.
