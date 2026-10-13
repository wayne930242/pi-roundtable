import type { InboxOptions } from "./inbox.ts";
import type { LineCredentials } from "./token.ts";

export interface LineOptions {
	/** The channel id and secret, and how the access token is obtained. */
	credentials: LineCredentials;
	/** Where LINE posts events; default `/line/webhook`. Set this URL in the channel's settings. */
	webhookPath?: string;
	/** The configured listener the route attaches to; default `public`. */
	listener?: string;
	/** Tunes the inbox worker. */
	inbox?: Partial<InboxOptions>;
	/** Replaces `fetch` for every call to LINE, for tests. */
	fetch?: typeof fetch;
}

const INBOX_KEYS: readonly (keyof InboxOptions)[] = [
	"leaseMs",
	"maxHandleMs",
	"maxAttempts",
	"maxRequeues",
	"backoffBaseMs",
	"backoffCapMs",
	"concurrency",
	"pollMs",
	"messageGraceMs",
	"dependencyRetryMs",
];

/** The longest delay `setTimeout` and `setInterval` hold; past it they fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** The options that become a timer's delay. */
const TIMER_KEYS: readonly (keyof InboxOptions)[] = [
	"leaseMs",
	"maxHandleMs",
	"pollMs",
];

/** Refuses a mistake in the options, naming the field; the host stops before it starts. */
export function checkOptions(options: LineOptions): { path: string } {
	const path = options.webhookPath ?? "/line/webhook";
	if (!/^\/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$/.test(path))
		throw new Error(
			`line: webhookPath ${JSON.stringify(path)} must start with / and not end with one, such as /line/webhook`,
		);
	for (const [key, value] of Object.entries(options.inbox ?? {})) {
		if (!INBOX_KEYS.includes(key as keyof InboxOptions))
			throw new Error(`line: inbox.${key} is not an inbox option`);
		if (!Number.isInteger(value) || (value as number) < 1)
			throw new Error(
				`line: inbox.${key} must be a positive whole number; got ${String(value)}`,
			);
		if (
			TIMER_KEYS.includes(key as keyof InboxOptions) &&
			(value as number) > MAX_TIMER_MS
		)
			throw new Error(
				`line: inbox.${key} must be at most ${MAX_TIMER_MS} milliseconds (about 24 days); got ${String(value)}`,
			);
	}
	return { path };
}
