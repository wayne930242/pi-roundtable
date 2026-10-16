import type { LineApi, RequestOptions } from "./api.ts";
import { LineApiError, LineError } from "./errors.ts";
import { parseSourceKey } from "./events.ts";
import type { LineOutMessage } from "./outbox.ts";
import type { QuotaGate } from "./quota.ts";
import type { TokenSource } from "./token.ts";

export interface LineCallOptions {
	signal?: AbortSignal;
	/** Replaces the client's 15-second per-request timeout. */
	timeoutMs?: number;
}

/** What LINE shows for a person in a chat. */
export interface LineProfile {
	displayName: string;
	pictureUrl?: string;
}

/** The month as the quota gate last read it (at most a minute old), and the host's own cap. */
export interface LineQuotaStanding {
	/** The plan's monthly limit; undefined for a plan without one. */
	limit: number | undefined;
	/** Messages used this month; 0 when there is neither a plan limit nor a `quota.monthlyCap`, which are then not read. */
	used: number;
	/** `quota.monthlyCap` from the options; undefined when unset. */
	cap: number | undefined;
}

export interface LineBotInfo {
	userId: string;
	/** The `@…` basic id. */
	basicId: string;
	displayName?: string;
	pictureUrl?: string;
}

/**
 * LINE's API through the plugin's own token source, timeout and 401-retry. Failures throw
 * `LineApiError` (status and `http_<status>`) or `LineError` with a short code; no message holds a
 * response body.
 */
export interface LineApiPort {
	/**
	 * A group or room member's profile (`/v2/bot/{group|room}/{id}/member/{userId}`), or, in a
	 * one-to-one chat, that user's own (`/v2/bot/profile/{userId}`). Undefined when LINE answers 404
	 * (not in the chat), and without a request for a one-to-one chat with someone else.
	 */
	profile(
		sourceKey: string,
		userId: string,
		options?: LineCallOptions,
	): Promise<LineProfile | undefined>;
	/** How many people a push to the chat reaches: the member count, 1 for a one-to-one chat. Shares the quota gate's one-minute reading. */
	memberCount(sourceKey: string, options?: LineCallOptions): Promise<number>;
	/** The quota gate's reading, refreshed when older than a minute. */
	quota(): Promise<LineQuotaStanding>;
	/** `/v2/bot/info`, asked once and kept (the ids do not change); a failure is asked again next time. */
	botInfo(options?: LineCallOptions): Promise<LineBotInfo>;
	/** Answers an event with its single-use reply token: 1 to 5 messages, free of the push quota, not through the outbox. */
	reply(
		replyToken: string,
		messages: readonly LineOutMessage[],
		options?: LineCallOptions,
	): Promise<void>;
	/** Undefined when a token is held or can be issued now, else the failure's code. Tells no failure listener. */
	probeToken(): Promise<string | undefined>;
	/**
	 * Told the code (`token_refused`, `token_unreachable`, `token_malformed`) of each failed issue of
	 * the channel access token, whichever part of the plugin asked; once per issue however many callers
	 * shared it; never for a probe. Returns the function that detaches it. It must not throw.
	 */
	onTokenFailure(listener: (code: string) => void): () => void;
}

/** The most message objects one reply holds. */
const REPLY_MAX_MESSAGES = 5;

export interface LineApiPortDeps {
	api: LineApi;
	tokens: TokenSource;
	quota: QuotaGate;
}

/** A call's options as the client takes them; a timeout that is not a positive number is refused. */
function callOf(
	options: LineCallOptions | undefined,
): Pick<RequestOptions, "signal" | "timeoutMs"> {
	if (!options) return {};
	const { signal, timeoutMs } = options;
	if (
		timeoutMs !== undefined &&
		!(
			typeof timeoutMs === "number" &&
			Number.isFinite(timeoutMs) &&
			timeoutMs > 0
		)
	)
		throw new LineError(
			"bad_options",
			"line: timeoutMs is a positive number of milliseconds",
		);
	return {
		...(signal ? { signal } : {}),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	};
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

/** The port other plugins call LINE through: the plugin's token source, timeout and 401-retry. */
export function lineApiPort(deps: LineApiPortDeps): LineApiPort {
	const { api, tokens, quota } = deps;
	let botInfo: LineBotInfo | undefined;
	return {
		async profile(sourceKey, userId, options) {
			const call = callOf(options);
			const source = parseSourceKey(sourceKey);
			if (!source)
				throw new LineError("bad_source_key", "line: not a source key");
			if (typeof userId !== "string" || userId === "")
				throw new LineError(
					"bad_user_id",
					"line: a user id is a non-empty string",
				);
			// A one-to-one chat has one member; LINE is not asked about anyone else in it.
			if (source.kind === "user" && source.id !== userId) return undefined;
			const user = encodeURIComponent(userId);
			const path =
				source.kind === "user"
					? `/v2/bot/profile/${user}`
					: `/v2/bot/${source.kind}/${encodeURIComponent(source.id)}/member/${user}`;
			const response = await api.exchange(path, call);
			if (response.status === 404) {
				await response.body?.cancel().catch(() => undefined);
				return undefined;
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new LineApiError(
					response.status,
					`http_${response.status}`,
					`line: a profile lookup answered ${response.status}`,
					response.headers.get("x-line-request-id") ?? undefined,
				);
			}
			const found = (await response.json().catch(() => undefined)) as
				| { displayName?: unknown; pictureUrl?: unknown }
				| undefined;
			if (
				typeof found?.displayName !== "string" ||
				found.displayName.trim() === ""
			)
				throw new LineError(
					"profile_malformed",
					"line: the profile has no displayName",
				);
			const pictureUrl = text(found.pictureUrl);
			return {
				displayName: found.displayName,
				...(pictureUrl ? { pictureUrl } : {}),
			};
		},
		memberCount: (sourceKey, options) =>
			quota.recipients(sourceKey, callOf(options)),
		async quota() {
			const { limit, used } = await quota.standing();
			return { limit, used, cap: quota.cap };
		},
		async botInfo(options) {
			if (botInfo) return { ...botInfo };
			const found = (await api.json("/v2/bot/info", callOf(options))) as
				| {
						userId?: unknown;
						basicId?: unknown;
						displayName?: unknown;
						pictureUrl?: unknown;
				  }
				| undefined;
			const userId = text(found?.userId);
			const basicId = text(found?.basicId);
			if (!userId || !basicId || !/^@\S+$/.test(basicId))
				throw new LineError(
					"bot_info_malformed",
					"line: bot info has no userId or basicId",
				);
			const displayName = text(found?.displayName);
			const pictureUrl = text(found?.pictureUrl);
			botInfo = {
				userId,
				basicId,
				...(displayName ? { displayName } : {}),
				...(pictureUrl ? { pictureUrl } : {}),
			};
			return { ...botInfo };
		},
		async reply(replyToken, messages, options) {
			const call = callOf(options);
			if (typeof replyToken !== "string" || replyToken === "")
				throw new LineError(
					"bad_reply_token",
					"line: a reply token is a non-empty string",
				);
			if (
				!Array.isArray(messages) ||
				messages.length === 0 ||
				messages.length > REPLY_MAX_MESSAGES ||
				messages.some(
					(message) =>
						typeof message !== "object" ||
						message === null ||
						Array.isArray(message) ||
						typeof message.type !== "string" ||
						message.type === "",
				)
			)
				throw new LineError(
					"bad_messages",
					`line: a reply takes 1 to ${REPLY_MAX_MESSAGES} message objects`,
				);
			await api.reply(replyToken, messages, call);
		},
		probeToken: () => tokens.probe(),
		onTokenFailure: (listener) => tokens.onFailure(listener),
	};
}
