import { createHash, timingSafeEqual } from "node:crypto";
import type { Unauthenticated } from "./authenticator.ts";
/** How long a sign-in may take between the redirect to the provider and its callback. */
export const PENDING_MS = 600_000;
/** How long the provider's answers may take. */
export const PROVIDER_TIMEOUT_MS = 10_000;
/** The most roles one sign-in carries, and the longest role name. */
export const MAX_ROLES = 50;
export const MAX_ROLE_CHARS = 100;
export const MAX_NAME_CHARS = 100;
export const MAX_SUBJECT_CHARS = 256;
/** The most characters of one stored claim, as JSON. */
export const MAX_CLAIM_CHARS = 2000;
/** How seldom a live session is reported again to `onSessionVerified`. */
export const VERIFIED_EVERY_MS = 300_000;
/** The most sessions whose last report is remembered before the lapsed ones are dropped. */
export const VERIFIED_PRUNE_AT = 1024;
/** Answers to a silent request that mean "the person must be asked", not "something is wrong". */
export const INTERACTION_NEEDED = new Set([
	"login_required",
	"interaction_required",
	"account_selection_required",
	"consent_required",
]);

/** A request with no usable session, which signing in would fix. */
export const needsSignIn = (why: string): Unauthenticated => ({
	refusal: why,
	status: 401,
	login: true,
});

export const sha256 = (value: string | Buffer) =>
	createHash("sha256").update(value).digest();

export const same = (a: Buffer, b: Buffer) =>
	a.length === b.length && timingSafeEqual(a, b);

export const cookieValue = (
	header: string | null,
	name: string,
): string | undefined => {
	for (const part of (header ?? "").split(";")) {
		const at = part.indexOf("=");
		if (at > 0 && part.slice(0, at).trim() === name)
			return part.slice(at + 1).trim();
	}
	return undefined;
};

/** A claim's text, or undefined when it is not a usable string. */
export const textClaim = (
	value: unknown,
	limit: number,
): string | undefined => {
	const text =
		typeof value === "number" && Number.isFinite(value) ? String(value) : value;
	return typeof text === "string" && text.trim() && text.length <= limit
		? text.trim()
		: undefined;
};
