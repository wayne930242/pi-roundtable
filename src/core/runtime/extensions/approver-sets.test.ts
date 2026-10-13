import { beforeAll, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolTurn } from "../../define.ts";
import { type HoldRule, holdChain } from "../../holds.ts";
import type {
	Approval,
	ApprovalOptions,
	ApprovedBy,
	LateAnswer,
	Prompts,
	PromptWait,
} from "../../interactions/prompts.ts";
import type { Speaker } from "../../speakers.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { type PromptSlot, promptSlot } from "../prompt-slot.ts";
import { MAIL } from "./confirmation-fixture.ts";
import {
	ConfirmationGate,
	confirmationGateExtension,
} from "./confirmation-gate.ts";

useTestLocale();
beforeAll(() => useTestLocale());

const SAM: Speaker = {
	id: "7",
	name: "Sam",
	tier: "member",
	principalId: "p_sam",
};
const ADA: ApprovedBy = { principalId: "p_ada", speakerId: "9", name: "Ada" };

const send = { to: "a@b.c" };

/** A turn as the gate hands it to a hold: Sam speaks. */
function turnOf(signal: AbortSignal | undefined): ToolTurn {
	return {
		speaker: SAM,
		channel: "discord:1",
		agent: undefined,
		signal,
		attachFile: () => undefined,
		attachment: async () => {
			throw new Error("no attachments");
		},
	};
}

/** Mail waits for approval; `approvers` says who may give it. */
function mailRule(approvers: HoldRule["approversInTurn"]): HoldRule {
	return {
		name: "mail",
		describe: (tool, input) =>
			tool === MAIL ? `send an email to ${String(input.to)}` : undefined,
		...(approvers ? { approversInTurn: approvers } : {}),
	};
}

/** Prompts that answer every card with `answer`, recording what each was asked with. */
function answering(
	answer: Approval,
	approvedBy?: ApprovedBy,
	wait?: (wait: PromptWait | undefined) => void,
) {
	const asked: (ApprovalOptions | undefined)[] = [];
	const prompts: Prompts = {
		confirm: async (_t, _m, _s, _tier, given, _details, options) => {
			asked.push(options);
			wait?.(given);
			if (answer === "approved" && approvedBy)
				options?.approvedBy?.(approvedBy);
			return answer;
		},
		ask: async () => undefined,
	};
	return { asked, prompts };
}

type Handler = (
	event: { toolName: string; toolCallId: string; input: unknown },
	ctx: { signal?: AbortSignal },
) => Promise<{ block: true; reason: string } | undefined>;

/** The gate extension's handlers, wired with the turn the gate hands to holds. */
function handlers(gate: ConfirmationGate, slot: PromptSlot) {
	let call: Handler | undefined;
	let result: ((event: unknown) => unknown) | undefined;
	confirmationGateExtension(
		gate,
		slot,
		turnOf,
	)({
		on: (event: string, h: Handler | ((e: unknown) => unknown)) => {
			if (event === "tool_call") call = h as Handler;
			if (event === "tool_result") result = h as (e: unknown) => unknown;
		},
	} as unknown as ExtensionAPI);
	if (!call || !result) throw new Error("missing handlers");
	const onCall = call;
	const onResult = result;
	return {
		call: (toolCallId: string, tool = MAIL, input: unknown = send) =>
			onCall(
				{ toolName: tool, toolCallId, input },
				{ signal: new AbortController().signal },
			),
		result: (toolCallId: string) =>
			onResult({ toolCallId, isError: false, content: [] }),
	};
}

describe("approver sets", () => {
	test("the approvers a rule names reach the card, and are kept with the held call", async () => {
		const gate = new ConfirmationGate(
			holdChain([mailRule(() => ["p_ada", "p_bo"])]),
			OWNER,
		);
		const slot = promptSlot();
		const { asked, prompts } = answering("expired");
		slot.bind(prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		const { call } = handlers(gate, slot);
		expect((await call("c1"))?.block).toBe(true);
		expect(asked.map((options) => options?.approvers)).toEqual([
			["p_ada", "p_bo"],
		]);
		expect(gate.pending()?.calls[0]?.approverIds).toEqual(["p_ada", "p_bo"]);
	});

	test("an approver set that arrives later is waited for and joined to the card", async () => {
		const gate = new ConfirmationGate(
			holdChain([mailRule(async () => ["p_ada"])]),
			OWNER,
		);
		const slot = promptSlot();
		const { asked, prompts } = answering("approved", ADA);
		slot.bind(prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		expect(await handlers(gate, slot).call("c1")).toBeUndefined();
		expect(asked[0]?.approvers).toEqual(["p_ada"]);
	});

	test("an empty set is kept as empty: the owners alone approve", async () => {
		const gate = new ConfirmationGate(holdChain([mailRule(() => [])]), OWNER);
		const slot = promptSlot();
		const { asked, prompts } = answering("expired");
		slot.bind(prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		await handlers(gate, slot).call("c1");
		expect(asked[0]?.approvers).toEqual([]);
		expect(gate.pending()?.calls[0]?.approverIds).toEqual([]);
	});

	test("a lookup that rejects, throws or never answers leaves the owners alone to approve", async () => {
		const rules = [
			async () => {
				throw new Error("down");
			},
			() => {
				throw new Error("down");
			},
		];
		for (const lookup of rules) {
			const gate = new ConfirmationGate(holdChain([mailRule(lookup)]), OWNER);
			const slot = promptSlot();
			const { asked, prompts } = answering("expired");
			slot.bind(prompts, "helper");
			gate.beginTurn("workspace", false, undefined, SAM);
			await handlers(gate, slot).call("c1");
			expect(asked[0]?.approvers).toEqual([]);
			expect(gate.pending()?.calls[0]?.approverIds).toEqual([]);
		}
		const gate = new ConfirmationGate(
			holdChain([mailRule(() => new Promise(() => undefined))]),
			OWNER,
			undefined,
			{},
			undefined,
			undefined,
			20,
		);
		const slot = promptSlot();
		const { asked, prompts } = answering("expired");
		slot.bind(prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		await handlers(gate, slot).call("c1");
		expect(asked[0]?.approvers).toEqual([]);
	});

	test("a turn that stops while approvers are looked up opens no card", async () => {
		const gate = new ConfirmationGate(
			holdChain([mailRule(() => new Promise(() => undefined))]),
			OWNER,
		);
		const slot = promptSlot();
		const { asked, prompts } = answering("approved");
		slot.bind(prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		const stop = new AbortController();
		let call: Handler | undefined;
		confirmationGateExtension(
			gate,
			slot,
			turnOf,
		)({
			on: (event: string, h: Handler) => {
				if (event === "tool_call") call = h;
			},
		} as unknown as ExtensionAPI);
		const running = call?.(
			{ toolName: MAIL, toolCallId: "c1", input: send },
			{ signal: stop.signal },
		);
		stop.abort();
		expect((await running)?.reason).toBe("The turn was stopped.");
		expect(asked).toEqual([]);
	});

	test("rules that both name approvers leave the principals every one names", async () => {
		const gate = new ConfirmationGate(
			holdChain([
				mailRule(() => ["p_ada", "p_bo"]),
				{
					name: "also",
					describe: () => undefined,
					approversInTurn: (tool) =>
						tool === MAIL ? ["p_bo", "p_cy"] : undefined,
				},
			]),
			OWNER,
		);
		const slot = promptSlot();
		const { asked, prompts } = answering("expired");
		slot.bind(prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		await handlers(gate, slot).call("c1");
		expect(asked[0]?.approvers).toEqual(["p_bo"]);
	});

	test("a rule that names no approvers leaves the card to its speaker as before", async () => {
		const gate = new ConfirmationGate(holdChain([mailRule(undefined)]), OWNER);
		const slot = promptSlot();
		const { asked, prompts } = answering("expired");
		slot.bind(prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		await handlers(gate, slot).call("c1");
		expect(asked[0]?.approvers).toBeUndefined();
		expect(gate.pending()?.calls[0]?.approverIds).toBeUndefined();
	});

	test("a call the rules do not hold asks no one", async () => {
		let asked = 0;
		const gate = new ConfirmationGate(
			holdChain([
				mailRule(() => {
					asked++;
					return ["p_ada"];
				}),
			]),
			OWNER,
		);
		const slot = promptSlot();
		slot.bind(answering("approved").prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		expect(await handlers(gate, slot).call("c1", "read", {})).toBeUndefined();
		expect(asked).toBe(0);
	});
});

describe("approvedBy", () => {
	test("a card's approval names who gave it until the call's result is back", async () => {
		const gate = new ConfirmationGate(holdChain([mailRule(undefined)]), OWNER);
		const slot = promptSlot();
		slot.bind(answering("approved", ADA).prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		const { call, result } = handlers(gate, slot);
		expect(await call("c1")).toBeUndefined();
		expect(gate.approvedBy("c1")).toEqual(ADA);
		expect(gate.approvedBy("c2")).toBeUndefined();
		result("c1");
		expect(gate.approvedBy("c1")).toBeUndefined();
	});

	test("a surface that does not say who approved leaves it unnamed", async () => {
		const gate = new ConfirmationGate(holdChain([mailRule(undefined)]), OWNER);
		const slot = promptSlot();
		slot.bind(answering("approved").prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		const { call } = handlers(gate, slot);
		expect(await call("c1")).toBeUndefined();
		expect(gate.approvedBy("c1")).toBeUndefined();
	});

	test("a refusal names no one", async () => {
		const gate = new ConfirmationGate(holdChain([mailRule(undefined)]), OWNER);
		const slot = promptSlot();
		slot.bind(answering("declined", ADA).prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		const { call } = handlers(gate, slot);
		expect((await call("c1"))?.block).toBe(true);
		expect(gate.approvedBy("c1")).toBeUndefined();
	});

	test("a card approved after the turn stopped waiting names who gave it when the call is made again", async () => {
		const gate = new ConfirmationGate(holdChain([mailRule(undefined)]), OWNER);
		const slot = promptSlot();
		let wait: PromptWait | undefined;
		slot.bind(
			answering("pending", undefined, (given) => (wait = given)).prompts,
			"helper",
		);
		gate.beginTurn("workspace", false, undefined, SAM);
		expect((await handlers(gate, slot).call("c1"))?.block).toBe(true);
		gate.endTurn();
		const late: LateAnswer = {
			kind: "approval",
			approved: true,
			by: "Ada",
			approvedBy: ADA,
		};
		expect(wait?.late(late)).toContain("Make this call now");
		// Any later turn, here a fresh one with no card, runs the identical call once.
		gate.beginTurn("workspace", false, undefined, SAM);
		const second = handlers(gate, promptSlot());
		expect(await second.call("c2")).toBeUndefined();
		expect(gate.approvedBy("c2")).toEqual(ADA);
		expect((await second.call("c3"))?.block).toBe(true);
	});

	test("a message that confirmed the held call names its speaker as the approver", async () => {
		const gate = new ConfirmationGate(holdChain([mailRule(undefined)]), OWNER);
		gate.beginTurn("first", false, undefined, SAM);
		expect(gate.hold(MAIL, send)).toContain("Held for");
		gate.endTurn();
		const ada: Speaker = {
			id: "9",
			name: "Ada",
			tier: "member",
			principalId: "p_ada",
		};
		gate.beginTurn("second", true, undefined, ada);
		const slot = promptSlot();
		const { call } = handlers(gate, slot);
		expect(await call("c1")).toBeUndefined();
		expect(gate.approvedBy("c1")).toEqual({
			principalId: "p_ada",
			speakerId: "9",
			name: "Ada",
		});
	});

	test("a turn's end forgets approvals whose results never came", async () => {
		const gate = new ConfirmationGate(holdChain([mailRule(undefined)]), OWNER);
		const slot = promptSlot();
		slot.bind(answering("approved", ADA).prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		await handlers(gate, slot).call("c1");
		gate.endTurn();
		expect(gate.approvedBy("c1")).toBeUndefined();
	});
});

const BO: ApprovedBy = { principalId: "p_bo", speakerId: "10", name: "Bo" };
const BOSS: ApprovedBy = {
	principalId: "p_boss",
	speakerId: "1",
	name: "Boss",
	owner: true,
};
const speaker = (principalId: string, tier: Speaker["tier"] = "member") =>
	({ id: principalId, name: principalId, tier, principalId }) satisfies Speaker;

/** A gate whose mail names Ada alone as its approver. */
const naming = (names: readonly string[] = ["p_ada"]) =>
	new ConfirmationGate(holdChain([mailRule(() => names)]), OWNER);

describe("a call that names approvers is refused outside them", () => {
	test("in a private conversation whose person is not named, no card opens and the call stays held (RV-F001)", async () => {
		const gate = naming();
		const slot = promptSlot();
		const { asked, prompts } = answering("approved");
		slot.bind(prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM, true);
		expect((await handlers(gate, slot).call("c1"))?.block).toBe(true);
		expect(asked).toEqual([]);
		expect(gate.pending()?.calls[0]?.approverIds).toEqual(["p_ada"]);
		expect(gate.approvedBy("c1")).toBeUndefined();
	});

	test("in a private conversation whose person is named, they approve it, and are the approver even if the surface does not say", async () => {
		const gate = naming();
		const slot = promptSlot();
		slot.bind(answering("approved").prompts, "helper");
		const ada = speaker("p_ada");
		gate.beginTurn("workspace", false, undefined, ada, true);
		expect(await handlers(gate, slot).call("c1")).toBeUndefined();
		expect(gate.approvedBy("c1")).toEqual({
			principalId: "p_ada",
			speakerId: "p_ada",
			name: "p_ada",
		});
	});

	test("in a private conversation whose person is an owner, they approve it", async () => {
		const gate = naming();
		const slot = promptSlot();
		slot.bind(answering("approved").prompts, "helper");
		gate.beginTurn(
			"workspace",
			false,
			undefined,
			speaker("p_boss", "owner"),
			true,
		);
		expect(await handlers(gate, slot).call("c1")).toBeUndefined();
		expect(gate.approvedBy("c1")?.owner).toBe(true);
	});

	test("a private conversation's call that names none is unchanged: asked, and no approver invented", async () => {
		const gate = new ConfirmationGate(holdChain([mailRule(undefined)]), OWNER);
		const slot = promptSlot();
		const { asked, prompts } = answering("approved");
		slot.bind(prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM, true);
		expect(await handlers(gate, slot).call("c1")).toBeUndefined();
		expect(asked).toHaveLength(1);
		expect(gate.approvedBy("c1")).toBeUndefined();
	});

	test("in a shared conversation an approval that does not say who gave it leaves the call held (RV-F003)", async () => {
		const gate = naming();
		const slot = promptSlot();
		slot.bind(answering("approved").prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		const { call } = handlers(gate, slot);
		expect((await call("c1"))?.block).toBe(true);
		expect(gate.approvedBy("c1")).toBeUndefined();
		expect(gate.pending()?.calls).toHaveLength(1);
	});

	test("in a shared conversation an approval by someone neither named nor an owner leaves it held (RV-F003)", async () => {
		const gate = naming();
		const slot = promptSlot();
		slot.bind(answering("approved", BO).prompts, "helper");
		gate.beginTurn("workspace", false, undefined, SAM);
		expect((await handlers(gate, slot).call("c1"))?.block).toBe(true);
		expect(gate.approvedBy("c1")).toBeUndefined();
	});

	test("in a shared conversation a named approver's, or an owner's, approval runs it", async () => {
		for (const by of [ADA, BOSS]) {
			const gate = naming();
			const slot = promptSlot();
			slot.bind(answering("approved", by).prompts, "helper");
			gate.beginTurn("workspace", false, undefined, SAM);
			expect(await handlers(gate, slot).call("c1")).toBeUndefined();
			expect(gate.approvedBy("c1")).toEqual(by);
		}
	});

	test("an approval after the turn stopped waiting counts only from a named approver or an owner (RV-F003)", async () => {
		for (const [by, runs] of [
			[undefined, false],
			[BO, false],
			[ADA, true],
			[BOSS, true],
		] as const) {
			const gate = naming();
			const slot = promptSlot();
			let wait: PromptWait | undefined;
			slot.bind(
				answering("pending", undefined, (given) => (wait = given)).prompts,
				"helper",
			);
			gate.beginTurn("workspace", false, undefined, SAM);
			await handlers(gate, slot).call("c1");
			gate.endTurn();
			wait?.late({
				kind: "approval",
				approved: true,
				by: "x",
				...(by ? { approvedBy: by } : {}),
			});
			gate.beginTurn("workspace", false, undefined, SAM);
			const second = (await handlers(gate, promptSlot()).call("c2"))?.block;
			expect(second === undefined).toBe(runs);
		}
	});
});

describe("a message that confirms held calls releases only those its speaker may approve (RV-F002)", () => {
	/** A gate holding one call that names Ada, and, when `plain`, one that names nobody. */
	async function holding(plain = false) {
		const gate = new ConfirmationGate(
			holdChain([
				{
					name: "mail",
					describe: (tool, input) =>
						tool === MAIL ? `send an email to ${String(input.to)}` : undefined,
					approversInTurn: (_tool, input) =>
						input.to === "a@b.c" ? ["p_ada"] : undefined,
				},
			]),
			OWNER,
		);
		gate.beginTurn("first", false, undefined, SAM);
		const { call } = handlers(gate, promptSlot());
		await call("h1", MAIL, send);
		if (plain) await call("h2", MAIL, { to: "x@y.z" });
		gate.endTurn();
		return gate;
	}

	test("a speaker the call does not name releases nothing, and it stays held", async () => {
		const gate = await holding();
		gate.beginTurn("second", true, undefined, speaker("p_bo", "admin"));
		expect(gate.pending()?.calls).toHaveLength(1);
		const slot = promptSlot();
		expect((await handlers(gate, slot).call("c1"))?.block).toBe(true);
		expect(gate.approvedBy("c1")).toBeUndefined();
		// Still there for the one who may.
		gate.endTurn();
		gate.beginTurn("third", true, undefined, speaker("p_ada"));
		expect(await handlers(gate, promptSlot()).call("c2")).toBeUndefined();
		expect(gate.approvedBy("c2")?.principalId).toBe("p_ada");
	});

	test("the requester is no exception unless named", async () => {
		const gate = await holding();
		expect(gate.releasable(SAM)?.calls).toEqual([]);
		expect(gate.releasable(speaker("p_sam"))?.calls).toEqual([]);
		expect(gate.releasable(undefined)?.calls).toEqual([]);
		expect(gate.releasable(speaker("p_ada"))?.calls).toHaveLength(1);
		expect(gate.releasable(speaker("p_boss", "owner"))?.calls).toHaveLength(1);
	});

	test("the calls that name nobody are released, those that name others are not", async () => {
		const gate = await holding(true);
		gate.beginTurn("second", true, undefined, speaker("p_bo", "admin"));
		const { call } = handlers(gate, promptSlot());
		expect((await call("c1", MAIL, send))?.block).toBe(true);
		expect(await call("c2", MAIL, { to: "x@y.z" })).toBeUndefined();
		expect(gate.pending()?.calls.map((held) => held.input)).toEqual([
			'{"to":"a@b.c"}',
		]);
	});

	test("an owner's message releases it, and names them an owner", async () => {
		const gate = await holding();
		gate.beginTurn("second", true, undefined, speaker("p_boss", "owner"));
		expect(await handlers(gate, promptSlot()).call("c1")).toBeUndefined();
		expect(gate.approvedBy("c1")?.owner).toBe(true);
	});
});
