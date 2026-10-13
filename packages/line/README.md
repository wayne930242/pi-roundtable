# pi-roundtable-line

A LINE Messaging API transport for [pi-roundtable][roundtable].
It receives the events of a LINE Official Account's group chats on the host's HTTP listener, stores each one before it answers, and hands the stored events of the chats you allow to one consumer, in order and at least once.
Source lives in [`packages/line`][source] in the pi-roundtable repository and releases in lockstep with the core.

[roundtable]: https://www.npmjs.com/package/pi-roundtable
[source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/line

This first slice covers intake: the credentials and token source, the webhook, the allowlist of chats, and the inbox worker.
Mirroring messages to a consumer, sending, quota and the join notice follow in later releases of this package.

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
The worker runs inside the host as the `line-inbox` service and hands events to the processor attached through the service:

```ts
const detach = context.services.get(LINE).attachProcessor(async (event) => {
	// event.type, event.sourceKey, event.messageId, event.timestamp, event.payload
	// return nothing when done, or { retryInMs } to look at it again later
});
```

Until a processor is attached, events stay in the inbox with their payload.

- Delivery is at least once. A handler that outlives its lease (its process died, or it could not renew) may run again for the same event, so a processor must be idempotent.
- A claim is `FOR UPDATE SKIP LOCKED` under a per-chat lock: while leases are kept no chat has two events in hand at once, across workers and processes, and events of a chat go out in order of LINE's event time among those that are due. An event that is backing off does not hold the ones behind it.
- A claimed event has a 2-minute lease that the worker renews every 40 seconds while the handler runs, so a slow handler is not taken for a crashed one. Every write that ends a handling is fenced by its claim: a handler that lost the event cannot change what the next claim wrote. The worker puts back events whose lease ran out when it starts and every minute after, other than ones it is handling itself, and that counts as a handing out, so an event that keeps crashing its worker ends up dead.
- A thrown error retries with exponential backoff and jitter (5 seconds doubling to 1 hour); after 12 handings out the event is `dead`. Only the error's lower-case `code` word is stored, never its message, because messages may quote what a customer wrote.
- An `unsend` or `messageEdited` event runs strictly after the message it acts on and after the earlier events on that message: it waits, however long, while any of them is still pending, being handled or backing off, and goes to the processor once they are done or dead. The wait does not count against `maxRequeues`. A message that has not reached the inbox at all is waited for up to 10 minutes.
- Only events of `allowed` chats, and the `join` and `leave` of a chat that is not blocked, are handed out. When a chat is blocked, what it still has waiting is dropped with its payload, and an event that was in hand at that moment is dropped instead of retried.
- A finished event keeps its row and loses its payload. U+0000 and lone surrogates in an event are replaced with U+FFFD when it is stored, so one odd event never costs the others of its request.

Options tune the worker: `inbox: { leaseMs, maxAttempts, backoffBaseMs, backoffCapMs, concurrency, pollMs, ... }`.

## Safety

Do not admit a `line` surface through the core's `everyone` access: anyone who can add the bot to a group would reach the assistant.
This slice contributes no surface and starts no turn.

## Tests

PostgreSQL-backed tests run when `ROUNDTABLE_TEST_DATABASE_URL` is set and are skipped otherwise.
No test reaches LINE: the plugin takes a `fetch` option, and the tests inject a fake.
