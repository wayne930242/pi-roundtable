import { describe, expect, test } from "bun:test";
import {
	type ChannelKey,
	type PromptScope,
	SYSTEM_PRINCIPAL,
} from "pi-roundtable";
import { silentLogger } from "pi-roundtable/testing";
import type { ServerFrame } from "../api-types.ts";
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
	const instance = new OwnerDesk({
		broadcast: (frame) => frames.push(frame),
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
	return { instance, frames, resumed, promptId };
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
			{ type: "prompt", room: ROOM, prompt: { kind: "approval" } },
		]);
		instance.stop();
		expect(instance.openFrames()).toEqual([]);
	});
});
