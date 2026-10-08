import type {
	ActorFacts,
	IdentityService,
	Logger,
	Principal,
} from "pi-roundtable";

/** Who a request the console admitted comes from: an owner's principal. */
export interface Visitor {
	principal: Principal;
}

/** The visitor of a request, or why it is refused, for the operator's log. */
export type Identified = { visitor: Visitor } | { refusal: string };

/** The reads of `IDENTITY` the console uses; none of them makes or changes a principal. */
export type ConsoleIdentity = Pick<
	IdentityService,
	"principalOf" | "principal" | "tierOf" | "owners"
>;

export interface VisitorOptions {
	/** Whom a request from a verifier that reports no actor stands for; default the primary owner. */
	ownerId?: string;
	logger: Logger;
}

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

	const owner = async (id: string): Promise<Identified> => {
		const principal = await identity.principal(id);
		if (!principal) return { refusal: `there is no principal ${id}` };
		if (principal.disabled) return { refusal: `principal ${id} is disabled` };
		if ((await identity.tierOf(id)) !== "owner")
			return { refusal: `principal ${id} holds no owner role` };
		return { visitor: { principal } };
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
				: owner(id);
		}
		const named = `${actor.provider}:${actor.subject}`;
		let id: string | undefined;
		try {
			id = await identity.principalOf(named);
		} catch {
			return { refusal: "the verifier's actor is no identity" };
		}
		if (id !== undefined) return owner(id);
		warnOnce(
			named,
			`${named} is linked to no principal, so the console refuses it. If it is an owner's, add "${named}" to that owner's access.owners[].identities, or run: roundtable principal link <owner's principal id> ${named}`,
		);
		return { refusal: `${named} is linked to no principal` };
	};
}
