import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolTurn } from "../../define.ts";
import { type HoldRule, holdChain } from "../../holds.ts";
import type { Approval, Prompts } from "../../interactions/prompts.ts";
import type { Speaker } from "../../speakers.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { MAIL } from "./confirmation-fixture.ts";
import { ConfirmationGate } from "./confirmation-gate.ts";
import { CONFIRMATION_TTL_MS } from "./held-calls.ts";

useTestLocale();
beforeAll(() => useTestLocale());

const person = (principalId: string, tier: Speaker["tier"] = "member") =>
	({ id: principalId, name: principalId, tier, principalId }) satisfies Speaker;
const SAM = person("p_sam");

const NAMES: Record<string, string> = { p_ada: "Ada", p_bo: "Bo" };
const nameOf = async (id: string) => NAMES[id];

/** A turn as a hold sees it. */
const turn = { speaker: SAM } as unknown as ToolTurn;
const inTurn = { toolTurn: () => turn };

/** A gate whose mail names `approvers`, when it does, and otherwise lets the speaker approve. */
function gateNaming(
	approvers: readonly string[] | undefined,
	lookup: ((id: string) => Promise<string | undefined>) | null = nameOf,
) {
	const rule: HoldRule = {
		name: "mail",
		describe: (tool, input) =>
			tool === MAIL ? `send an email to ${String(input.to)}` : undefined,
		approversInTurn: (_tool, input) =>
			input.to === "a@b.c" ? approvers : undefined,
	};
	return new ConfirmationGate(
		holdChain([rule]),
		OWNER,
		undefined,
		{},
		undefined,
		undefined,
		undefined,
		lookup ?? undefined,
	);
}

const answering = (answer: Approval): Prompts => ({
	confirm: async () => answer,
	ask: async () => undefined,
});

const send = { to: "a@b.c" };

describe("what a speaker who cannot approve a call that names approvers is told (RV2-F001)", () => {
	test("in a private conversation: who may approve it by name, that here cannot, and not to retry or ask", async () => {
		const gate = gateNaming(["p_ada", "p_bo"]);
		gate.beginTurn("s", false, undefined, SAM, true);
		const { reason, refused } = await gate.decide(
			MAIL,
			send,
			{ prompts: answering("approved"), asker: "Sam" },
			inTurn,
		);
		expect(refused).toBe("held");
		expect(reason).toContain("Only Ada, Bo or an owner can approve it");
		expect(reason).toContain("cannot approve it here");
		expect(reason).toContain("Do not retry it");
		expect(reason).toContain("do not ask");
		expect(reason).not.toContain("p_ada");
		expect(reason).not.toContain("make the same call");
		// A yes from the same person releases nothing.
		gate.endTurn();
		expect(gate.releasable(SAM)?.calls).toEqual([]);
		gate.beginTurn("s2", true, undefined, SAM, true);
		const again = await gate.decide(MAIL, send, undefined, inTurn);
		expect(again.refused).toBe("held");
		expect(again.reason).not.toContain("make the same call");
		expect(gate.pending()?.calls).toHaveLength(1);
	});

	test("in a shared conversation whose card expired: a named approver or an owner is to confirm in the channel", async () => {
		const gate = gateNaming(["p_ada"]);
		gate.beginTurn("s", false, undefined, SAM);
		const { reason, refused } = await gate.decide(
			MAIL,
			send,
			{ prompts: answering("expired"), asker: "Sam" },
			inTurn,
		);
		expect(refused).toBe("expired");
		expect(reason).toContain("Only Ada or an owner can approve it");
		expect(reason).toContain("ask Ada or an owner to confirm in this channel");
		expect(reason).toContain("do not ask Riley to confirm");
		expect(reason).not.toContain("Held for");
	});

	test("without prompts, the same", async () => {
		const gate = gateNaming(["p_ada"]);
		gate.beginTurn("s", false, undefined, SAM);
		const { reason } = await gate.decide(MAIL, send, undefined, inTurn);
		expect(reason).toContain("Only Ada or an owner can approve it");
		expect(reason).not.toContain("Held for");
	});

	test("a name that cannot be read beside one that can is still counted (RV3-F003)", async () => {
		const gate = gateNaming(["p_ada", "p_zed"]);
		gate.beginTurn("s", false, undefined, SAM, true);
		const { reason } = await gate.decide(
			MAIL,
			send,
			{ prompts: answering("approved"), asker: "Sam" },
			inTurn,
		);
		expect(reason).toContain(
			"Only Ada, others named for it or an owner can approve it",
		);
		expect(reason).not.toContain("p_zed");
	});

	test("names that cannot be read are not replaced by ids", async () => {
		const gate = gateNaming(["p_ada"], null);
		gate.beginTurn("s", false, undefined, SAM, true);
		const { reason } = await gate.decide(
			MAIL,
			send,
			{ prompts: answering("approved"), asker: "Sam" },
			inTurn,
		);
		expect(reason).toContain("Only the people named for it or an owner can");
		expect(reason).not.toContain("p_ada");
	});

	test("a set naming nobody leaves the owners alone", async () => {
		const gate = gateNaming([]);
		gate.beginTurn("s", false, undefined, SAM);
		const { reason } = await gate.decide(MAIL, send, undefined, inTurn);
		expect(reason).toContain("Only an owner can approve it");
	});

	test("a speaker who may approve it, or a call that names none, is told as before", async () => {
		const named = gateNaming(["p_ada"]);
		named.beginTurn("s", false, undefined, person("p_ada"), true);
		const expired = await named.decide(
			MAIL,
			send,
			{ prompts: answering("expired"), asker: "Ada" },
			inTurn,
		);
		expect(expired.reason).toContain("make the same call with the same input");
		const plain = gateNaming(undefined);
		plain.beginTurn("s", false, undefined, SAM, true);
		const held = await plain.decide(MAIL, send, undefined, inTurn);
		expect(held.reason).toContain("make the same call with the same input");
	});
});

describe("a partial release leaves new holds to the turn that makes them (RV2-F003)", () => {
	const BO = person("p_bo");
	/** Sam's turn held a call that names Ada; Bo, not named, then confirms and holds a call of his own. */
	async function afterBo() {
		const gate = gateNaming(["p_ada"]);
		gate.beginTurn("first", false, undefined, SAM);
		await gate.decide(MAIL, send, undefined, inTurn);
		gate.endTurn();
		const heldAt = gate.pending()?.heldAt;
		if (!heldAt) throw new Error("nothing was held");
		// The first hold is long ago.
		const long = new Date(heldAt.getTime() - (CONFIRMATION_TTL_MS - 3_600_000));
		const pending = gate.pending();
		if (pending) pending.heldAt = long;
		gate.beginTurn("second", true, undefined, BO);
		expect(gate.pending()?.calls).toHaveLength(1);
		await gate.decide(MAIL, { to: "x@y.z" }, undefined, inTurn);
		return { gate };
	}

	test("they belong to the current speaker, not the one who asked for the call that was kept", async () => {
		const { gate } = await afterBo();
		expect(gate.pending()?.calls).toHaveLength(2);
		expect(gate.pending()).toMatchObject({
			speakerId: BO.id,
			principalId: BO.principalId,
			selectionId: "second",
		});
	});

	test("their time to live starts then", async () => {
		const { gate } = await afterBo();
		// The call kept was held 23 hours ago; two hours on, it alone would have expired.
		const twoHoursOn = new Date(Date.now() + 2 * 3_600_000);
		expect(gate.pending(twoHoursOn)?.calls).toHaveLength(2);
	});

	test("without a partial release, a second hold in the turn keeps the turn's first", async () => {
		const gate = gateNaming(undefined);
		gate.beginTurn("only", false, undefined, SAM);
		await gate.decide(MAIL, { to: "x@y.z" }, undefined, inTurn);
		const first = gate.pending()?.heldAt;
		await gate.decide(MAIL, { to: "q@y.z" }, undefined, inTurn);
		expect(gate.pending()?.heldAt).toBe(first);
		expect(gate.pending()?.calls).toHaveLength(2);
	});
});
