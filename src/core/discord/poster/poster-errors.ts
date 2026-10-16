import { DiscordAPIError, HTTPError, RESTJSONErrorCodes } from "discord.js";

/** Why a call to Discord failed. */
export type DiscordFailure =
	| "invalid" // the call was refused before it was sent (a bad argument)
	| "channel_gone" // the channel does not exist (any more)
	| "message_gone" // the message does not exist (any more)
	| "forbidden" // the bot lacks a permission
	| "rejected" // Discord refused it for another reason; asking again fails again
	| "unavailable"; // Discord or the network failed, or a rate limit held it back; asking again may work

/**
 * More about why Discord refused, where its code alone does not say: a category that is full (a
 * 400 with a form-body error) and a channel that is no category or in no right guild.
 */
export type DiscordReason = "category_full" | "not_category" | "wrong_guild";

/**
 * A failed Discord call. The message names the operation and Discord's own reason, never a URL,
 * a webhook token or the bot token.
 */
export class DiscordPosterError extends Error {
	override name = "DiscordPosterError";
	readonly kind: DiscordFailure;
	/** Discord's JSON error code, when it sent one. */
	readonly discordCode: number | undefined;
	readonly status: number | undefined;
	readonly reason: DiscordReason | undefined;
	constructor(
		kind: DiscordFailure,
		message: string,
		detail: {
			discordCode?: number;
			status?: number;
			reason?: DiscordReason;
		} = {},
	) {
		super(message);
		this.kind = kind;
		this.discordCode = detail.discordCode;
		this.status = detail.status;
		this.reason = detail.reason;
	}
	/** Whether the same call may work later. */
	get retryable(): boolean {
		return this.kind === "unavailable";
	}
}

/**
 * Turns whatever the REST client threw into a `DiscordPosterError`. Discord's error carries the
 * request URL, which for a webhook holds its token, so only the operation and Discord's own words
 * are kept.
 */
export function failure(operation: string, error: unknown): DiscordPosterError {
	if (error instanceof DiscordPosterError) return error;
	if (error instanceof DiscordAPIError) {
		const detail: {
			discordCode: number;
			status: number;
			reason?: "category_full";
		} = { discordCode: Number(error.code), status: error.status };
		// A full category comes back as a form-body error naming the parent, not as a code of its own.
		if (
			Number(error.code) === RESTJSONErrorCodes.InvalidFormBodyOrContentType &&
			JSON.stringify(error.rawError).includes("CHANNEL_PARENT_MAX_CHANNELS")
		)
			detail.reason = "category_full";
		const said = `${operation} failed (${error.status}, code ${error.code}): ${error.message}`;
		switch (error.code) {
			case RESTJSONErrorCodes.UnknownChannel:
				return new DiscordPosterError("channel_gone", said, detail);
			case RESTJSONErrorCodes.UnknownMessage:
				return new DiscordPosterError("message_gone", said, detail);
			case RESTJSONErrorCodes.UnknownWebhook:
			case RESTJSONErrorCodes.InvalidWebhookToken:
				return new DiscordPosterError("rejected", said, detail);
			case RESTJSONErrorCodes.MissingPermissions:
			case RESTJSONErrorCodes.MissingAccess:
				return new DiscordPosterError("forbidden", said, detail);
			default:
				return new DiscordPosterError(
					error.status >= 500 ? "unavailable" : "rejected",
					said,
					detail,
				);
		}
	}
	if (error instanceof HTTPError)
		return new DiscordPosterError(
			"unavailable",
			`${operation} failed (${error.status})`,
			{ status: error.status },
		);
	// A network failure or a timeout: the reason without the request.
	const reason = error instanceof Error ? error.name : "unknown error";
	return new DiscordPosterError(
		"unavailable",
		`${operation} failed (${reason})`,
	);
}

/** Whether the REST client threw Discord's error with one of these JSON codes. */
export function isCode(error: unknown, ...codes: number[]): boolean {
	return error instanceof DiscordAPIError && codes.includes(Number(error.code));
}
