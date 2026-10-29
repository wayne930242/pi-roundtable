import type { IdentityService, Logger } from "pi-roundtable";
import type { LinksView, LinkView } from "../api-types.ts";
import type { Gate } from "../gate.ts";
import type { LinkProver, WebAppRegistry } from "../web-app.ts";

/** Why a link request was refused, in words the page shows. `status` is the HTTP status. */
export class LinkRefused extends Error {
	readonly status: number;
	constructor(message: string, status = 409) {
		super(message);
		this.name = "LinkRefused";
		this.status = status;
	}
}

export interface LinkServiceOptions {
	registry: Pick<WebAppRegistry, "provers" | "prover">;
	/** `onboarding.links`: which providers are required or only nudged. */
	steps: Readonly<Record<string, "required" | "nudge">>;
	identity: Pick<IdentityService, "identities">;
	gate: Pick<Gate, "changed">;
	logger: Logger;
}

/** Link sources that the configuration, the CLI or a plugin made, which a person cannot remove. */
const LOCKED = new Set(["config", "cli", "plugin"]);

/**
 * The accounts a person can link and how they stand. Every call to a prover carries the session's
 * principal, never one a request names; a prover's `requires` must be linked first, and a link
 * the configuration, CLI or a plugin made is never unlinked here.
 */
export class LinkService {
	readonly #options: LinkServiceOptions;

	constructor(options: LinkServiceOptions) {
		this.#options = options;
	}

	prover(provider: string): LinkProver {
		const found = this.#options.registry.prover(provider);
		if (!found) throw new LinkRefused("There is no such account to link.", 404);
		return found;
	}

	async list(principalId: string): Promise<LinksView> {
		const links = await Promise.all(
			this.#options.registry
				.provers()
				.map((prover) => this.#view(prover, principalId)),
		);
		return { links };
	}

	async one(provider: string, principalId: string): Promise<LinkView> {
		return this.#view(this.prover(provider), principalId);
	}

	async issue(provider: string, principalId: string) {
		const prover = this.prover(provider);
		const blocked = await this.#blockedBy(prover, principalId);
		if (blocked.length > 0)
			throw new LinkRefused(
				`Link ${blocked.map((p) => this.#options.registry.prover(p)?.label ?? p).join(" and ")} first.`,
			);
		if ((await prover.status(principalId)).linked)
			throw new LinkRefused("That account is already linked.");
		const issued = await prover.issue(principalId);
		return {
			code: issued.code,
			request: issued.request,
			expiresAt: issued.expiresAt.toISOString(),
			instructions: issued.instructions,
		};
	}

	async confirm(provider: string, principalId: string, request: string) {
		const prover = this.prover(provider);
		await prover.confirm(principalId, request);
		this.#options.gate.changed(principalId);
		return this.#view(prover, principalId);
	}

	async cancel(provider: string, principalId: string): Promise<LinkView> {
		const prover = this.prover(provider);
		await prover.cancel(principalId);
		return this.#view(prover, principalId);
	}

	async unlink(provider: string, principalId: string): Promise<LinkView> {
		const prover = this.prover(provider);
		const locked = (await this.#options.identity.identities(principalId)).some(
			(link) => link.provider === provider && LOCKED.has(link.source),
		);
		if (locked)
			throw new LinkRefused(
				"That account was linked by the host's configuration, so it cannot be removed here.",
			);
		await prover.unlink(principalId);
		this.#options.gate.changed(principalId);
		return this.#view(prover, principalId);
	}

	/** The providers `prover` requires that the person has not linked. */
	async #blockedBy(prover: LinkProver, principalId: string): Promise<string[]> {
		const blocked: string[] = [];
		for (const needed of prover.requires ?? []) {
			const other = this.#options.registry.prover(needed);
			const linked = other
				? Boolean((await other.status(principalId)).linked)
				: false;
			const known = (await this.#options.identity.identities(principalId)).some(
				(link) => link.provider === needed,
			);
			if (!linked && !known) blocked.push(needed);
		}
		return blocked;
	}

	async #view(prover: LinkProver, principalId: string): Promise<LinkView> {
		const [state, identities, blocked] = await Promise.all([
			prover.status(principalId),
			this.#options.identity.identities(principalId),
			this.#blockedBy(prover, principalId),
		]);
		const own = identities.find((link) => link.provider === prover.provider);
		const linked = state.linked
			? {
					...(state.linked.displayName
						? { displayName: state.linked.displayName }
						: {}),
					linkedAt: state.linked.linkedAt.toISOString(),
					...(own && LOCKED.has(own.source) ? { locked: true as const } : {}),
				}
			: own
				? {
						linkedAt: own.linkedAt.toISOString(),
						...(LOCKED.has(own.source) ? { locked: true as const } : {}),
					}
				: undefined;
		const step = this.#options.steps[prover.provider];
		return {
			provider: prover.provider,
			label: prover.label,
			...(step ? { step } : {}),
			requires: [...(prover.requires ?? [])],
			blockedBy: blocked,
			...(linked ? { linked } : {}),
			...(state.pending && !linked
				? {
						pending: {
							request: state.pending.request,
							expiresAt: state.pending.expiresAt.toISOString(),
							...(state.pending.redeemedBy
								? { redeemedBy: state.pending.redeemedBy }
								: {}),
						},
					}
				: {}),
		};
	}
}
