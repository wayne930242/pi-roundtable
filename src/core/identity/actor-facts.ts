import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../sessions.ts";
import type { IdentityRef } from "./principal-store.ts";

/**
 * What a surface reports about the person behind a message or a connection; the identity
 * service decides who they are and the tier they hold.
 */
export interface ActorFacts {
	/** The identity provider: `discord`, `oidc:<base64url issuer>`, `token`, … */
	provider: string;
	/** The person's id at the provider. */
	subject: string;
	/** The name to address them by on this contact. */
	name: string;
	/** The roles they hold, each prefixed with its surface: `discord:role:<id>`, `web:role:<name>`. */
	roles?: readonly string[];
	/**
	 * The surface they reached the host through, as `everyone` lists name it, such as `discord` or
	 * `web`; default the conversation's surface, then the provider up to its first colon.
	 */
	surface?: string;
	/** Where on the surface, such as a guild; informational. */
	space?: string;
	/**
	 * The speaker id 0.8 gave this person, which a principal carried over from 0.8 has as its id:
	 * the user id on Discord, `oidc:<issuer>:<subject>` on the web. At first contact it claims that
	 * principal. It is also the speaker's `id`, the id the surface knows them by.
	 */
	legacyId?: string;
}

/** An identity as configuration and the CLI write it: `<provider>:<subject>`. */
export function identityOf(ref: IdentityRef): string {
	return `${ref.provider}:${ref.subject}`;
}

/**
 * An identity string read back: the provider is the part before the first colon, and for `oidc`
 * the issuer after it too, so `oidc:<issuer>:<subject>` is the 0.8 web speaker id. Undefined
 * when a part is missing.
 */
export function parseIdentity(identity: string): IdentityRef | undefined {
	const first = identity.indexOf(":");
	if (first <= 0) return undefined;
	let cut = first;
	if (identity.slice(0, first) === "oidc") {
		cut = identity.indexOf(":", first + 1);
		if (cut <= first + 1) return undefined;
	}
	const subject = identity.slice(cut + 1);
	if (subject === "") return undefined;
	return { provider: identity.slice(0, cut), subject };
}

/** The surface the facts came through: their own, the conversation's, or the provider's first part. */
export function surfaceOf(
	facts: ActorFacts,
	conversation?: ChannelKey,
): string {
	if (facts.surface) return facts.surface;
	if (conversation) return parseChannelKey(conversation).surface;
	const colon = facts.provider.indexOf(":");
	return colon < 0 ? facts.provider : facts.provider.slice(0, colon);
}
