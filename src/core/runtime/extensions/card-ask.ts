import type {
	Approval,
	ApprovalDetails,
	ApprovalOptions,
	ApprovedBy,
	Prompts,
	PromptWait,
} from "../../interactions/prompts.ts";
import type { Tier } from "../../speakers.ts";
import type { Watch } from "./withdrawals.ts";

/** What a held call's card is opened with. */
export interface CardAsk {
	title: string;
	message: string;
	signal: AbortSignal | undefined;
	minTier: Tier | undefined;
	wait: PromptWait;
	details: ApprovalDetails;
	approvers: readonly string[] | undefined;
	/** Only the speaker may answer the card; see `HoldDescription`. */
	speakerOnly: boolean;
	/** The call's watch, when its plugin may withdraw it. */
	watch: Watch | undefined;
}

/** How a card came out: its answer, or `withdrawn` when the plugin took the call back first, and who approved it on which card. */
export interface CardAnswer {
	answer: Approval | "withdrawn";
	approvedBy?: ApprovedBy;
	approvedPrompt?: string;
}

/**
 * Opens the card and waits for the first of its answer and the plugin's withdrawal of the call;
 * the other changes nothing. A card that fails answers nothing, so its watch ends and the
 * failure goes on.
 */
export async function askOnCard(
	prompts: Prompts,
	ask: CardAsk,
): Promise<CardAnswer> {
	const found: Omit<CardAnswer, "answer"> = {};
	const options: ApprovalOptions = {
		...(ask.approvers ? { approvers: ask.approvers } : {}),
		...(ask.speakerOnly ? { speakerOnly: true } : {}),
		approvedBy: (by) => {
			found.approvedBy = by;
		},
		approvedPrompt: (prompt) => {
			found.approvedPrompt = prompt;
		},
		...(ask.watch ? { supersede: ask.watch.signal } : {}),
	};
	try {
		const asking = prompts.confirm(
			ask.title,
			ask.message,
			ask.signal,
			ask.minTier,
			ask.wait,
			ask.details,
			options,
		);
		// What the surface reports is read after the answer, never before it.
		if (!ask.watch) {
			const answer = await asking;
			return { ...found, answer };
		}
		asking.catch(() => undefined);
		const answer = await Promise.race([asking, ask.watch.whenWithdrawn]);
		return { ...found, answer };
	} catch (error) {
		ask.watch?.end();
		throw error;
	}
}
