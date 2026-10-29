import type {
	ActorFacts,
	ChannelKey,
	IdentityService,
	Logger,
	Principal,
	Tier,
} from "pi-roundtable";

/**
 * Who a request the console admitted comes from: the principal, the tier they hold on this
 * request (read again for every request and every socket frame, never carried over from the
 * sign-in), the identity they spoke as, and the roles their sign-in carried.
 */
export interface Visitor {
	principal: Principal;
	tier: Tier;
	/** The identity they spoke as, `<provider>:<subject>`; the principal's id when the credential names none. */
	speakerId: string;
	/** The roles the sign-in carried, each `<surface>:role:<name>`. */
	roles: readonly string[];
}

/** The visitor of a request, or why it is refused, for the operator's log. */
export type Identified = { visitor: Visitor } | { refusal: string };

/** The reads of `IDENTITY` the console uses; none of them makes or changes a principal. */
export type ConsoleIdentity = Pick<
	IdentityService,
	"principalOf" | "principal" | "tierOf" | "owners"
>;

/** The reads (and the one first-contact write) of `IDENTITY` that admitting members uses. */
export type AccessIdentity = Pick<
	IdentityService,
	"principalOf" | "principal" | "peek" | "resolve"
>;

export interface VisitorOptions {
	/** Whom a request from a verifier that reports no actor stands for; default the primary owner. */
	ownerId?: string;
	logger: Logger;
}

/** The provider of the aliases 0.9 keeps for 0.8 ids; `IDENTITY.resolve` refuses it as no surface's. */
const LEGACY_PROVIDER = "legacy";

/** How many unlinked identities are remembered, so each is warned about once. */
const WARNED_MAX = 100;

/**
 * Identifies the person behind each request the verifier admitted, by reading `IDENTITY` only, so
 * a visitor never makes a principal: the principal their identity is linked to, who must hold the
 * owner role. An identity linked to no one is refused on every host, however many owners it has:
 * the verifier may vouch for members too, so only a link says whose an identity is. A verifier
 * that reports no actor speaks for `ownerId`, default the primary owner, as in 0.8.
 */
export function consoleVisitors(
	identity: ConsoleIdentity,
	options: VisitorOptions,
): (actor: ActorFacts | undefined) => Promise<Identified> {
	const { logger } = options;
	const warned = new Set<string>();
	const warnOnce = (key: string, message: string) => {
		if (warned.has(key) || warned.size >= WARNED_MAX) return;
		warned.add(key);
		logger.warn(`web-console: ${message}`);
	};

	const owner = async (
		id: string,
		actor: ActorFacts | undefined,
	): Promise<Identified> => {
		const principal = await identity.principal(id);
		if (!principal) return { refusal: `there is no principal ${id}` };
		if (principal.disabled) return { refusal: `principal ${id} is disabled` };
		const tier = await identity.tierOf(id);
		if (tier !== "owner")
			return { refusal: `principal ${id} holds no owner role` };
		return {
			visitor: {
				principal,
				tier,
				speakerId: actor ? `${actor.provider}:${actor.subject}` : id,
				roles: actor?.roles ?? [],
			},
		};
	};

	return async (actor) => {
		if (!actor) {
			warnOnce(
				"",
				"the verifier reports no actor, so the console takes every request it admits as the primary owner's. Have it report who signed in (cloudflareAccess does)",
			);
			const id = options.ownerId ?? (await identity.owners())[0]?.id;
			return id === undefined
				? { refusal: "the host has no owner" }
				: owner(id, undefined);
		}
		const named = `${actor.provider}:${actor.subject}`;
		if (actor.provider === LEGACY_PROVIDER)
			return { refusal: `${named} is a 0.8 id, not an identity` };
		let id: string | undefined;
		try {
			id = await identity.principalOf(named);
		} catch {
			return { refusal: "the verifier's actor is no identity" };
		}
		if (id !== undefined) return owner(id, actor);
		warnOnce(
			named,
			`${named} is linked to no principal, so the console refuses it. If it is an owner's, add "${named}" to that owner's access.owners[].identities, or run: roundtable principal link <owner's principal id> ${named}`,
		);
		return { refusal: `${named} is linked to no principal` };
	};
}

export interface AccessOptions {
	/** The app's surface, such as `app`: the surface the facts name and the conversation `<surface>:session` the tier is read for. */
	surface: string;
	logger: Logger;
}

/**
 * Identifies the person behind each request when the app admits everyone `IDENTITY` admits on its
 * surface (`admission: "access"`). The credential must name a person: one shared actor names no
 * one. The facts are the app's (`surface`, `partial`, and the roles the sign-in carried), so a
 * sign-in shows less than a person may hold and never lowers a tier recorded elsewhere.
 *
 * A linked identity is only read (`peek`): a request writes nothing. An unlinked one goes through
 * `resolve`, which admits it as a new principal where `access.provisioning` says so for the
 * surface. A disabled principal, and a person the rules give no tier, are refused.
 */
export function accessVisitors(
	identity: AccessIdentity,
	options: AccessOptions,
): (actor: ActorFacts | undefined) => Promise<Identified> {
	const { surface, logger } = options;
	const scope = { conversation: `${surface}:session` as ChannelKey };
	return async (actor) => {
		if (!actor) return { refusal: "the credential names no one" };
		if (actor.provider === LEGACY_PROVIDER)
			return { refusal: "a 0.8 id is not an identity" };
		const named = `${actor.provider}:${actor.subject}`;
		const facts: ActorFacts = { ...actor, surface, partial: true };
		let linked: string | undefined;
		try {
			linked = await identity.principalOf(named);
		} catch {
			return { refusal: "the credential's actor is no identity" };
		}
		const speaker =
			linked === undefined
				? await identity.resolve(facts, scope)
				: await identity.peek(facts, scope);
		if (!speaker) {
			logger.debug(
				{ linked: linked !== undefined },
				"web-console: the access rules serve no one by this sign-in",
			);
			return { refusal: `${named} holds no tier on this surface` };
		}
		const principal = await identity.principal(speaker.principalId);
		if (!principal) return { refusal: "the principal is gone" };
		if (principal.disabled)
			return { refusal: `principal ${principal.id} is disabled` };
		return {
			visitor: {
				principal,
				tier: speaker.tier,
				speakerId: named,
				roles: actor.roles ?? [],
			},
		};
	};
}
