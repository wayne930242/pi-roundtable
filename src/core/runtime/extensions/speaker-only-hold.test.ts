import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolTurn } from "../../define.ts";
import { type HoldRule, holdChain } from "../../holds.ts";
import type {
	Approval,
	ApprovalOptions,
	ApprovedBy,
	Prompts,
} from "../../interactions/prompts.ts";
import type { Speaker } from "../../speakers.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { MAIL } from "./confirmation-fixture.ts";
import { ConfirmationGate } from "./confirmation-gate.ts";

useTestLocale();
beforeAll(() => useTestLocale());

const SAM: Speaker = {
	id: "p_sam",
	name: "p_sam",
	tier: "member",
	principalId: "p_sam",
};

const turn = { speaker: SAM } as unknown as ToolTurn;
const inTurn = { toolTurn: () => turn };

/** A gate whose mail answers with `approval`, and names `approvers` when it does. */
function gateAnswering(approval: unknown, approvers?: readonly string[]) {
	const rule: HoldRule = {
		name: "mail",
		describe: (tool) => (tool === MAIL ? "send an email" : undefined),
		describeInTurn: (tool) =>
			tool === MAIL
				? ({ text: "send an email", approval } as never)
				: undefined,
		...(approvers ? { approversInTurn: () => approvers } : {}),
	};
	const gate = new ConfirmationGate(holdChain([rule]), OWNER);
	gate.beginTurn("s", false, undefined, SAM, false);
	return gate;
}

/** A card that records the options it was asked with and answers `answer`, reporting `by` when approved. */
function card(answer: Approval, by?: ApprovedBy) {
	const seen: (ApprovalOptions | undefined)[] = [];
	const prompts: Prompts = {
		confirm: async (_title, _message, _signal, _tier, _wait, _d, options) => {
			seen.push(options);
			if (answer === "approved" && by) options?.approvedBy?.(by);
			return answer;
		},
		ask: async () => undefined,
	};
	return { prompts, seen };
}

const decide = (gate: ConfirmationGate, prompts: Prompts) =>
	gate.decide(MAIL, { to: "a@b.c" }, { prompts, asker: "helper" }, inTurn);

describe('a hold that answers approval: "speaker"', () => {
	test("its card is asked speaker-only, and the speaker's press releases the call", async () => {
		const gate = gateAnswering("speaker");
		const { prompts, seen } = card("approved", {
			principalId: SAM.principalId,
			speakerId: SAM.id,
			name: SAM.name,
		});
		const result = await decide(gate, prompts);
		expect(seen[0]?.speakerOnly).toBe(true);
		expect(result.approvedOnCard).toBe(true);
		expect(result.approvedBy?.principalId).toBe(SAM.principalId);
	});

	test("a card it makes unavailable holds the call for a message, as any unavailable card does", async () => {
		const gate = gateAnswering("speaker");
		const { prompts } = card("unavailable");
		const result = await decide(gate, prompts);
		expect(result.refused).toBe("held");
		expect(result.approvedOnCard).toBeUndefined();
	});

	test("with approvers it asks speaker-only too, and a press by a speaker who is not named holds the call", async () => {
		const gate = gateAnswering("speaker", ["p_ada"]);
		const { prompts, seen } = card("approved", {
			principalId: SAM.principalId,
			speakerId: SAM.id,
			name: SAM.name,
		});
		const result = await decide(gate, prompts);
		expect(seen[0]?.speakerOnly).toBe(true);
		expect(seen[0]?.approvers).toEqual(["p_ada"]);
		expect(result.refused).toBe("held");
		expect(result.approvedOnCard).toBeUndefined();
	});

	test("with approvers it accepts the speaker's press when they are named", async () => {
		const gate = gateAnswering("speaker", [SAM.principalId]);
		const { prompts } = card("approved", {
			principalId: SAM.principalId,
			speakerId: SAM.id,
			name: SAM.name,
		});
		expect((await decide(gate, prompts)).approvedOnCard).toBe(true);
	});

	test.each([undefined, "owners", true])(
		'anything but "speaker" (%p) leaves the card as every card is',
		async (approval) => {
			const gate = gateAnswering(approval);
			const { prompts, seen } = card("approved");
			await decide(gate, prompts);
			expect(seen[0]).toBeDefined();
			expect(seen[0]?.speakerOnly).toBeUndefined();
		},
	);
});
