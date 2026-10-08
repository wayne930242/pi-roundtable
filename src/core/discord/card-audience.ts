import { messages } from "../i18n/index.ts";
import type { PromptScope } from "../interactions/prompts.ts";
import { type Tier, tierAtLeast } from "../speakers.ts";
import type {
	DiscordOwners,
	DiscordOwnersOptions,
	DiscordUser,
} from "./discord-owners.ts";

/** The people a card is for. */
export interface Audience {
	/** Whether this user may answer, as they are when they press. */
	allows(user: DiscordUser): Promise<boolean>;
	/** The users the card mentions in a thread, in order. */
	mentions: readonly string[];
	/** Shown on the card; empty for none. */
	note: string;
	/** What someone else who presses it is told. */
	refusal: string;
}

/** The primary owner, who answers every card the owners may, and who else holds a tier. */
export type CardAudienceOptions = DiscordOwnersOptions;

/**
 * Whom a card is for, by the prompt scope of the turn that asks. The speaker's principal answers
 * their own card on any of their Discord identities that is still theirs when they press when,
 * for an approval, they hold its tier, checked again then, and, for an owner-tier one, they are
 * an owner; the card mentions the identity that spoke where it is one of those, or else all of
 * them. Where the scope
 * escalates to the owners, every owner with a Discord identity answers it too, and a card the
 * speaker cannot answer, or whose principal has no Discord identity, is theirs alone; where it
 * escalates to no one, that card goes to no one. Without a scope, a card is the owners'.
 */
export class CardAudiences {
	readonly #options: CardAudienceOptions;
	readonly #owners: DiscordOwners;

	constructor(options: CardAudienceOptions, owners: DiscordOwners) {
		this.#options = options;
		this.#owners = owners;
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
		words: { note(...userIds: string[]): string; refusal: string },
	): Promise<Audience | undefined> {
		const { ownerId } = this.#options;
		const escalates = scope?.escalate !== "none";
		const own = scope && (await this.#ownIdentities(scope, minTier));
		if (scope && own) {
			const primary = own.includes(ownerId);
			const mentions = own.includes(scope.speakerId) ? [scope.speakerId] : own;
			return {
				allows: async (user) => {
					// Read the links again: one moved or unlinked since the card was posted is no longer theirs.
					if (
						own.includes(user.id) &&
						(await this.#stillOwn(scope.principalId, user.id))
					)
						return (
							(primary && user.id === ownerId) ||
							this.#owners.holds(user, minTier, scope.principalId)
						);
					return escalates && this.#owners.isOwner(user);
				},
				mentions,
				note: primary ? "" : words.note(...mentions),
				refusal: primary ? messages().cardOwnerOnly : words.refusal,
			};
		}
		if (!escalates) return undefined;
		return {
			allows: (user) => this.#owners.isOwner(user),
			mentions: await this.#owners.ids(),
			note: "",
			refusal: messages().cardOwnerOnly,
		};
	}

	/** Whether the Discord user is still one of the principal's identities; false when that cannot be read. */
	async #stillOwn(principalId: string, userId: string): Promise<boolean> {
		return (
			(await this.#discordIdentities(principalId))?.includes(userId) ?? false
		);
	}

	/** The principal's Discord user ids; undefined, and logged, when they cannot be read. */
	async #discordIdentities(principalId: string): Promise<string[] | undefined> {
		const { identity, logger } = this.#options;
		if (!identity) return undefined;
		try {
			return (await identity.identities(principalId))
				.filter((link) => link.provider === "discord")
				.map((link) => link.subject);
		} catch (error) {
			logger.warn(
				{ principal: principalId, err: error },
				"could not read the speaker's identities; none counts as theirs, so their card is the owners'",
			);
			return undefined;
		}
	}

	/**
	 * The Discord identities of the scope's principal when they may answer their own card: at the
	 * tier it needs and, for an owner-tier call, an owner; undefined when they may not, or have
	 * none.
	 */
	async #ownIdentities(
		scope: PromptScope,
		minTier: Tier | undefined,
	): Promise<string[] | undefined> {
		if (
			!this.#options.identity ||
			(minTier && !tierAtLeast(scope.tier, minTier))
		)
			return undefined;
		// A turn whose tier defaulted to owner is not an owner's: its owner-tier call is the owners'.
		if (
			minTier === "owner" &&
			!(await this.#owners.isOwnerPrincipal(scope.principalId))
		)
			return undefined;
		const own = await this.#discordIdentities(scope.principalId);
		return own && own.length > 0 ? own : undefined;
	}
}
