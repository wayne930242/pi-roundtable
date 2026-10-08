import { expect, test } from "bun:test";
import type { IdentityService, Tier } from "pi-roundtable";
import { partial } from "pi-roundtable/testing";
import { speakerOf, testChat } from "./testing/fakes.ts";

/** A verified token whose core identity/roles can be changed while its socket is open. */
function mutableContact() {
	let tier: Tier | undefined = "admin";
	let principalId = "p_ada";
	const harness = testChat({
		identity: () =>
			partial<IdentityService>({
				resolve: async (facts) =>
					tier
						? {
								id: facts.legacyId ?? facts.subject,
								name: facts.name,
								tier,
								principalId,
							}
						: undefined,
			}),
	});
	return {
		...harness,
		setTier: (value: Tier | undefined) => {
			tier = value;
		},
		relink: () => {
			principalId = "p_other";
		},
	};
}

test("an approval uses the core tier at the answer, not a socket's former role", async () => {
	const { chat, connect, say, setTier } = mutableContact();
	const socket = connect("ada", ["Admin"], "p_ada");
	const speaker = { ...speakerOf("ada", "admin"), principalId: "p_ada" };
	const conversation = chat.open(speaker, "helper");
	await chat.own(speaker, conversation);
	const abort = new AbortController();
	const prompts = chat.surface.prompts(`web:${conversation}`, {
		principalId: "p_ada",
		speakerId: "ada",
		tier: "admin",
		escalate: "none",
	});
	const pending = prompts?.confirm(
		"Approve",
		"Admin action",
		abort.signal,
		"admin",
	);
	try {
		const prompt = socket.frames.find((f) => f.type === "prompt");
		if (prompt?.type !== "prompt") throw new Error("no prompt");
		setTier("member");
		await say(socket, {
			type: "approval",
			prompt: prompt.prompt.id,
			approved: true,
		});
		expect(socket.frames.at(-1)).toMatchObject({
			type: "error",
			code: "forbidden",
		});
		expect(socket.data.speaker.tier).toBe("member");
	} finally {
		abort.abort();
		await pending;
		chat.closed(socket);
	}
});

test("a disabled or relinked core identity cannot keep acting on its old connection", async () => {
	for (const mutate of ["disable", "relink"] as const) {
		const { chat, connect, say, setTier, relink } = mutableContact();
		const socket = connect("ada", ["Admin"], "p_ada");
		if (mutate === "disable") setTier(undefined);
		else relink();
		await say(socket, {
			type: "stop",
			conversation: chat.open(
				{ ...speakerOf("ada"), principalId: "p_ada" },
				"helper",
			),
		});
		expect(socket.closed?.code).toBe(4403);
		chat.closed(socket);
	}
});
