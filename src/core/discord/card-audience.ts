import { messages } from "../i18n/index.ts";
import type { ApprovedBy, PromptScope } from "../interactions/prompts.ts";
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
	/**
	 * Who answered, as the approval reports them, for a user `allows` admitted; undefined when it
	 * cannot be read. Only an approval's audience has it.
	 */
	approver?(user: DiscordUser): Promise<ApprovedBy | undefined>;
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
 *
 * An approval that names `approvers`, where it escalates, is theirs instead of the speaker's:
 * each named principal answers on any of their Discord identities that is still theirs when they
 * press, at the tier it needs then, and the card mentions all of those identities. The speaker
 * does not answer it unless named. The owners still do, and are the whole audience when none of
 * the named has a Discord identity. Where the scope escalates to no one, the person is the only
 * one who answers, and only if named or an owner: any other person's card is not posted.
 */
export class CardAudiences {
	readonly #options: CardAudienceOptions;
	readonly #owners: DiscordOwners;

	constructor(options: CardAudienceOptions, owners: DiscordOwners) {
		this.#options = options;
		this.#owners = owners;
	}

	/** Who may approve a call held at `minTier`; undefined when no one may. */
	async approval(
		scope: PromptScope | undefined,
		minTier: Tier,
		named?: readonly string[],
	): Promise<Audience | undefined> {
		let approvers = named;
		// A private conversation's person is the only one who answers, so a call naming others is theirs only if named or an owner.
		if (approvers && scope?.escalate === "none") {
			if (!(await this.#mayAnswerPrivately(scope, approvers))) return undefined;
			approvers = undefined;
		}
		return this.#audience(
			scope,
			minTier,
			{
				note: messages().cardApproversNote,
				refusal: approvers
					? messages().cardNamedApproversRefusal
					: messages().cardApproversRefusal,
			},
			approvers,
		);
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
		approvers?: readonly string[],
	): Promise<Audience | undefined> {
		const { ownerId } = this.#options;
		const escalates = scope?.escalate !== "none";
		if (approvers && scope) {
			const named = await this.#approverIdentities(approvers);
			if (named.size > 0)
				return {
					allows: async (user) => {
						for (const [principalId, ids] of named)
							if (
								ids.includes(user.id) &&
								// Read the links again: one moved or unlinked since the card was posted is no longer theirs.
								(await this.#stillOwn(principalId, user.id)) &&
								(await this.#owners.holds(user, minTier, principalId))
							)
								return true;
						return this.#owners.isOwner(user);
					},
					mentions: [...new Set([...named.values()].flat())],
					note: words.note(...new Set([...named.values()].flat())),
					refusal: words.refusal,
					approver: (user) => this.#approver(user),
				};
		}
		const own =
			scope && !approvers && (await this.#ownIdentities(scope, minTier));
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
				approver: (user) => this.#approver(user),
			};
		}
		if (!escalates) return undefined;
		return {
			allows: (user) => this.#owners.isOwner(user),
			mentions: await this.#owners.ids(),
			note: "",
			refusal: messages().cardOwnerOnly,
			approver: (user) => this.#approver(user),
		};
	}

	/**
	 * The Discord identities of each named principal that has any, by principal id; a principal
	 * whose identities cannot be read, or who has none, is left out.
	 */
	async #approverIdentities(
		principals: readonly string[],
	): Promise<Map<string, string[]>> {
		const named = new Map<string, string[]>();
		for (const principalId of new Set(principals)) {
			const ids = await this.#discordIdentities(principalId);
			if (ids && ids.length > 0) named.set(principalId, ids);
		}
		return named;
	}

	/** Whether a private conversation's person may answer a call that names `approvers`: when named, or an owner. */
	async #mayAnswerPrivately(
		scope: PromptScope,
		approvers: readonly string[],
	): Promise<boolean> {
		return (
			approvers.includes(scope.principalId) ||
			scope.speakerId === this.#options.ownerId ||
			(await this.#owners.isOwnerPrincipal(scope.principalId))
		);
	}

	/** Who the user is as an approver: their principal, the name their identity goes by, and whether they are an owner. */
	async #approver(user: DiscordUser): Promise<ApprovedBy | undefined> {
		const owner = (await this.#owners.isOwner(user))
			? { owner: true as const }
			: {};
		const who = await this.#owners.speakerOf(user);
		if (who)
			return {
				principalId: who.principalId,
				speakerId: user.id,
				name: user.name,
				...owner,
			};
		// Without an identity service the primary owner is the only one who answers.
		return this.#options.identity
			? undefined
			: { principalId: user.id, speakerId: user.id, name: user.name, ...owner };
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
