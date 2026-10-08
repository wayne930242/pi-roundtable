import { expect, test } from "bun:test";
import type { AgentRuntime, InboundMessage } from "pi-roundtable";
import { partial } from "pi-roundtable/testing";
import { speakerOf, testChat } from "./testing/fakes.ts";

test("the chat registers a fresh private conversation before handing its key to the runtime pipeline", async () => {
	const h = testChat({
		turns: () => ({
			run: async (input) => {
				expect(h.registry.records.get(input.channel)).toMatchObject({
					visibility: "private",
					principalId: input.speaker.principalId,
				});
				return { ok: true, text: "done" };
			},
		}),
	});
	const runs: Promise<void>[] = [];
	const claim = h.chat.claim();
	await h.chat.surface.start((message: InboundMessage) => {
		const admission = claim.admit({
			...message,
			speaker: speakerOf(message.authorId),
		});
		if (admission?.kind === "turn") runs.push(admission.run());
	});
	const socket = h.connect("ada");
	try {
		await h.say(socket, {
			type: "send",
			id: "1",
			persona: "helper",
			text: "hi",
		});
		await Promise.all(runs);
	} finally {
		h.chat.closed(socket);
	}
});

test("stop never calls runtime for an unregistered key, including a minted-but-unused conversation", async () => {
	const stopped: string[] = [];
	const h = testChat({
		runtime: () =>
			partial<AgentRuntime>({
				stop: (channel) => {
					stopped.push(channel);
					return true;
				},
			}),
	});
	const claim = h.chat.claim();
	const minted = h.chat.open(speakerOf("ada"), "helper");
	expect(claim.stop?.(`web:${minted}`)).toBe(false);
	expect(claim.stop?.("web:unknown")).toBe(false);
	expect(stopped).toEqual([]);
	await h.registry.register({
		key: "web:known",
		kind: "helper",
		visibility: "private",
		principalId: "ada",
	});
	await h.chat.own(speakerOf("ada"), "known");
	expect(claim.stop?.("web:known")).toBe(true);
	expect(stopped).toEqual(["web:known"]);
});
