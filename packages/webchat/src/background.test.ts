import { expect, test } from "bun:test";
import type { BackgroundTurn, ConversationTurnInput } from "pi-roundtable";
import { PERSONAL_TARGET } from "pi-roundtable";
import { speakerOf, TEST_LIMITS, testChat } from "./testing/fakes.ts";

const turn = (principalId = "p_ada"): BackgroundTurn => ({
	channel: "web:saved",
	target: PERSONAL_TARGET.name,
	turnId: "schedule-1",
	text: "remind me",
	author: { id: "actor", name: "Ada", principalId },
	tier: "member",
	speaker: { ...speakerOf("actor"), principalId },
});

test("background turns run privately even when interactive admission is full", async () => {
	const waiting = Promise.withResolvers<void>();
	const runs: Promise<void>[] = [];
	let backgroundRuns = 0;
	const { chat, registry, connect, say } = testChat({
		limits: { ...TEST_LIMITS, turnsPerPrincipal: 1 },
		turns: () => ({
			run: async (input) => {
				if (input.text === "hold") await waiting.promise;
				else {
					backgroundRuns++;
					await input.reply?.({ ok: true, text: "background delivered" });
				}
				return { ok: true, text: "done" };
			},
		}),
	});
	await registry.register({
		key: "web:saved",
		kind: "helper",
		visibility: "private",
		principalId: "p_ada",
	});
	const claim = chat.claim();
	await chat.surface.start((message) => {
		const admission = claim.admit({
			...message,
			speaker: { ...speakerOf(message.authorId), principalId: "p_ada" },
		});
		if (admission?.kind === "turn") runs.push(admission.run());
	});
	const a = connect("web-a", ["User"], "p_ada");
	const b = connect("web-b", ["User"], "p_bob");
	try {
		await say(a, { type: "send", id: "hold", persona: "helper", text: "hold" });
		await say(a, { type: "send", id: "busy", persona: "helper", text: "hold" });
		expect(a.frames.at(-1)).toMatchObject({ type: "error", code: "busy" });
		expect(await claim.background?.(turn())).toEqual({ status: "ran" });
		expect(backgroundRuns).toBe(1);
		expect(a.frames).toContainEqual({
			type: "reply",
			conversation: "saved",
			text: "background delivered",
		});
		expect(b.frames.some((frame) => frame.type === "reply")).toBe(false);
	} finally {
		waiting.resolve();
		await Promise.all(runs);
		chat.closed(a);
		chat.closed(b);
	}
});

test("a background turn after restart runs privately and pushes only to its principal", async () => {
	const runs: ConversationTurnInput[] = [];
	const { chat, registry, connect } = testChat({
		turns: () => ({
			run: async (input) => {
				runs.push(input);
				await input.reply?.({ ok: true, text: "remembered" });
				return { ok: true, text: "remembered" };
			},
		}),
	});
	await registry.register({
		key: "web:saved",
		kind: "helper",
		visibility: "private",
		principalId: "p_ada",
	});
	const a = connect("web-a", ["User"], "p_ada");
	const b = connect("web-b", ["User"], "p_bob");
	const claim = chat.claim();
	expect(await claim.background?.(turn())).toEqual({ status: "ran" });
	expect(runs[0]).toMatchObject({
		conversation: { visibility: "private" },
		speaker: { principalId: "p_ada" },
	});
	expect(a.frames.at(-1)).toMatchObject({ type: "reply", text: "remembered" });
	expect(b.frames.some((f) => f.type === "reply")).toBe(false);
	for (const denied of [
		turn("p_bob"),
		{ ...turn(), target: "other" },
		{ ...turn(), speaker: undefined },
		{ ...turn(), speaker: { ...speakerOf("bad"), principalId: "p_bob" } },
	])
		expect((await claim.background?.(denied))?.status).toBe("skipped");
	expect(runs).toHaveLength(1);
	chat.closed(a);
	chat.closed(b);
});
