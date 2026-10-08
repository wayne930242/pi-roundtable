import { expect, test } from "bun:test";
import type { BackgroundTurn, ConversationTurnInput } from "pi-roundtable";
import { PERSONAL_TARGET } from "pi-roundtable";
import { speakerOf, testChat } from "./testing/fakes.ts";

const turn = (principalId = "p_ada"): BackgroundTurn => ({
	channel: "web:saved",
	target: PERSONAL_TARGET.name,
	turnId: "schedule-1",
	text: "remind me",
	author: { id: "actor", name: "Ada", principalId },
	tier: "member",
	speaker: { ...speakerOf("actor"), principalId },
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
