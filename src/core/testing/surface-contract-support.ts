import type { InboundMessage } from "../contract/channels.ts";
import {
	type Approval,
	type ApprovedBy,
	type PromptScope,
	promptScope,
} from "../interactions/prompts.ts";
import type { Speaker } from "../speakers.ts";
import type {
	SurfaceContractAnswerer,
	SurfaceContractSubject,
	SurfaceObservation,
} from "./surface-contract.ts";

export interface Running {
	subject: SurfaceContractSubject;
	delivered: InboundMessage[];
}

export class ContractBroken extends Error {
	override name = "ContractBroken";
}

export function expectThat(condition: boolean, message: string): void {
	if (!condition) throw new ContractBroken(message);
}

export async function until(
	done: () => boolean,
	what: string,
	ms = 2000,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (!done()) {
		if (Date.now() > deadline)
			throw new ContractBroken(`timed out waiting until ${what}`);
		await Bun.sleep(5);
	}
}

export const seen = (running: Running, kind: SurfaceObservation["kind"]) =>
	running.subject.observations().filter((o) => o.kind === kind);

export const speakerOf = (subject: SurfaceContractSubject): Speaker =>
	subject.speaker ?? {
		id: "contract-speaker",
		name: "Ada",
		tier: "owner",
		principalId: "contract-speaker",
	};

/** The person's prompt scope in a conversation of this visibility. */
export const scopeOf = (
	subject: SurfaceContractSubject,
	visibility: "private" | "shared" = "shared",
): PromptScope => promptScope(speakerOf(subject), visibility);

/** The newest prompt the person has seen, once one more than `before` is open. */
export async function nextPrompt(
	running: Running,
	before: number,
): Promise<string> {
	await until(
		() => seen(running, "prompt").length > before,
		"the person sees the approval",
	);
	const prompt = seen(running, "prompt").at(-1);
	if (prompt?.kind !== "prompt") throw new ContractBroken("no prompt seen");
	return prompt.id;
}

/** Asks for one approval and answers it as the person does. */
export async function approval(running: Running, approved: boolean) {
	const { surface, channel, answer } = running.subject;
	const prompts = surface.prompts?.(channel, scopeOf(running.subject));
	if (!prompts || !answer)
		throw new ContractBroken("the surface shows no prompts");
	const before = seen(running, "prompt").length;
	const result = prompts.confirm(
		"Approve?",
		"Send the report.",
		undefined,
		speakerOf(running.subject).tier,
	);
	await answer(await nextPrompt(running, before), approved);
	return result;
}

/**
 * Opens the person's approval in a conversation of `visibility`, has `other` answer it by its id,
 * and checks that only the person's own answer settles it.
 */
export async function answeredOnlyByThem(
	running: Running,
	other: SurfaceContractAnswerer | undefined,
	visibility: "private" | "shared",
	approvers?: readonly string[],
): Promise<void> {
	const { surface, channel, answer } = running.subject;
	const prompts = surface.prompts?.(
		channel,
		scopeOf(running.subject, visibility),
	);
	if (!prompts || !answer || !other)
		throw new ContractBroken("the surface shows no prompts");
	await other.join?.();
	const before = seen(running, "prompt").length;
	let settled: Approval | undefined;
	const result = prompts
		.confirm(
			"Approve?",
			"Send the report.",
			undefined,
			speakerOf(running.subject).tier,
			undefined,
			undefined,
			approvers ? { approvers } : undefined,
		)
		.then((value) => {
			settled = value;
			return value;
		});
	const id = await nextPrompt(running, before);
	await other.answer(id, true);
	await Bun.sleep(50);
	expectThat(
		settled === undefined,
		`another principal's answer settled the approval as ${settled}`,
	);
	await answer(id, false);
	const own = await result;
	expectThat(own === "declined", `the person's answer came back ${own}`);
}

/**
 * Opens the person's approval in a shared conversation naming the approver, and checks that
 * another person and the person themselves cannot answer it, and the approver can, who is then
 * reported as the approver.
 */
export async function namedApproverAnswers(running: Running): Promise<void> {
	const { surface, channel, answer, stranger, approver } = running.subject;
	const prompts = surface.prompts?.(channel, scopeOf(running.subject));
	if (!prompts || !answer || !stranger || !approver)
		throw new ContractBroken("the surface shows no prompts");
	await stranger.join?.();
	await approver.join?.();
	const before = seen(running, "prompt").length;
	let settled: Approval | undefined;
	let reported: ApprovedBy | undefined;
	const result = prompts
		.confirm(
			"Approve?",
			"Send the report.",
			undefined,
			speakerOf(running.subject).tier,
			undefined,
			undefined,
			{
				approvers: [approver.principalId],
				approvedBy: (by) => {
					reported = by;
				},
			},
		)
		.then((value) => {
			settled = value;
			return value;
		});
	const id = await nextPrompt(running, before);
	await stranger.answer(id, true);
	await Bun.sleep(50);
	expectThat(
		settled === undefined,
		`another person's answer settled the named approver's approval as ${settled}`,
	);
	await answer(id, true);
	await Bun.sleep(50);
	expectThat(
		settled === undefined,
		`the speaker's answer settled an approval that names others as ${settled}`,
	);
	await approver.answer(id, true);
	const own = await result;
	expectThat(own === "approved", `the approver's answer came back ${own}`);
	// The runtime accepts an approval of a call that names approvers only from one it names.
	expectThat(
		reported !== undefined,
		"the approval did not report who approved it through approvedBy",
	);
	expectThat(
		reported?.principalId === approver.principalId,
		`the approval reported ${reported?.principalId} as its approver, not ${approver.principalId}`,
	);
}
