import type {
	HeldCall,
	PendingConfirmation,
} from "../../domain/conversation.ts";
import { type OwnerIdentity, ownerWords } from "../../identity.ts";
import type {
	ApprovalDetails,
	ApprovedBy,
} from "../../interactions/prompts.ts";
import type { Speaker } from "../../speakers.ts";
import { mayApproveNamed } from "./held-calls.ts";

/**
 * The speaker of a turn as the gate records them; `name` is what an approval by their message is
 * attributed to, and `tier` tells whether they approve as an owner.
 */
export type SpeakerRef = Pick<Speaker, "id" | "principalId"> & {
	name?: string;
	tier?: Speaker["tier"];
};

/** A call an approval released, and who gave it, when that is known. */
export interface Release {
	call: HeldCall;
	by?: ApprovedBy;
}

/** What a call needs of the gate: nothing, a hold, or a release that spends an approval. */
export type Needing =
	| {
			held: HeldCall;
			copy?: NonNullable<ApprovalDetails["copy"]>;
			/** Aborts when the plugin withdraws the call; see `HoldDescription`. */
			supersede?: AbortSignal;
	  }
	| { released: ApprovedBy | undefined };

/** A speaker as an approver; undefined without one. */
export function approverOf(
	speaker: SpeakerRef | undefined,
): ApprovedBy | undefined {
	if (!speaker) return undefined;
	return {
		principalId: speaker.principalId,
		speakerId: speaker.id,
		name: speaker.name ?? speaker.id,
		...(speaker.tier === "owner" ? { owner: true as const } : {}),
	};
}

/** What a turn waiting on a call its plugin withdrew is told: the call did not run and no approval will run it. */
export function withdrawn(call: HeldCall): {
	reason: string;
	refused: "withdrawn";
} {
	return {
		reason: `This action was withdrawn before it was approved: it would ${call.action}. It did not run, and an approval of it will not run it. Do not retry it; go on without it, or tell the owner it is no longer needed.`,
		refused: "withdrawn",
	};
}

/** The text for a held call that the speaker's own message confirms. */
export function askSpeaker(addressee: OwnerIdentity, call: HeldCall): string {
	const o = ownerWords(addressee);
	return `Held for ${o.name}'s confirmation: this would ${call.action}. Do not retry it in this turn. Tell ${o.him} exactly what will happen and ask ${o.him} to confirm; once ${o.he} agrees in ${o.his} next message, make the same call with the same input and it runs.`;
}

/**
 * For a call that names approvers the speaker is neither among nor an owner of: the text that
 * tells the model the truth about it, from the names of those who may approve; undefined when
 * the speaker may.
 */
export function unlessNamed(
	call: HeldCall,
	speaker: SpeakerRef | undefined,
	addressee: OwnerIdentity,
	isPrivate: boolean,
): ((names: string[], missing: boolean) => string) | undefined {
	if (!call.approverIds || mayApproveNamed(speaker, call)) return undefined;
	const o = ownerWords(addressee);
	const anyone = (call.approverIds?.length ?? 0) > 0;
	return (names, missing) => {
		// Names that could not be read still leave the people the tool named.
		const named =
			names.length === 0 && anyone
				? ["the people named for it"]
				: missing
					? [...names, "others named for it"]
					: names;
		const who = orList([...named, "an owner"]);
		const approval = `Only ${who} can approve it.`;
		if (isPrivate)
			return `Held, and ${o.name} cannot approve it here: this would ${call.action}. ${approval} A private conversation can only be answered by its person, so it stays held and nothing ${o.he} says here releases it. Do not retry it, and do not ask ${o.him} to confirm it or to say yes. Tell ${o.him} plainly that it was not done and needs ${who}.`;
		return `Held, and ${o.name} cannot approve it: this would ${call.action}. ${approval} Do not retry it in this turn, and do not ask ${o.name} to confirm it. Tell ${o.him} plainly that it was not done, and ask ${who} to confirm in this channel; once one of them agrees in a message, make the same call with the same input and it runs.`;
	};
}

/** The names of the principals, as far as they are known; ids are never shown. `missing` says some could not be read. */
export async function namesOf(
	nameOf: ((principalId: string) => Promise<string | undefined>) | undefined,
	principalIds: readonly string[],
): Promise<{ names: string[]; missing: boolean }> {
	if (!nameOf) return { names: [], missing: principalIds.length > 0 };
	const names = await Promise.all(
		[...new Set(principalIds)].map(async (id) => {
			try {
				return await nameOf(id);
			} catch {
				return undefined;
			}
		}),
	);
	return {
		names: [...new Set(names.filter((name): name is string => !!name))],
		missing: names.some((name) => !name),
	};
}

/**
 * The pending hold with `call` added: a partial release kept calls that name approvers, which
 * belong to no speaker, so what this turn holds is its speaker's from now.
 */
export function remembered(
	current: PendingConfirmation | undefined,
	kept: PendingConfirmation | undefined,
	selectionId: string,
	speaker: SpeakerRef | undefined,
	call: HeldCall,
): PendingConfirmation {
	// A partial release kept calls that name approvers, which belong to no speaker: what this turn
	// holds is its speaker's, from now.
	let pending = current;
	if (pending && pending === kept) {
		pending = { ...pending, calls: [...pending.calls] };
		pending.selectionId = selectionId;
		pending.heldAt = new Date();
		delete pending.speakerId;
		delete pending.principalId;
		if (speaker) {
			pending.speakerId = speaker.id;
			pending.principalId = speaker.principalId;
		}
	}
	pending ??= {
		selectionId,
		heldAt: new Date(),
		calls: [],
		...(speaker
			? {
					speakerId: speaker.id,
					principalId: speaker.principalId,
				}
			: {}),
	};
	if (
		!pending.calls.some((c) => c.tool === call.tool && c.input === call.input)
	)
		pending.calls.push(call);
	return pending;
}

/** "a", "a or b", "a, b or c". */
function orList(items: readonly string[]): string {
	const last = items.at(-1);
	if (items.length < 2 || last === undefined) return items.join("");
	return `${items.slice(0, -1).join(", ")} or ${last}`;
}
