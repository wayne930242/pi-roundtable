import type { ParsedEvent } from "./events.ts";

/** What the webhook does with one signed event of this bot: store it, or drop it unstored. */
export type LineScreenVerdict = "keep" | "consume";

/**
 * Asked, in order, for every event of a request whose signature and destination passed, before the
 * request's events are stored. A consumed event is never stored, routed or handed to the subscriber.
 * A screen that throws, or answers anything but "keep" or "consume", fails the whole request with
 * 500 and stores nothing (LINE redelivers where it can). It sees the event's `raw` body: it must not
 * log or keep what it does not consume. The event is a deeply frozen copy: a screen cannot change
 * what is stored.
 */
export type LineScreen = (event: ParsedEvent) => Promise<LineScreenVerdict>;
