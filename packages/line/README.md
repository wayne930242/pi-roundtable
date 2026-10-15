# pi-roundtable-line

A LINE Messaging API transport for [pi-roundtable][roundtable].
It receives the events of a LINE Official Account's group chats on the host's HTTP listener, stores each one before it answers, hands the stored events of the chats you allow to one consumer, in order and at least once, and sends pushes back to those chats under a sender name, a retry key and a monthly budget.
Source lives in [`packages/line`][source] in the pi-roundtable repository and releases in lockstep with the core.

[roundtable]: https://www.npmjs.com/package/pi-roundtable
[source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/line

It covers intake (the credentials and token source, the webhook, the allowlist of chats, and the inbox worker), the consumer side (typed events for one subscriber, tombstones for unsent messages, message content, and retention) and the sending side: an outbox with per-chat ordering and coalescing, sender names, persisted retry keys and a quota gate, the join notice, an optional router delivery, a `line` chat surface and a route that serves a sender icon.

## Requirements

- Bun 1.3 or later, and pi-roundtable `>=0.14.0 <0.15.0` as a peer dependency.
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

### Webhook counters

`LINE.health()` returns `{ tokensIssued, tokenFailure, webhooks }`, where `webhooks` is what the webhook has answered since the plugin was set up (it starts at zero with each process):

```ts
webhooks: {
	accepted: number; // answered 200, a Verify included
	rejected: {
		signature: number; // 401: the signature is missing or wrong
		signatureForBot: number; // of those, the body names this bot as its destination
		destination: number; // 403: signed, but for another bot
		malformed: number; // 400 and 413: not a LINE events object, or over 1 MiB
	};
	lastAcceptedAt?: string; // ISO time; left out until there was one
	lastRejectedAt?: string;
};
```

They are counts and times only: no body, address or signature is kept, and a request adds one to a counter and nothing else.
A `405` and a `500` (the database could not store the events) are in no counter.
A host that watches for a channel whose webhook URL or secret has drifted can alarm on `rejected.signatureForBot` growing while `accepted` does not: a scanner that finds the URL does not know the bot's user id, so a request that fails its signature yet names this bot as its `destination` is far more likely LINE with a wrong channel secret (or a rotated one) than noise.
To tell, the handler reads the `destination` of a body that failed its signature, only within the 1 MiB limit, and never logs or keeps it; `signatureForBot` also counts in `signature`.
Until the plugin knows the bot's user id it cannot tell, and `signatureForBot` stays at zero.

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

The `join` and `leave` events carry no customer text and are kept for every chat that is not blocked. An `unsend` is stored only while its chat is allowed, but one that is already stored is still delivered after the bot has left the chat (see [The inbox worker](#the-inbox-worker)).
Allowing a chat does not recover earlier events: they were dropped unread.
This package never creates anything for a chat; what a chat becomes is the consumer's business.

## The inbox worker

Stored events wait in `line_inbox`.
The worker runs inside the host as the `line-inbox` service and hands each event to the package's own processor, which turns it into a typed event for the one subscriber (see [The consumer](#the-consumer)).
Until a subscriber is attached, events stay in the inbox with their payload, are not counted as handed out, and are removed by retention if they wait past its window.

- Delivery is at least once. A handler that outlives its lease (its process died, or it could not renew) may run again for the same event, so a subscriber must be idempotent.
- A claim is `FOR UPDATE SKIP LOCKED` under a per-chat lock: while leases are kept no chat has two events in hand at once, across workers and processes, and events of a chat go out in order of LINE's event time among those that are due. An event that is backing off does not hold the ones behind it.
- A claimed event has a 2-minute lease that the worker renews every 40 seconds while the handler runs, so a slow handler is not taken for a crashed one. Every write that ends a handling is fenced by its claim: a handler that lost the event cannot change what the next claim wrote. The worker puts back events whose lease ran out when it starts and every minute after, other than ones it is handling itself, and that counts as a handing out, so an event that keeps crashing its worker ends up dead.
- A handler runs for at most `maxHandleMs` (10 minutes). The processor (and so the subscriber) receives an `AbortSignal` as its second argument that is aborted then; the lease is no longer renewed and the event fails with `handler_timeout` like any thrown error, so a handler that never settles cannot hold its chat or the shutdown. What it settles with later is ignored. The signal is also aborted when the worker stops (`signal.reason` has the code `worker_stopped`; a handler that then throws the reason or an abort error puts the event back without counting as a failure, while any other error it throws counts) and when the worker finds the event is no longer its own (`lease_lost`). Only a handler that honours the signal gives up: one that ignores it may still be running while the same chat's next event, or the event's own retry, is handed out, so a subscriber must be safe against its own overlap. To give up, throw (for example `throw signal.reason`): a handler that returns has handled the event, and it is marked done. A subscriber's result is never read as a retry request; a `message` answer that is neither nothing nor `{ refs }` (a `{ retryInMs }`, say) fails with `bad_refs`. The subscriber is looked up again just before it is called, so one detached or replaced while the event waited gets nothing. `maxHandleMs`, `leaseMs` and `pollMs` are at most 2147483647 (about 24 days), the longest delay a timer holds.
- The worker looks at the inbox on a kick, on every poll and whenever a handler ends, also while handlers are running, so a slow handler holds one of the `concurrency` slots and nothing else; expired leases are put back on the same schedule.
- A thrown error retries with exponential backoff and jitter (5 seconds doubling to 1 hour); after 12 handings out the event is `dead`. Only the error's lower-case `code` word is stored, never its message, because messages may quote what a customer wrote.
- An `unsend` or `messageEdited` event runs strictly after the message it acts on and after the earlier events on that message: it waits, however long, while any of them is still pending, being handled or backing off, and goes to the processor once they are done or dead. The wait does not count against `maxRequeues`. It waits until the soonest of them is due again, and at least `dependencyRetryMs` (5 seconds). A message that has not reached the inbox at all is waited for up to 10 minutes.
- Only events of `allowed` chats, and the `join`, `leave` and `unsend` of a chat that is not blocked, are handed out. When a chat is blocked, what it still has waiting is dropped with its payload, and an event that was in hand at that moment is dropped instead of retried. The same goes for a chat the bot left: when its `leave` is applied, what else it has waiting is dropped with its payload, and an event of a `left` or undecided chat is dropped at the claim, so nothing surfaces after a rejoin. An `unsend` is the exception, because it carries no content and only takes a mirrored message down: it is kept and delivered even after the bot left, while `block` drops it like anything else.
- A finished event keeps its row and loses its payload. U+0000 and lone surrogates in an event are replaced with U+FFFD when it is stored, so one odd event never costs the others of its request.

Options tune the worker: `inbox: { leaseMs, maxHandleMs, maxAttempts, backoffBaseMs, backoffCapMs, concurrency, pollMs, ... }`.

## The consumer

```ts
const detach = context.services.get(LINE).subscribe(async (event, signal, line) => {
	switch (event.type) {
		case "message": {
			// mirror event.body; keep the opaque reference of each post as it lands
			await line.keep("discord-message-1");
			await line.keep("discord-message-2");
			return { refs: ["discord-message-1", "discord-message-2"] };
		}
		case "edited": // event.text, event.refs (the original's)
		case "unsent": // event.refs: take these down; may be heard more than once
		case "joined": // event.notice: "sent" | "unconfirmed" | "failed"
		case "left":
		case "memberJoined": // event.userIds
		case "memberLeft":
		case "outboxResult": // how a push you queued ended
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
| `joined` | `notice`: `"sent"`, `"failed"` or `"unconfirmed"`, truthfully (see [The join notice](#the-join-notice)) |
| `left` | |
| `memberJoined`, `memberLeft` | `userIds` |
| `outboxResult` | `sourceKey`, `originRef`, `status` (`sent`, `dead`, `refused`), `errorCode` and `attempts` (see [Sending](#sending)) |

Every event but `outboxResult` has `eventId` (LINE's `webhookEventId`, the same on every redelivery), `sourceKey` and `timestamp`; a push is not a webhook event, so `outboxResult` has none of the three.
No event carries a reply token, a quote token or a URL.

A `message` is answered with `{ refs }`: opaque strings of at most 512 characters (at most 100 per message, kept and answered together) that the package stores one to many in `line_message_refs`, in order, and gives back on `edited` and `unsent`.
Answering nothing is allowed; the message is then still recorded as mirrored. Any other answer (an object without `refs`, a `{ retryInMs }`) fails the event with `bad_refs`; to give up, throw.
A redelivery of a message that is already recorded is not handed to the subscriber again.

One message may become several posts (a long text is cut into chunks, media and text are posted apart), and the last one can fail.
So the third argument of the subscriber, `line`, has `keep(ref)`: call it as each post lands.
It stores the reference at once, under the same per-message lock and tombstone check as the answer at the end, and resolves `{ unsent }`.
Refs answered at the end merge with the kept ones (one already stored keeps its place), so keeping and answering the same ref is fine; a ref that was kept is never handed back a second time because it is answered again.
A handler that throws after keeping some refs leaves them stored: the retry mirrors the message again, and an `unsent` hands over the posts of every attempt, so none is left behind.
If the sender had already taken the message back, `keep` stores the ref, hands it to the subscriber as `unsent` at once (the same take-back the final store does) and resolves `{ unsent: true }`: stop posting.
Keep each post as it lands, and throw to give up.
Only a crash between a post and its `keep` can leave a post the package does not know of; the message is then mirrored again, and the subscriber should deduplicate on `eventId` if that matters.

### Unsent messages

An `unsend` event writes a tombstone for the message, nulls the stored payload of every event that mentions the message (its own, edits of it), and deletes the message's metadata, tokens included, in one transaction under a per-message lock.
Only then are the stored refs handed to the subscriber as `unsent`; they are forgotten once it has returned, so a subscriber that failed halfway is handed the same refs again.

- A `message` checks the tombstone before it calls the subscriber: an unsent message is never mirrored. Refs left over from a mirror that was cut short are still handed back.
- The refs a subscriber keeps or returns are stored under the same lock and the tombstone is checked again there. If the sender took the message back while the subscriber was working, the new refs are stored, handed straight back as `unsent` (at the `keep` for a kept ref, at the end for the rest), and the message record is not written.
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
Pass the event's `kind` for a video or audio: the call then polls `/v2/bot/message/{id}/content/transcoding` (every `media.transcodingPollMs`, 2 seconds, until `media.transcodingMaxMs`, 60 seconds, have passed since the call began: a real deadline, so each request gets only what is left of it) until it has `succeeded`; `failed` is `{ expired: true, reason: "transcoding_failed" }` and running out of time is a `transcoding_timeout` error, which the inbox retries.
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
| pushes that finished, pushes that never got sent, join notice records | 7 days (`retention.outboxMs`) |

Before it trims, every sweep hands back strays: refs still stored for a message that has a tombstone, where both the ref and the tombstone are more than `retention.strayMs` (15 minutes) old, go to the subscriber as `unsent`, and are forgotten once it returns.
A stray happens when a handler that outlived its lease keeps a ref after its message was unsent and the take-back is refused, so nobody else would hand the ref over.
A take-back that fails is logged by its code and retried at the next sweep, until the ref is gone; with no subscriber attached the refs wait.

A subscriber that stays detached longer than the window loses what was waiting for it: an `unsend` still pending is removed with the rest, and the refs of the message it names are removed too, so that mirror can no longer be taken back. Keep a subscriber attached, or raise `retention.inboxMs` and `retention.messagesMs` beyond the longest outage.

It logs counts only, never ids, text or tokens, and counts as `busy` while a sweep runs so the shutdown waits for it.
A table that cannot be trimmed is logged by its code and the others go on.

## Sending

```ts
const { outbox } = context.services.get(LINE);
await outbox.enqueue(
	"line:group:C...",
	[{ type: "text", text: "On it." }],
	{
		sender: { name: "Ada | Support", iconUrl: "https://example.com/line/staff-icon.png" },
		origin: "draft-42", // your own reference, given back in the outboxResult
	},
);
```

`enqueue` queues LINE message objects for a chat on the allowlist; it throws before queuing anything when the sender is one LINE would refuse (`bad_sender`), an object cannot be sent (`bad_messages`: not an object with a `type`, an empty or over-long text, a `sender` of its own, over 50,000 bytes, more than 100 in one call), the key is not a source key (`bad_source_key`), or the chat is not allowed (`source_not_allowed`).
Message objects hold what you send, so they live in `line_outbox.messages` until the push finishes and are then set to null; the row itself goes after the retention window.

- **Pushes of at most five objects, per chat and sender.** Objects queued for the same chat and the same sender within `outbox.coalesceMs` (2 seconds, counted from the first object, not from the last) share one push, in the order they were queued; a sixth object starts the next push, and a push that holds five goes at once. Different senders never share a push, and a push is never joined if a later push of the chat exists (that would reorder the chat). The chat's pushes go out strictly in order: a push that is backing off holds the ones behind it (a dead or refused one does not).
- **A retry key from the start.** Each push gets a UUID the moment its row exists, before any attempt, and every attempt and every retry after a crash sends it as `X-Line-Retry-Key`. LINE keeps a key for 24 hours (`outbox.retryKeyMs`): a push still unsent then is `dead` with `retry_key_expired` and is never sent under a new key.
- **Outcomes.** `2xx` and `409` (LINE already has this key) are `sent`. `429`, `5xx` and no answer back off (5 seconds doubling to 1 hour, at least `Retry-After`) and retry, up to `outbox.maxAttempts` (12), then `dead` with the last code. Any other `4xx` is `dead` at once with a code: `sender_name_refused` or `sender_icon_refused` when LINE names that property of the request, else `http_<status>`; nothing else of LINE's answer is kept. A push the quota gate refuses is `refused` and is never sent. A push for a chat that stopped being allowed is `dead` with `source_not_allowed`.
- **Results.** The subscriber hears an `outboxResult` for each push once it has ended, once per distinct `origin` the push carries (once with `originRef: null` when none was given), at least once: a result waits while no subscriber is attached and is told again later, up to 12 times, if the subscriber throws. The event carries `attempts`, how many tries the push took, the one that ended it included (1 for a push LINE refused at once, 2 after a `5xx` and then a refusal), so there is no need to read `line_outbox`.
- **What counts as a try.** An attempt is counted when a push is taken up and is given back only when the worker stops before the request was made; the migration `outbox-requested` adds `line_outbox.requested_at`, set just before the request goes out. A stop after it cannot say LINE did not take the request, so that try stays counted (and it counts towards `outbox.maxAttempts`).
- **Crashes.** A push in hand when the process dies has a 2-minute lease; the worker puts it back and sends it again under the same key, which LINE answers with `409` if it had taken the first request.
- **Service.** The `line-outbox` service runs the worker and counts as `busy` while a push is in flight, so the shutdown waits for it; a push still in flight when the host stops is put back as it was.
- **Nothing sensitive in logs.** The worker logs push ids, attempt numbers, status words and codes; never message objects, sender names, retry keys or tokens.

### Senders

A sender is `{ name?, iconUrl? }`, shown by LINE as "<name> from '<channel>'".
It is checked when you enqueue: the name is 1 to 20 characters (counted as characters, so an emoji is one), has no leading or trailing space or control character, and contains none of the forbidden words (`sender.forbiddenWords`, default `["LINE", "LY"]`, compared case-insensitively, with full-width letters read as plain ones, and as whole words, where a word is a run of Latin letters and digits or a run of letters of another script, so "Online" and "Sally" pass while "LINE" next to kana or hanzi does not); the icon is an `https` URL of at most 2000 characters without credentials.
LINE has the last word: a name it refuses anyway comes back as a dead push with `sender_name_refused`.

### Quota

Before a push is sent the gate reads LINE's monthly limit (`/v2/bot/message/quota`) and consumption (`/v2/bot/message/quota/consumption`), cached for 60 seconds, and counts the push's recipients: 1 for a user chat, the member count (`/members/count`, cached for 60 seconds) for a group or room.
The push goes only if consumption, plus what this process has already reserved for pushes it sent or is sending, plus its own recipients, stays within the lower of the plan's quota and `quota.monthlyCap`; otherwise it is `refused` with `quota_exhausted`.
A reservation for a push that went out stays counted until the consumption LINE reports has grown by at least the push's recipients since it was sent, or until `quota.holdMs` (10 minutes by default) has passed. A push whose outcome is unknown (a timeout, no answer, or a `5xx`) is held as if it had been sent; one LINE refused with a `4xx` or `429` is dropped at once. When the quota cannot be read the push backs off and retries; it is not refused and not sent blind.
This rests on an assumption: LINE calls its consumption figure approximate, and the gate treats it as approximate. It may count late, so keep `monthlyCap` below the plan's quota with some headroom, and keep it lower still when other processes, or the LINE Official Account Manager, send too. Only this process's reservations are known, and they are lost on a restart.

```ts
line({ credentials, quota: { monthlyCap: 400 } })
```

## The join notice

```ts
line({
	credentials,
	joinNotice: { text: NOTICE_TEXT, sha256: NOTICE_SHA256 },
})
```

When the bot joins a chat the package answers the `join` event with **one Reply**, using the event's reply token, if and only if the SHA-256 of the text's UTF-8 bytes (lower-case hex) equals `joinNotice.sha256`.
`digestOf(text)` computes it. A digest that is not 64 lower-case hex digits, or a text over 5000 characters, throws when the plugin is made; a well-formed digest that does not match the text does not stop the host, but nothing is ever sent and every join is `failed` (and a warning is logged once at start).
Without `joinNotice` nothing is ever sent.

- It applies to any chat the bot joins that is not blocked, allowlisted or not.
- It is never a push. When LINE refuses the Reply, or its token has lapsed (reply tokens live a short time), the notice is `failed` and nothing is sent in its place. When the Reply gets no answer (a timeout or an unreachable LINE) nobody knows whether LINE took it, so the notice is `unconfirmed` and is not tried again.
- The subscriber's `joined` event says what happened: `"sent"`, `"failed"`, or `"unconfirmed"` (no notice configured, or the Reply got no answer, or the first try was cut short, and nobody knows whether LINE got the Reply). The outcome is recorded before the Reply is made, so a join that is handed out again never replies twice.
- The inbox worker only runs while a subscriber is attached (or `route` is on), so attach one before the bot can be added to chats; a join that waits past its reply token's life is `failed`.

## Router delivery

`route: true` hands the text of messages of allowed chats to the host's router, as messages of the `line` surface (channel `line:group:<id>`, author the LINE user id, `mentionsBot` when the bot is @mentioned, with the bot's mention cut out of the text), after the subscriber has mirrored them, and never for a message that was unsent meanwhile.
The hand-over happens in the same transaction that records the message, so a router that throws makes the event retry and a failed store hands over nothing. Delivery is at least once: only a failure of the commit itself, right after the router took the text, can hand the same text over a second time.
Images, stickers and other kinds are not routed, nor are messages LINE did not name a sender for.
It is off by default.
**Never admit `line` through the core's `everyone` access**: anyone who can add the bot to a group, or write in a chat you allow, would reach the assistant. Admit only identities you have linked to a person.
With `route` on the inbox is served even when no subscriber is attached.

## The `line` chat surface

The plugin contributes a chat surface under the prefix `line`; its channel is a source key (`line:group:<id>`, `line:room:<id>`, `line:user:<id>`).
What the host writes there (`sendReply`) is queued as text objects, one per chunk (a chunk over 5000 characters is cut, never inside a surrogate pair), and goes out as a push with no sender; it reaches only a chat on the allowlist.
The surface shows no typing indicator, stop control, progress, files or approval prompts: LINE has none the bot can show.
It passes `describeSurfaceContract` (`pi-roundtable/testing`).

## The sender icon route

```ts
line({ credentials, senderIconRoute: { path: "/line/staff-icon.png", png: readFileSync("staff-icon.png") } })
```

Serves fixed PNG bytes at `path` to `GET` and `HEAD` with `cache-control: public, max-age=31536000, immutable`, on the same listener as the webhook, so the host can give LINE a stable `iconUrl` (`https://<your host>/line/staff-icon.png`) without another service.
The bytes are copied when the plugin is made and checked: they must be a PNG of at most 1 MiB, and `path` must differ from `webhookPath`.

## Safety

Do not admit a `line` surface through the core's `everyone` access: anyone who can add the bot to a group would reach the assistant (see [Router delivery](#router-delivery)).
A push goes only to a chat on the allowlist, under a sender that was checked before it was queued, inside the month's budget.
The access token, the channel secret, reply and quote tokens, retry keys and message text appear in no log line and no error.

## Tests

PostgreSQL-backed tests run when `ROUNDTABLE_TEST_DATABASE_URL` is set and are skipped otherwise.
No test reaches LINE: the plugin takes a `fetch` option, and the tests inject a fake.
