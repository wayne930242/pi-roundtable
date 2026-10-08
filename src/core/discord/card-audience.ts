import { messages } from "../i18n/index.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { PromptScope } from "../interactions/prompts.ts";
import type { Logger } from "../log.ts";
import { type Tier, tierAtLeast } from "../speakers.ts";

/** Who pressed a card's control; their roles are unknown where the press carries no member. */
export interface CardUser {
	id: string;
	name: string;
	roleIds?: readonly string[];
}

/** The people a card is for. */
export interface Audience {
	/** Whether this user may answer, as they are when they press. */
	allows(user: CardUser): Promise<boolean>;
	/** The users the card mentions in a thread, in order. */
	mentions: readonly string[];
	/** Shown on the card; empty for none. */
	note: string;
	/** What someone else who presses it is told. */
	refusal: string;
}

export interface CardAudienceOptions {
	/** The primary owner's Discord user id, who answers every card the owners may. */
	ownerId: string;
	/** Who holds a tier and which owners have a Discord identity; without it only the primary owner answers. */
	identity?: Pick<IdentityService, "resolve" | "owners" | "identities">;
	logger: Logger;
}

/**
 * Whom a card is for, by the prompt scope of the turn that asks. The speaker answers their own
 * card when they are a Discord person of their principal and, for an approval, hold its tier,
 * checked again when they press. Where the scope escalates to the owners, every owner with a
 * Discord identity answers it too, and a card the speaker cannot answer is theirs alone; where it
 * escalates to no one, that card goes to no one. Without a scope, a card is the owners'.
 */
export class CardAudiences {
	readonly #options: CardAudienceOptions;

	constructor(options: CardAudienceOptions) {
		this.#options = options;
	}

	/** Who may approve a call held at `minTier`; undefined when no one may. */
	approval(
		scope: PromptScope | undefined,
		minTier: Tier,
	): Promise<Audience | undefined> {
		return this.#audience(scope, minTier, {
			note: messages().cardApproversNote,
			refusal: messages().cardApproversRefusal,
		});
	}

	/** Who may answer a question; undefined when no one may. */
	question(scope: PromptScope | undefined): Promise<Audience | undefined> {
		return this.#audience(scope, undefined, {
			note: messages().cardAskerNote,
			refusal: messages().cardAskerRefusal,
		});
	}

	async #audience(
		scope: PromptScope | undefined,
		minTier: Tier | undefined,
		words: { note(userId: string): string; refusal: string },
	): Promise<Audience | undefined> {
		const { ownerId } = this.#options;
		const escalates = scope?.escalate !== "none";
		if (scope && (await this.#answersOwn(scope, minTier))) {
			const primary = scope.speakerId === ownerId;
			return {
				allows: async (user) => {
					if (user.id === scope.speakerId)
						return primary || this.#holds(user, minTier);
					return escalates && this.#isOwner(user);
				},
				mentions: [scope.speakerId],
				note: primary ? "" : words.note(scope.speakerId),
				refusal: primary ? messages().cardOwnerOnly : words.refusal,
			};
		}
		if (!escalates) return undefined;
		return {
			allows: (user) => this.#isOwner(user),
			mentions: await this.#ownerIds(),
			note: "",
			refusal: messages().cardOwnerOnly,
		};
	}

	/** Whether the scope's speaker may answer their own card: a Discord person of their principal, at the tier it needs. */
	async #answersOwn(
		scope: PromptScope,
		minTier: Tier | undefined,
	): Promise<boolean> {
		const { identity, logger } = this.#options;
		if (!identity || (minTier && !tierAtLeast(scope.tier, minTier)))
			return false;
		try {
			const links = await identity.identities(scope.principalId);
			return links.some(
				(link) =>
					link.provider === "discord" && link.subject === scope.speakerId,
			);
		} catch (error) {
			logger.warn(
				{ principal: scope.principalId, err: error },
				"could not read the speaker's identities; their card goes to the owners",
			);
			return false;
		}
	}

	/** The primary owner, then every other owner's Discord user ids. */
	async #ownerIds(): Promise<string[]> {
		const { ownerId, identity, logger } = this.#options;
		if (!identity) return [ownerId];
		const ids = new Set([ownerId]);
		try {
			for (const owner of await identity.owners())
				for (const link of await identity.identities(owner.id))
					if (link.provider === "discord") ids.add(link.subject);
		} catch (error) {
			logger.warn(
				{ err: error },
				"could not read the owners' identities; the card goes to the primary owner",
			);
		}
		return [...ids];
	}

	/** Whether the user is an owner now: the primary owner, or another owner's Discord identity at the owner tier. */
	async #isOwner(user: CardUser): Promise<boolean> {
		if (user.id === this.#options.ownerId) return true;
		// Only an owner's own identity is resolved, so a stranger's press admits no one.
		if (!(await this.#ownerIds()).includes(user.id)) return false;
		return this.#holds(user, "owner");
	}

	/** Whether the user holds `minTier` as they press; a question needs none. */
	async #holds(user: CardUser, minTier: Tier | undefined): Promise<boolean> {
		const { identity } = this.#options;
		if (!minTier) return true;
		if (!identity) return false;
		const who = await identity.resolve({
			provider: "discord",
			subject: user.id,
			name: user.name,
			surface: "discord",
			...(user.roleIds
				? { roles: user.roleIds.map((role) => `discord:role:${role}`) }
				: {}),
			legacyId: user.id,
		});
		return who !== undefined && tierAtLeast(who.tier, minTier);
	}
}
