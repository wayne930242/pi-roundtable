import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ToolTurn } from "../../define.ts";
import { holdChain } from "../../holds.ts";
import type {
	Approval,
	ApprovedBy,
	Prompts,
	PromptWait,
} from "../../interactions/prompts.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { MAIL, MAIL_RULE } from "./confirmation-fixture.ts";
import { ConfirmationGate } from "./confirmation-gate.ts";
import type { SpeakerRef } from "./gate-refusals.ts";
import { LATE_RELEASE_TTL_MS } from "./late-releases.ts";

const send = { to: "a@b.c", subject: "hi" };

const riley: ApprovedBy = {
	principalId: "p_riley",
	speakerId: "s_riley",
	name: "Riley",
};

const speaker = (
	principalId: string,
	tier?: SpeakerRef["tier"],
): SpeakerRef => ({
	id: `s_${principalId}`,
	principalId,
	...(tier ? { tier } : {}),
});

/** A gate whose mail call waits on a card the turn stops waiting for, then is answered late by Riley. */
async function lateApproved(
	holds = holdChain([MAIL_RULE]),
	approvedBy?: ApprovedBy,
) {
	const gate = new ConfirmationGate(holds, OWNER);
	gate.beginTurn(
		"workspace",
		false,
		undefined,
		speaker("p_asker"),
		false,
		undefined,
		true,
	);
	const waits: PromptWait[] = [];
	const prompts: Prompts = {
		confirm: async (_title, _message, _signal, _tier, wait) => {
			if (wait) waits.push(wait);
			return "pending" satisfies Approval;
		},
		ask: async () => undefined,
	};
	await gate.decide(MAIL, send, { prompts, asker: "infra" });
	gate.endTurn();
	waits[0]?.late({
		kind: "approval",
		approved: true,
		by: "Riley",
		...(approvedBy ? { approvedBy } : {}),
	});
	return gate;
}

afterEach(() => setSystemTime());

describe("a late approval's release", () => {
	test("is spent by a turn of the person who gave it, once", async () => {
		const gate = await lateApproved(undefined, riley);
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toBeUndefined();
		expect(gate.hold(MAIL, send)).toContain("Held");
	});

	test("is spent by an owner's turn", async () => {
		const gate = await lateApproved(undefined, riley);
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_boss", "owner"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toBeUndefined();
	});

	test("is not spent by another speaker's turn, and waits for the right one", async () => {
		const gate = await lateApproved(undefined, riley);
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_other"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toContain("Held");
		gate.endTurn();
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toBeUndefined();
	});

	test("is not spent by an automatic turn of its giver (schedule, agent message, report), which shows the card again", async () => {
		const gate = await lateApproved(undefined, riley);
		gate.beginTurn("workspace", false, undefined, speaker("p_riley"));
		expect(gate.hold(MAIL, send)).toContain("Held");
		gate.endTurn();
		gate.beginTurn("workspace", false, undefined, speaker("p_boss", "owner"));
		expect(gate.hold(MAIL, send)).toContain("Held");
		gate.endTurn();
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toBeUndefined();
	});

	test("is never spent by the system principal, even in a message-started turn", async () => {
		const gate = await lateApproved();
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("system", "owner"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toContain("Held");
	});

	test("is not spent by a turn without a speaker; the approver's later turn spends it", async () => {
		const gate = await lateApproved(undefined, riley);
		gate.beginTurn("workspace", false, undefined, undefined);
		expect(gate.hold(MAIL, send)).toContain("Held");
		gate.endTurn();
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toBeUndefined();
	});

	test("is not spent by a turn without a speaker when the giver is unknown", async () => {
		const gate = await lateApproved();
		gate.beginTurn("workspace", false, undefined, undefined);
		expect(gate.hold(MAIL, send)).toContain("Held");
	});

	test("is anyone's when the surface does not say who gave it", async () => {
		const gate = await lateApproved();
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_other"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toBeUndefined();
	});

	test("is not spent after its time is up", async () => {
		const gate = await lateApproved(undefined, riley);
		setSystemTime(new Date(Date.now() + LATE_RELEASE_TTL_MS + 1_000));
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toContain("Held");
	});

	test("is spent within its time", async () => {
		const gate = await lateApproved(undefined, riley);
		setSystemTime(new Date(Date.now() + LATE_RELEASE_TTL_MS - 1_000));
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toBeUndefined();
	});

	test("is dropped when the identical call runs without a hold", async () => {
		let unheld = false;
		const holds = holdChain([
			{
				name: "mail",
				describe: (tool, input) =>
					unheld ? undefined : MAIL_RULE.describe(tool, input, {}),
			},
		]);
		const gate = await lateApproved(holds, riley);
		unheld = true;
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toBeUndefined();
		unheld = false;
		gate.endTurn();
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		expect(gate.hold(MAIL, send)).toContain("Held");
	});

	test("is kept when a different call runs without a hold", async () => {
		const gate = await lateApproved(undefined, riley);
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		expect(gate.hold("other-tool", send)).toBeUndefined();
		expect(gate.hold(MAIL, send)).toBeUndefined();
	});

	test("is dropped when a hold that looks things up lets the identical call run", async () => {
		let unheld = false;
		const holds = holdChain([
			{
				name: "mail",
				describe: (tool, input) => MAIL_RULE.describe(tool, input, {}),
				describeInTurn: async (tool, input) =>
					unheld ? undefined : MAIL_RULE.describe(tool, input, {}),
			},
		]);
		const gate = await lateApproved(holds, riley);
		unheld = true;
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		const turn = { toolTurn: () => ({}) as ToolTurn };
		expect(
			(await gate.decide(MAIL, send, undefined, turn)).reason,
		).toBeUndefined();
		unheld = false;
		gate.endTurn();
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		expect((await gate.decide(MAIL, send, undefined, turn)).reason).toContain(
			"Held",
		);
	});

	test("does not spare a colleague's identical call its card", async () => {
		const gate = await lateApproved(undefined, riley);
		const cards: string[] = [];
		const prompts: Prompts = {
			confirm: async (_title, message) => {
				cards.push(message);
				return "declined" satisfies Approval;
			},
			ask: async () => undefined,
		};
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_colleague"),
			false,
			undefined,
			true,
		);
		const colleague = await gate.decide(MAIL, send, {
			prompts,
			asker: "infra",
		});
		expect(cards).toHaveLength(1);
		expect(colleague.approvedBy).toBeUndefined();
		expect(colleague.reason).toBeDefined();
		gate.endTurn();
		// The release is still Riley's, for the call it was granted for.
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_riley"),
			false,
			undefined,
			true,
		);
		const rileys = await gate.decide(MAIL, send, { prompts, asker: "infra" });
		expect(cards).toHaveLength(1);
		expect(rileys.reason).toBeUndefined();
		expect(rileys.approvedBy).toMatchObject({ principalId: "p_riley" });
	});
});
