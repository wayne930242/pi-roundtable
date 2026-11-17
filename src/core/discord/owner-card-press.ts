import { type Interaction, MessageFlags } from "discord.js";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../kernel/log.ts";
import type { DiscordUser } from "./discord-owners.ts";
import type { Answerer, OpenCard } from "./owner-card-types.ts";

const ephemeral = (content: string) => ({
	content,
	flags: MessageFlags.Ephemeral as const,
});

/** The interaction methods one of which is a press's first response to Discord. */
const RESPONSES = [
	"reply",
	"update",
	"showModal",
	"deferUpdate",
	"deferReply",
] as const;

/**
 * Calls `first` once, as the press makes its first response to Discord, whichever it is. Discord
 * drops a press with no response within three seconds ("This interaction failed"), so this is
 * what the card's press log times.
 */
export function onFirstResponse(
	interaction: Interaction,
	first: () => void,
): void {
	let called = false;
	const target = interaction as unknown as Record<string, unknown>;
	for (const name of RESPONSES) {
		const method = target[name];
		if (typeof method !== "function") continue;
		target[name] = (...args: unknown[]) => {
			if (!called) {
				called = true;
				first();
			}
			return (method as (...a: unknown[]) => unknown).apply(interaction, args);
		};
	}
}

/**
 * Approve or Decline on an approval card. The press is deferred before the audience and the
 * approver are read, which may take a while; someone else is told so and the card is unchanged.
 */
export async function answerApproval(
	card: OpenCard,
	approved: boolean,
	interaction: Interaction,
	user: DiscordUser,
	by: Answerer,
	logger: Logger,
): Promise<void> {
	if (!interaction.isButton()) return;
	await interaction.deferUpdate();
	if (!(await card.audience.allows(user))) {
		await interaction.followUp(ephemeral(card.audience.refusal));
		return;
	}
	const approver = approved
		? await card.audience.approver?.(user).catch((error: unknown) => {
				logger.warn(
					{ err: error },
					"could not tell who approved; the call runs without an approver",
				);
				return undefined;
			})
		: undefined;
	const accepted = card.end(
		approved ? "approved" : "declined",
		approver ? { ...by, approver } : by,
	);
	// The plugin withdrew the call, or another press answered, while this one was being checked.
	if (!accepted) {
		await interaction.followUp(ephemeral(messages().cardInactive));
		return;
	}
	await interaction.editReply(
		card.view(
			approved
				? (card.outcomes?.approved ?? messages().cardApproved)
				: (card.outcomes?.declined ?? messages().cardDeclined),
		),
	);
}

/** A question card's Cancel, deferred before the audience is read. */
export async function cancelQuestion(
	card: OpenCard,
	interaction: Interaction,
	user: DiscordUser,
): Promise<void> {
	if (!interaction.isButton()) return;
	await interaction.deferUpdate();
	if (!(await card.audience.allows(user))) {
		await interaction.followUp(ephemeral(card.audience.refusal));
		return;
	}
	// Another press, a stop or a withdrawal ended it while this one was being checked.
	if (!card.decline()) {
		await interaction.followUp(ephemeral(messages().cardInactive));
		return;
	}
	await interaction.editReply(card.view(messages().cardQuestionCancelled));
}
