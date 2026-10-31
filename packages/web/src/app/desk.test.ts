import { describe, expect, test } from "bun:test";
import {
	type ChannelKey,
	type PromptScope,
	SYSTEM_PRINCIPAL,
} from "pi-roundtable";
import { silentLogger } from "pi-roundtable/testing";
import type { ClosedCard, ServerFrame } from "../api-types.ts";
import { type Answerer, OwnerDesk } from "./desk.ts";

const ROOM = "app:agent.guide" as ChannelKey;
const ADA: Answerer = {
	principalId: "ada",
	tier: "owner",
	speakerId: "token:web-console",
	name: "Ada",
};
const BEA: Answerer = { ...ADA, principalId: "bea", name: "Bea" };
const SCOPE: PromptScope = {
	principalId: "ada",
	speakerId: "token:web-console",
	tier: "owner",
	escalate: "owners",
};

function desk(options: { graceMs?: number; ttlMs?: number } = {}) {
	const frames: ServerFrame[] = [];
	const resumed: string[] = [];
	const kept: ClosedCard[] = [];
	const instance = new OwnerDesk({
		broadcast: (frame) => frames.push(frame),
		closed: (card) => {
			kept.push(card);
		},
		graceMs: options.graceMs ?? 10_000,
		...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
		resume: (_room, by, text) => {
			resumed.push(`${by.name}: ${text}`);
		},
		namesOf: async (ids) => ids.map((id) => id.toUpperCase()),
		logger: silentLogger(),
	});
	const promptId = () => {
		const shown = frames.find((f) => f.type === "prompt");
		if (shown?.type !== "prompt") throw new Error("no card was shown");
		return shown.prompt.id;
	};
	return { instance, frames, resumed, promptId, kept };
}

const tick = () => Bun.sleep(5);

describe("who may answer a card", () => {
	test("every owner answers an approval, and the call is told who", async () => {
		const { instance, promptId } = desk();
		let by: unknown;
		const result = instance
			.prompts(ROOM, SCOPE)
			.confirm("t", "m", undefined, "owner", undefined, undefined, {
				approvedBy: (who) => (by = who),
			});
		await tick();
		expect(instance.approve(BEA, promptId(), true)).toBeUndefined();
		expect(await result).toBe("approved");
		expect(by).toMatchObject({ principalId: "bea", owner: true });
	});

	test("a card that is the speaker's alone is answered by the speaker's principal only", async () => {
		const { instance, promptId } = desk();
		const result = instance
			.prompts(ROOM, SCOPE)
			.confirm("t", "m", undefined, "owner", undefined, undefined, {
				speakerOnly: true,
			});
		await tick();
		expect(instance.approve(BEA, promptId(), true)).toBe("forbidden");
		expect(instance.approve(ADA, promptId(), true)).toBeUndefined();
		expect(await result).toBe("approved");
	});

	test("a speaker's-alone card of a turn without a person is unavailable at once", async () => {
		const { instance, frames } = desk();
		for (const scope of [
			undefined,
			{ ...SCOPE, principalId: SYSTEM_PRINCIPAL },
			{ ...SCOPE, tier: "member" as const },
		])
			expect(
				await instance
					.prompts(ROOM, scope)
					.confirm("t", "m", undefined, "owner", undefined, undefined, {
						speakerOnly: true,
					}),
			).toBe("unavailable");
		expect(frames).toEqual([]);
	});

	test("an approval is answered at the tier it needs, read from the answerer", async () => {
		const { instance, promptId } = desk();
		const result = instance.prompts(ROOM, SCOPE).confirm("t", "m");
		await tick();
		expect(instance.approve({ ...ADA, tier: "admin" }, promptId(), true)).toBe(
			"forbidden",
		);
		instance.approve(ADA, promptId(), false);
		expect(await result).toBe("declined");
	});

	test("a private conversation's card is its person's, and one above their tier is unavailable", async () => {
		const { instance, promptId } = desk();
		const scope: PromptScope = { ...SCOPE, escalate: "none" };
		const asked = instance.prompts(ROOM, scope).confirm("t", "m");
		await tick();
		expect(instance.approve(BEA, promptId(), true)).toBe("forbidden");
		instance.approve(ADA, promptId(), true);
		expect(await asked).toBe("approved");
		expect(
			await instance
				.prompts(ROOM, { ...scope, tier: "member" })
				.confirm("t", "m", undefined, "owner"),
		).toBe("unavailable");
	});

	test("a card names who may approve it by display name", async () => {
		const { instance, frames } = desk();
		void instance
			.prompts(ROOM, SCOPE)
			.confirm("t", "m", undefined, "owner", undefined, undefined, {
				approvers: ["dee"],
				purpose: "turn-timeout",
				wording: {
					approve: "Continue",
					decline: "Stop",
					footer: "f",
					approved: "a",
					declined: "d",
				},
			});
		await tick();
		const shown = frames.find((f) => f.type === "prompt");
		expect(shown).toMatchObject({
			prompt: {
				approvers: ["DEE"],
				purpose: "turn-timeout",
				wording: { approve: "Continue" },
			},
		});
		instance.stop();
	});
});

describe("how a card ends", () => {
	test("a stopped turn closes its card as cancelled", async () => {
		const { instance, frames } = desk();
		const stop = new AbortController();
		const result = instance.prompts(ROOM, SCOPE).confirm("t", "m", stop.signal);
		await tick();
		stop.abort();
		expect(await result).toBe("cancelled");
		expect(frames.at(-1)).toMatchObject({
			type: "prompt_closed",
			outcome: "cancelled",
		});
		const stopped = new AbortController();
		stopped.abort();
		expect(
			await instance.prompts(ROOM, SCOPE).confirm("t", "m", stopped.signal),
		).toBe("cancelled");
	});

	test("a card nobody answers expires after its time to live", async () => {
		const { instance, frames } = desk({ ttlMs: 30 });
		expect(await instance.prompts(ROOM, SCOPE).confirm("t", "m")).toBe(
			"expired",
		);
		expect(frames.at(-1)).toMatchObject({ outcome: "expired" });
	});

	test("a withdrawn card closes with the plugin's reason", async () => {
		const { instance, frames } = desk();
		const withdraw = new AbortController();
		const result = instance
			.prompts(ROOM, SCOPE)
			.confirm("t", "m", undefined, "owner", undefined, undefined, {
				supersede: withdraw.signal,
			});
		await tick();
		withdraw.abort("replaced by a newer request");
		expect(await result).toBe("cancelled");
		expect(frames.at(-1)).toMatchObject({
			outcome: "withdrawn",
			note: "replaced by a newer request",
		});
	});

	test("after the grace the turn is told pending and a late answer starts a turn", async () => {
		const { instance, frames, resumed, promptId } = desk({ graceMs: 20 });
		const late: unknown[] = [];
		const result = instance
			.prompts(ROOM, SCOPE)
			.confirm("t", "m", undefined, "owner", {
				late: (answer) => {
					late.push(answer);
					return "go on";
				},
			});
		expect(await result).toBe("pending");
		expect(frames.at(-1)).toMatchObject({ prompt: { late: true } });
		instance.approve(ADA, promptId(), true);
		expect(late).toMatchObject([
			{ kind: "approval", approved: true, by: "Ada" },
		]);
		expect(resumed).toEqual(["Ada: go on"]);
		// Answered once; a second answer finds no card.
		expect(instance.approve(ADA, promptId(), true)).toBe("unknown_prompt");
	});

	test("a turn's own grace period replaces the desk's, for a question and a questionnaire alike", async () => {
		const { instance } = desk({ graceMs: 60_000 });
		const prompts = instance.prompts(ROOM, SCOPE);
		const question = {
			question: "q",
			options: [],
			multi: false,
			allowOther: true,
		};
		const wait = { late: () => "never", graceMs: 20 };
		const started = Date.now();
		expect(await prompts.ask("t", question, undefined, wait)).toBe("pending");
		expect(
			await prompts.questionnaire?.(
				"t",
				{ questions: [question, { ...question, question: "r" }] },
				undefined,
				wait,
			),
		).toBe("pending");
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("cancelling a late question only closes it", async () => {
		const { instance, frames, resumed, promptId } = desk({ graceMs: 20 });
		const result = instance
			.prompts(ROOM, SCOPE)
			.ask(
				"t",
				{ question: "q", options: [], multi: false, allowOther: true },
				undefined,
				{ late: () => "never" },
			);
		expect(await result).toBe("pending");
		expect(instance.cancel(ADA, promptId())).toBeUndefined();
		expect(resumed).toEqual([]);
		expect(frames.at(-1)).toMatchObject({ outcome: "declined" });
	});
});

describe("questions", () => {
	test("a questionnaire is answered per question, blanks allowed", async () => {
		const { instance, promptId } = desk();
		const prompts = instance.prompts(ROOM, SCOPE);
		expect(prompts.asks).toMatchObject({ questions: 4, previews: true });
		const result = prompts.questionnaire?.("t", {
			questions: [
				{
					question: "a?",
					options: [{ label: "x" }],
					multi: false,
					allowOther: false,
				},
				{ question: "b?", options: [], multi: false, allowOther: true },
			],
		});
		await tick();
		expect(
			instance.answers(ADA, promptId(), [{ choices: ["nope"] }, null]),
		).toBe("bad_frame");
		expect(
			instance.answers(ADA, promptId(), [{ choices: ["x"] }, null], " note "),
		).toBeUndefined();
		expect(await result).toEqual({
			answers: [{ choices: ["x"] }, undefined],
			note: "note",
		});
	});

	test("an answer to the wrong kind of card finds no card", async () => {
		const { instance, promptId } = desk();
		void instance.prompts(ROOM, SCOPE).confirm("t", "m");
		await tick();
		expect(instance.answer(ADA, promptId(), { choices: [] })).toBe(
			"unknown_prompt",
		);
		expect(instance.cancel(ADA, promptId())).toBe("unknown_prompt");
		expect(instance.approve(ADA, "no-such", true)).toBe("unknown_prompt");
		instance.stop();
	});

	test("the open cards are sent again to a socket that connects later", async () => {
		const { instance } = desk();
		void instance.prompts(ROOM, SCOPE).confirm("t", "m");
		await tick();
		expect(instance.openFrames()).toMatchObject([
			{
				room: ROOM,
				frame: { type: "prompt", room: ROOM, prompt: { kind: "approval" } },
			},
		]);
		instance.stop();
		expect(instance.openFrames()).toEqual([]);
	});
});

describe("when a card opened", () => {
	test("its frame carries the server's time, and a late frame keeps it", async () => {
		const before = Date.now();
		const { instance, frames, promptId } = desk({ graceMs: 20 });
		instance.prompts(ROOM, SCOPE).confirm("t", "m", undefined, "owner", {
			late: () => undefined,
		} as never);
		await tick();
		const shown = frames.find((f) => f.type === "prompt");
		if (shown?.type !== "prompt") throw new Error("no card was shown");
		const opened = Date.parse(shown.prompt.at ?? "");
		expect(opened).toBeGreaterThanOrEqual(before);
		expect(opened).toBeLessThanOrEqual(Date.now());
		await Bun.sleep(60);
		const again = frames.filter((f) => f.type === "prompt").at(-1);
		if (again?.type !== "prompt") throw new Error("no late frame");
		expect(again.prompt).toMatchObject({ id: promptId(), late: true });
		expect(again.prompt.at).toBe(shown.prompt.at);
		expect(instance.isLate(promptId())).toBe(true);
	});
});

describe("the cards kept when they end", () => {
	test("an approval is kept with its outcome, who answered and when", async () => {
		const before = Date.now();
		const { instance, promptId, kept, frames } = desk();
		const result = instance
			.prompts(ROOM, SCOPE)
			.confirm("Send?", "the note", undefined, "owner", undefined, {
				action: "send",
				tool: "note_send",
				input: { to: "team" },
			});
		await tick();
		const id = promptId();
		instance.approve(BEA, id, true);
		expect(await result).toBe("approved");
		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatchObject({
			room: ROOM,
			outcome: "approved",
			by: "Bea",
			frame: {
				id,
				kind: "approval",
				title: "Send?",
				approval: { tool: "note_send" },
			},
		});
		expect(kept[0]).not.toHaveProperty("answer");
		expect(Date.parse(kept[0]?.closedAt ?? "")).toBeGreaterThanOrEqual(before);
		// The closing frame says the same, so a page that watched it live shows what a reload does.
		expect(frames.at(-1)).toEqual({
			type: "prompt_closed",
			prompt: id,
			outcome: "approved",
			by: "Bea",
			closedAt: kept[0]?.closedAt,
		});
	});

	test("a declined approval and a cancelled question are kept as declined", async () => {
		const { instance, promptId, kept } = desk();
		const prompts = instance.prompts(ROOM, SCOPE);
		const approval = prompts.confirm("t", "m");
		await tick();
		instance.approve(ADA, promptId(), false);
		await approval;
		expect(kept.at(-1)).toMatchObject({ outcome: "declined", by: "Ada" });
	});

	test("a question keeps the answer given, text included", async () => {
		const { instance, promptId, kept } = desk();
		const result = instance.prompts(ROOM, SCOPE).ask("t", {
			question: "q",
			options: [{ label: "x" }],
			multi: false,
			allowOther: true,
		});
		await tick();
		instance.answer(ADA, promptId(), { choices: ["x"], text: " why " });
		await result;
		expect(kept[0]).toMatchObject({
			outcome: "answered",
			by: "Ada",
			answer: { kind: "ask", answer: { choices: ["x"], text: "why" } },
		});
	});

	test("a questionnaire keeps each answer, a blank one as null, and the note", async () => {
		const { instance, promptId, kept } = desk();
		const result = instance.prompts(ROOM, SCOPE).questionnaire?.("t", {
			questions: [
				{
					question: "a?",
					options: [{ label: "x" }],
					multi: false,
					allowOther: false,
				},
				{ question: "b?", options: [], multi: false, allowOther: true },
			],
		});
		await tick();
		instance.answers(ADA, promptId(), [{ choices: ["x"] }, null], " note ");
		await result;
		expect(kept[0]).toMatchObject({
			outcome: "answered",
			answer: {
				kind: "questionnaire",
				answers: [{ choices: ["x"] }, null],
				note: "note",
			},
		});
	});

	test("a card nobody answered names no one: cancelled, expired, withdrawn with its reason", async () => {
		const { instance, kept } = desk({ ttlMs: 40 });
		const stop = new AbortController();
		const stopped = instance
			.prompts(ROOM, SCOPE)
			.confirm("a", "m", stop.signal);
		const withdraw = new AbortController();
		const withdrawn = instance
			.prompts(ROOM, SCOPE)
			.confirm("b", "m", undefined, "owner", undefined, undefined, {
				supersede: withdraw.signal,
			});
		await tick();
		stop.abort();
		withdraw.abort("replaced by a newer request");
		await Promise.all([stopped, withdrawn]);
		expect(
			kept.map((c) => [
				c.frame.kind === "approval" && c.frame.title,
				c.outcome,
			]),
		).toEqual([
			["a", "cancelled"],
			["b", "withdrawn"],
		]);
		expect(kept[1]).toMatchObject({ note: "replaced by a newer request" });
		expect(kept.every((c) => c.by === undefined)).toBe(true);
		await instance.prompts(ROOM, SCOPE).confirm("c", "m");
		expect(kept.at(-1)).toMatchObject({ outcome: "expired" });
	});

	test("a late card that is answered is kept once, with its late flag", async () => {
		const { instance, promptId, kept } = desk({ graceMs: 20 });
		await instance
			.prompts(ROOM, SCOPE)
			.confirm("t", "m", undefined, "owner", { late: () => "go" });
		instance.approve(ADA, promptId(), true);
		instance.approve(ADA, promptId(), true);
		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatchObject({
			outcome: "approved",
			frame: { late: true },
		});
	});

	test("a log that fails does not fail the turn", async () => {
		const frames: ServerFrame[] = [];
		const instance = new OwnerDesk({
			broadcast: (frame) => frames.push(frame),
			graceMs: 10_000,
			closed: () => {
				throw new Error("disk full");
			},
			resume: () => undefined,
			namesOf: async (ids) => [...ids],
			logger: silentLogger(),
		});
		const result = instance.prompts(ROOM, SCOPE).confirm("t", "m");
		await tick();
		const shown = frames.find((f) => f.type === "prompt");
		if (shown?.type !== "prompt") throw new Error("no card was shown");
		instance.approve(ADA, shown.prompt.id, true);
		expect(await result).toBe("approved");
		expect(frames.at(-1)).toMatchObject({ outcome: "approved" });
	});
});

describe("card(p): who a card's audience is, whatever room reads it", () => {
	const MEMBER_SCOPE: PromptScope = {
		principalId: "mel",
		speakerId: "app:mel",
		tier: "admin",
		escalate: "owners",
	};
	const MEL: Answerer = {
		principalId: "mel",
		tier: "admin",
		speakerId: "app:mel",
		name: "Mel",
	};
	const NIA: Answerer = { ...MEL, principalId: "nia", name: "Nia" };

	test("an approval naming approvers is answered by them and by owners, never by the speaker or a reader", async () => {
		const { instance, promptId } = desk();
		const result = instance
			.prompts(ROOM, MEMBER_SCOPE)
			.confirm("t", "m", undefined, "admin", undefined, undefined, {
				approvers: ["dee"],
			});
		await tick();
		// The speaker was not named, and neither was a reader of the room.
		expect(instance.approve(MEL, promptId(), true)).toBe("forbidden");
		expect(instance.approve(NIA, promptId(), false)).toBe("forbidden");
		expect(instance.approve(ADA, promptId(), true)).toBeUndefined();
		expect(await result).toBe("approved");
	});

	test("a named approver answers at the tier the call needs now, and below it does not", async () => {
		const { instance, promptId } = desk();
		void instance
			.prompts(ROOM, MEMBER_SCOPE)
			.confirm("t", "m", undefined, "admin", undefined, undefined, {
				approvers: ["nia"],
			});
		await tick();
		expect(instance.approve({ ...NIA, tier: "member" }, promptId(), true)).toBe(
			"forbidden",
		);
		expect(instance.approve(NIA, promptId(), true)).toBeUndefined();
	});

	test("an approval naming no one is the speaker's at their tier, and the owners'", async () => {
		const { instance, promptId } = desk();
		void instance
			.prompts(ROOM, MEMBER_SCOPE)
			.confirm("t", "m", undefined, "admin");
		await tick();
		expect(instance.approve(NIA, promptId(), true)).toBe("forbidden");
		expect(instance.approve(MEL, promptId(), true)).toBeUndefined();
	});

	test("a question is the speaker's and the owners', and no one else answers or cancels it", async () => {
		const { instance, promptId } = desk();
		const asked = instance
			.prompts(ROOM, MEMBER_SCOPE)
			.ask("t", { question: "Which?", options: [{ label: "x" }] } as never);
		await tick();
		expect(instance.answer(NIA, promptId(), { choices: ["x"] })).toBe(
			"forbidden",
		);
		expect(instance.cancel(NIA, promptId())).toBe("forbidden");
		expect(
			instance.answer(MEL, promptId(), { choices: ["x"] }),
		).toBeUndefined();
		expect(await asked).toBeDefined();
	});

	test("a card with no scope is the owners' alone", async () => {
		const { instance, promptId } = desk();
		void instance.prompts(ROOM, undefined as never).confirm("t", "m");
		await tick();
		expect(instance.approve(MEL, promptId(), true)).toBe("forbidden");
		expect(instance.approve(ADA, promptId(), true)).toBeUndefined();
	});
});
