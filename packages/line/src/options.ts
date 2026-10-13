import type { MediaOptions } from "./content.ts";
import { checkIcon, type SenderIconRoute } from "./icon.ts";
import type { InboxOptions } from "./inbox.ts";
import { checkJoinNotice, type JoinNoticeOptions } from "./join.ts";
import { checkOutboxOptions, type OutboxOptions } from "./outbox.ts";
import type { QuotaOptions } from "./quota.ts";
import { checkRetention, type RetentionOptions } from "./retention.ts";
import { checkSenderOptions, type SenderOptions } from "./sender.ts";
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
	/** Tunes how message content is fetched: `maxBytes` (default 10 MiB) and the transcoding wait. */
	media?: Partial<MediaOptions>;
	/** Tunes how long the package keeps what it stores; default 7 days for everything. */
	retention?: Partial<RetentionOptions>;
	/** Tunes the outbox: how pushes are gathered, retried and kept inside the retry key's life. */
	outbox?: Partial<OutboxOptions>;
	/** The words a sender name may not use; default `["LINE", "LY"]`. */
	sender?: Partial<SenderOptions>;
	/** The monthly budget a push is kept inside, besides the plan's own quota. */
	quota?: QuotaOptions;
	/**
	 * The notice sent when the bot joins a chat, as a Reply, and only when the SHA-256 of the text's
	 * UTF-8 bytes is `sha256`. Without it no notice is ever sent.
	 */
	joinNotice?: JoinNoticeOptions;
	/**
	 * Hands the text of messages of allowed chats to the host's router, as messages of the `line`
	 * surface; default `false`. Turn it on only with the access rules in mind: never admit `line`
	 * through `everyone`.
	 */
	route?: boolean;
	/** Serves one fixed PNG at `path`, so a sender can name it as its icon without another service. */
	senderIconRoute?: SenderIconRoute;
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

const MEDIA_KEYS: Record<keyof MediaOptions, true> = {
	maxBytes: true,
	transcodingPollMs: true,
	transcodingMaxMs: true,
};

/** Refuses a mistake in the options, naming the field; the host stops before it starts. */
export function checkOptions(options: LineOptions): {
	path: string;
	iconPath: string | undefined;
} {
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
	for (const [key, value] of Object.entries(options.media ?? {})) {
		if (!(key in MEDIA_KEYS))
			throw new Error(`line: media.${key} is not a media option`);
		if (!Number.isInteger(value) || (value as number) < 1)
			throw new Error(
				`line: media.${key} must be a positive whole number; got ${String(value)}`,
			);
	}
	checkRetention(options.retention ?? {});
	checkOutboxOptions(options.outbox ?? {});
	checkSenderOptions(options.sender ?? {});
	const cap = options.quota?.monthlyCap;
	if (options.quota !== undefined) {
		for (const key of Object.keys(options.quota))
			if (key !== "monthlyCap")
				throw new Error(`line: quota.${key} is not a quota option`);
		if (cap !== undefined && (!Number.isInteger(cap) || cap < 1))
			throw new Error(
				`line: quota.monthlyCap must be a positive whole number; got ${String(cap)}`,
			);
	}
	if (options.joinNotice !== undefined) checkJoinNotice(options.joinNotice);
	if (options.route !== undefined && typeof options.route !== "boolean")
		throw new Error("line: route must be true or false");
	let iconPath: string | undefined;
	if (options.senderIconRoute !== undefined) {
		iconPath = options.senderIconRoute.path;
		if (
			typeof iconPath !== "string" ||
			!/^\/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$/.test(iconPath)
		)
			throw new Error(
				`line: senderIconRoute.path ${JSON.stringify(iconPath)} must start with / and not end with one, such as /line/sender-icon.png`,
			);
		if (iconPath === path)
			throw new Error(
				"line: senderIconRoute.path must differ from webhookPath",
			);
		checkIcon(options.senderIconRoute.png);
	}
	return { path, iconPath };
}
