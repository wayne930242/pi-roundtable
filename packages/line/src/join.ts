import { createHash } from "node:crypto";
import type { SQL } from "bun";
import type { Logger } from "pi-roundtable";
import type { LineApi } from "./api.ts";
import { errorCode } from "./errors.ts";
import { type JoinNotice, nonEmpty } from "./messages.ts";

/** The most characters one LINE text message holds. */
export const NOTICE_MAX_CHARS = 5000;

/** The text sent when the bot joins a chat, and the SHA-256 (hex) of its UTF-8 bytes that gates it. */
export interface JoinNoticeOptions {
	text: string;
	sha256: string;
}

const DIGEST = /^[0-9a-f]{64}$/;

/** The SHA-256 of a text's UTF-8 bytes, as lower-case hex. */
export const digestOf = (text: string): string =>
	createHash("sha256").update(text, "utf8").digest("hex");

/** Refuses a join notice that cannot work: a digest that is not 64 hex digits, or a text LINE would refuse. */
export function checkJoinNotice(notice: JoinNoticeOptions): void {
	if (typeof notice !== "object" || notice === null)
		throw new Error("line: joinNotice is { text, sha256 }");
	if (typeof notice.sha256 !== "string" || !DIGEST.test(notice.sha256))
		throw new Error(
			"line: joinNotice.sha256 must be 64 lower-case hex digits (the SHA-256 of the text's UTF-8 bytes)",
		);
	if (
		typeof notice.text !== "string" ||
		notice.text === "" ||
		notice.text.length > NOTICE_MAX_CHARS
	)
		throw new Error(
			`line: joinNotice.text must be a text of 1 to ${NOTICE_MAX_CHARS} characters`,
		);
}

export interface JoinNotifierDeps {
	sql: SQL;
	api: LineApi;
	logger: Logger;
	now: () => Date;
	notice?: JoinNoticeOptions;
}

/**
 * Answers a `join` event with the configured notice, once, as a Reply with the event's reply token.
 * It sends only text whose SHA-256 is the configured digest, to any chat the bot joins, allowed or
 * not, and never as a push: when LINE refuses the Reply or the token has lapsed the notice is `failed`,
 * and nothing else is sent. A Reply that got no answer is `unconfirmed`, and its record stays
 * `attempting`.
 *
 * The outcome is recorded before the Reply is made, so a join that is handed out again never
 * replies twice: it learns `sent` or `failed`, or `unconfirmed` when the first try was cut short
 * and nobody knows whether LINE got the reply.
 */
export class JoinNotifier {
	readonly #sql: SQL;
	readonly #api: LineApi;
	readonly #logger: Logger;
	readonly #now: () => Date;
	readonly #notice: JoinNoticeOptions | undefined;
	readonly #matches: boolean;

	constructor(deps: JoinNotifierDeps) {
		this.#sql = deps.sql;
		this.#api = deps.api;
		this.#logger = deps.logger;
		this.#now = deps.now;
		this.#notice = deps.notice;
		this.#matches = deps.notice
			? digestOf(deps.notice.text) === deps.notice.sha256
			: false;
	}

	/** Whether a notice is configured and its text is the one the digest names. */
	get armed(): boolean {
		return this.#notice !== undefined && this.#matches;
	}

	async send(event: {
		id: string;
		payload: Record<string, unknown>;
	}): Promise<JoinNotice> {
		const notice = this.#notice;
		// Nothing configured: nothing is sent, and nobody should take that for a notice.
		if (!notice) return "unconfirmed";
		if (!this.#matches) {
			this.#logger.warn(
				{ code: "join_notice_digest_mismatch" },
				"the LINE join notice text is not the one its digest names, so it was not sent",
			);
			return "failed";
		}
		const claimed = await this
			.#sql`INSERT INTO line_notices (webhook_event_id, outcome, created_at)
			VALUES (${event.id}, 'attempting', ${this.#now()})
			ON CONFLICT (webhook_event_id) DO NOTHING RETURNING 1`;
		if (claimed.length === 0) {
			const [row] = (await this
				.#sql`SELECT outcome FROM line_notices WHERE webhook_event_id = ${event.id}`) as {
				outcome: string;
			}[];
			return row?.outcome === "sent"
				? "sent"
				: row?.outcome === "failed"
					? "failed"
					: "unconfirmed";
		}
		const token = nonEmpty(event.payload.replyToken);
		let outcome: "sent" | "failed" | "attempting" = "failed";
		if (!token) {
			this.#logger.warn(
				{ code: "no_reply_token" },
				"a LINE join came without a reply token, so the notice was not sent",
			);
		} else {
			try {
				await this.#api.reply(token, [{ type: "text", text: notice.text }]);
				outcome = "sent";
			} catch (error) {
				const code = errorCode(error);
				// No answer is not a refusal: LINE may have taken the Reply, so nobody can say it failed.
				if (code === "api_unreachable") outcome = "attempting";
				this.#logger.warn({ code }, "the LINE join notice could not be sent");
			}
		}
		if (outcome === "attempting") return "unconfirmed";
		await this
			.#sql`UPDATE line_notices SET outcome = ${outcome} WHERE webhook_event_id = ${event.id}`;
		return outcome;
	}
}
