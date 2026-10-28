import type { HeldCall } from "../../domain/conversation.ts";
import type { TurnRequest } from "../../domain/ports.ts";
import { SYSTEM_PRINCIPAL } from "../../identity/principal-store.ts";
import type { ApprovedBy } from "../../interactions/prompts.ts";
import { type Autonomy, DEFAULT_AUTONOMY } from "../../modes/autonomy.ts";
import type { ConversationModes } from "../../modes/conversation-modes.ts";
import { YOLO_CARDED_SHELL_CLASSES } from "../../modules/host-shell/shell-policy.ts";
import type { ChannelKey } from "../../sessions.ts";
import type { PiAgentRuntimeOptions } from "../runtime-types.ts";
import type { AutoApprover } from "./confirmation-gate.ts";
import type { SpeakerRef } from "./gate-refusals.ts";

/** What a turn's yolo approver needs to know. */
export interface YoloSeams {
	/** The conversations' modes: read when a call is held, and told of each approval. */
	modes: Pick<ConversationModes, "peek" | "autoApproved">;
	/** The classes yolo may approve although it cards them by default, and those it never approves. */
	autonomy: Pick<Autonomy, "yolo">;
	/** The conversation the turn runs in, whose yolo mode decides. */
	channel: ChannelKey;
	/** Who spoke the turn: only an owner other than the host's own principal is acted for. */
	speaker: SpeakerRef;
	/** The clock, for the time of an approval. */
	now?: () => Date;
}

/** The rule a class belongs to: the part before its first dot, or the whole of a rule's own name. */
function ruleOf(id: string): string {
	const dot = id.indexOf(".");
	return dot === -1 ? id : id.slice(0, dot);
}

/** The auto-approver of a turn on a runtime built with `options.modes`; undefined without them. */
export function turnYolo(
	options: Pick<PiAgentRuntimeOptions, "modes" | "autonomy">,
	request: Pick<TurnRequest, "channel" | "speaker">,
): AutoApprover | undefined {
	const { modes } = options;
	return modes
		? yoloApprover({
				modes,
				autonomy: options.autonomy ?? DEFAULT_AUTONOMY,
				channel: request.channel,
				speaker: request.speaker,
			})
		: undefined;
}

/**
 * The auto-approver of one turn in a yolo conversation: it answers for a held call, so that no
 * card opens, only when all of these hold at the time of the call:
 * - the conversation's yolo mode is on (read now, so a card opened before the toggle stays open);
 * - the turn's speaker is an owner, and not the host's own principal, which the webhook and report
 *   turns speak as;
 * - the call names no approvers and its card is not the speaker's alone;
 * - the call has classes (a call without them is unknown, so a person decides), and none of them
 *   is carded: not `autonomy.yolo.card`, not one of its rules named there, and not a class in
 *   `YOLO_CARDED_SHELL_CLASSES` that `autonomy.yolo.allow` leaves out.
 * It reports who approved as the speaker, marked `auto: "yolo"`, and tells the modes, which log it.
 */
export function yoloApprover(seams: YoloSeams): AutoApprover {
	const { modes, autonomy, channel, speaker } = seams;
	const allow = new Set(autonomy.yolo.allow);
	const card = new Set(autonomy.yolo.card);
	const carded = new Set(YOLO_CARDED_SHELL_CLASSES);
	const approves = (id: string) =>
		!card.has(id) &&
		!card.has(ruleOf(id)) &&
		(!carded.has(id) || allow.has(id));
	return (call: HeldCall, { speakerOnly }): ApprovedBy | undefined => {
		if (!modes.peek(channel).yolo) return undefined;
		if (speaker.tier !== "owner" || speaker.principalId === SYSTEM_PRINCIPAL)
			return undefined;
		if (call.approverIds !== undefined || speakerOnly) return undefined;
		const classes = call.holdClasses;
		if (!classes || classes.length === 0 || !classes.every(approves))
			return undefined;
		modes.autoApproved({
			channel,
			tool: call.tool,
			action: call.action,
			classes: [...classes],
			principalId: speaker.principalId,
			at: (seams.now ?? (() => new Date()))(),
		});
		return {
			principalId: speaker.principalId,
			speakerId: speaker.id,
			name: speaker.name ?? speaker.id,
			owner: true,
			auto: "yolo",
		};
	};
}
