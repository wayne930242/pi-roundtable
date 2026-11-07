import { expect, test } from "bun:test";
import type { ConversationTurns, InboundMessage } from "pi-roundtable";
import { speakerOf, testChat } from "./testing/fakes.ts";

const table = [
	"```table",
	"columns: [name, size]",
	"rows:",
	...Array.from({ length: 200 }, (_, i) => `  - [row ${i}, ${i}]`),
	"```",
].join("\n");

/** A chat whose turns answer `answer` at once, with its claim and surface linked. */
async function answering(answer: string) {
	const runner: ConversationTurns = {
		run: async (input) => {
			await harness.registry.register({
				key: input.channel,
				kind: input.kind,
				visibility: "private",
				principalId: input.speaker.principalId,
			});
			const result = { ok: true as const, text: answer };
			await input.reply?.(result);
			return result;
		},
	};
	const harness = testChat({ turns: () => runner });
	const claim = harness.chat.claim();
	const runs: Promise<void>[] = [];
	await harness.chat.surface.start((message: InboundMessage) => {
		const admission = claim.admit({
			...message,
			speaker: speakerOf(message.authorId),
		});
		if (admission?.kind === "turn") runs.push(admission.run());
	});
	return { ...harness, settled: () => Promise.all(runs.splice(0)) };
}

test("a reply with a display block reaches the person as text, not as the block's YAML", async () => {
	const { connect, say, settled } = await answering(`Here.\n\n${table}`);
	const ada = connect("ada");
	await say(ada, { type: "send", id: "c1", persona: "helper", text: "show" });
	await settled();
	const reply = ada.frames.at(-1) as { type: string; text: string };
	expect(reply.type).toBe("reply");
	expect(reply.text).not.toContain("```table");
	expect(reply.text).toContain("• name: row 0 · size: 0");
	expect(reply.text.startsWith("Here.")).toBe(true);
});

test("a long reply is not cut: a code fence stays in one piece", async () => {
	const code = `\`\`\`ts\n${"const x = 1;\n".repeat(400)}\`\`\``;
	const { connect, say, settled } = await answering(code);
	const ada = connect("ada");
	await say(ada, { type: "send", id: "c1", persona: "helper", text: "show" });
	await settled();
	expect((ada.frames.at(-1) as { text: string }).text).toBe(code);
});
