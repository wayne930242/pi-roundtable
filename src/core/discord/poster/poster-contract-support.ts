import { expect } from "bun:test";
import type { DiscordPoster } from "./poster.ts";
import {
	type DiscordFailure,
	DiscordPosterError,
	type DiscordReason,
} from "./poster-errors.ts";

/** How the world arranges who can see a channel, for `canView`. */
export type ViewCase =
	| "owner"
	| "administrator"
	| "member-allowed"
	| "member-denied"
	| "non-member";

/** The names a member goes by. */
export interface MemberNames {
	nick?: string;
	global?: string;
	username: string;
}

/**
 * Discord's side of the world, as a scenario arranges and reads it. A subject answers it in its own
 * way: the fake by setting its fields, the real poster's by editing the emulated Discord.
 */
export interface PosterWorld {
	/** The guild every channel of a scenario is in. */
	readonly guildId: string;
	channel(id: string): void;
	category(id: string): void;
	member(userId: string, names: MemberNames): void;
	/** Arranges why `userId` can or cannot see the channel; returns what `canView` must say. */
	viewCase(channelId: string, userId: string, how: ViewCase): boolean;
	/** A webhook by someone else, under that name; returns its id. */
	foreignWebhook(channelId: string, name: string): string;
	deleteWebhook(channelId: string, name: string): void;
	closeDirects(userId: string): void;
	/** A person archives a thread; `lock` locks it too, `auditSkew` moves the audit entry's time (ms). */
	personArchives(
		threadId: string,
		userId: string,
		options?: { lock?: boolean; auditSkew?: number },
	): void;
	autoArchive(threadId: string): void;
	auditLog(readable: boolean): void;
	pinNotices(on: boolean): void;
	categoryLimit(limit: number): void;
	/** What the message was allowed to ping, as the request said (`undefined` when nothing was said). */
	mentionsOf(
		channelId: string,
		messageId: string,
	): { parse: string[]; users: string[] } | undefined;
	/** What the direct messages to a user were allowed to ping, one entry each. */
	directMentions(userId: string): { parse: string[]; users: string[] }[];
	autoArchiveMinutes(threadId: string): number | undefined;
	/** Whether the message is a Components V2 card as Discord holds it. */
	isCard(channelId: string, messageId: string): boolean;
	/** How many requests reached Discord (for the fake: calls past the argument checks). */
	requests(): number;
}

export interface PosterSubject {
	poster: DiscordPoster;
	world: PosterWorld;
	close(): void;
}

let counter = 0n;

/** A fresh Discord id for a scenario; ids start with 9. */
export function freshId(): string {
	counter += 1n;
	return (900_000_000_000_000_000n + counter).toString();
}

/** Expects the promise to fail with that kind (and reason or code, when given). */
export async function expectFailure(
	promise: Promise<unknown>,
	kind: DiscordFailure,
	detail: { reason?: DiscordReason } = {},
): Promise<DiscordPosterError> {
	const error = await promise.then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(DiscordPosterError);
	const failed = error as DiscordPosterError;
	expect(failed.kind).toBe(kind);
	if (detail.reason) expect(failed.reason).toBe(detail.reason);
	return failed;
}

/** One scenario of the contract. */
export interface Scenario {
	name: string;
	run(subject: PosterSubject): Promise<void>;
}
