import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type {
	AgentRuntime,
	IdentityService,
	InboundMessage,
} from "pi-roundtable";
import { partial } from "pi-roundtable/testing";
import { webChat } from "./plugin.ts";
import { identity, speakerOf, TEST_LIMITS, testChat } from "./testing/fakes.ts";

const linkedIdentity = (principalId = "p_ada") =>
	partial<IdentityService>({
		resolve: async (facts) => ({
			id: facts.legacyId ?? facts.subject,
			name: facts.name,
			tier: "member",
			principalId,
		}),
	});

test("admission resolves core identity, and ownership and quotas follow principal across actor ids", async () => {
	const { chat } = testChat({ identity: () => linkedIdentity() });
	const a = await chat.admitIdentity(identity("web-a"));
	const b = await chat.admitIdentity(identity("web-b"));
	expect(a.speaker.principalId).toBe("p_ada");
	const conversation = chat.open(a.speaker, "helper");
	await expect(chat.own(b.speaker, conversation)).resolves.toMatchObject({
		minted: { principal: "p_ada" },
	});
	chat.open(b.speaker, "helper");
	chat.open(a.speaker, "helper");
	expect(() => chat.open(b.speaker, "helper")).toThrow(
		"too_many_conversations",
	);
});

test("reauth may change actor within one principal, but a changed principal closes with 4403", async () => {
	let principalId = "p_ada";
	const { chat, connect, say } = testChat({
		identity: () => linkedIdentity(principalId),
		verifier: async (token) => identity(token),
	});
	const socket = connect("web-a", [], "p_ada");
	await say(socket, { type: "auth", token: "web-b" });
	expect(socket.closed).toBeUndefined();
	expect(socket.data.speaker).toMatchObject({
		id: "web-b",
		principalId: "p_ada",
	});
	principalId = "p_eve";
	await say(socket, { type: "auth", token: "web-b" });
	expect(socket.closed?.code).toBe(4403);
	// Closing a rejected renewal still releases the original principal's connection place.
	chat.closed(socket);
});

test("linked actors share connection limits and approval scope", async () => {
	const { chat, connect, say } = testChat();
	const a = connect("web-a", ["User"], "p_ada");
	const b = connect("web-b", ["User"], "p_ada");
	expect(() => connect("web-c", ["User"], "p_ada")).toThrow("every connection");
	const speaker = { ...speakerOf("web-a"), principalId: "p_ada" };
	const conversation = chat.open(speaker, "helper");
	await chat.own(speaker, conversation);
	const prompts = chat.surface.prompts(`web:${conversation}`, {
		principalId: "p_ada",
		speakerId: "web-a",
		tier: "member",
		escalate: "none",
	});
	expect(prompts).toBeDefined();
	const waiting = prompts?.confirm("Approve", "Send", undefined, "member");
	const card = a.frames.find((frame) => frame.type === "prompt");
	if (card?.type !== "prompt") throw new Error("no prompt");
	expect(b.frames).toContainEqual(card);
	await say(b, { type: "approval", prompt: card.prompt.id, approved: true });
	expect(await waiting).toBe("approved");
	chat.closed(a);
	chat.closed(b);
});

test("a dropped core admission never runs the socket's stale principal", async () => {
	const { chat, connect, say } = testChat();
	const claim = chat.claim();
	const admitted: unknown[] = [];
	await chat.surface.start((message: InboundMessage) => {
		admitted.push(
			claim.admit({
				...message,
				speaker: { ...speakerOf(message.authorId), principalId: "other" },
			}),
		);
	});
	const socket = connect("ada");
	await say(socket, { type: "send", id: "1", persona: "helper", text: "hi" });
	expect(admitted).toEqual([undefined]);
	chat.closed(socket);
});

test("linked actor ids share the running-turn budget", async () => {
	const waiting = Promise.withResolvers<void>();
	const { chat, connect, say } = testChat({
		limits: { ...TEST_LIMITS, turnsPerPrincipal: 1 },
		turns: () => ({
			run: async () => {
				await waiting.promise;
				return { ok: true, text: "done" };
			},
		}),
	});
	const runs: Promise<void>[] = [];
	const claim = chat.claim();
	await chat.surface.start((message) => {
		const admitted = claim.admit({
			...message,
			speaker: { ...speakerOf(message.authorId), principalId: "p_ada" },
		});
		if (admitted?.kind === "turn") runs.push(admitted.run());
	});
	const a = connect("web-a", ["User"], "p_ada");
	const b = connect("web-b", ["User"], "p_ada");
	try {
		await say(a, { type: "send", id: "1", persona: "helper", text: "wait" });
		await say(b, { type: "send", id: "2", persona: "helper", text: "another" });
		expect(b.frames.at(-1)).toEqual({ type: "error", code: "busy", ref: "2" });
		expect(runs).toHaveLength(1);
	} finally {
		waiting.resolve();
		await Promise.all(runs);
		chat.closed(a);
		chat.closed(b);
	}
});

test("startFresh refuses an unregistered key before touching runtime", async () => {
	let called = false;
	const { chat, registry } = testChat({
		runtime: () =>
			partial<AgentRuntime>({
				startFresh: async () => {
					called = true;
				},
			}),
	});
	await expect(chat.claim().startFresh("web:unknown")).rejects.toMatchObject({
		code: "unknown_conversation",
	});
	expect(called).toBe(false);
	await registry.register({
		key: "web:known",
		kind: "helper",
		visibility: "private",
		principalId: "p_ada",
	});
	expect(await chat.claim().startFresh("web:known")).toBe("helper");
	expect(called).toBe(true);
});

test("webchat's removed access option fails with surface-scoped core migration guidance", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	expect(readme).toContain('everyone: ["<surface>"]');
	expect(readme).toContain("every surface");
	const removed = () =>
		webChat({
			verifier: async () => identity("ada"),
			origins: "any",
			personas: [{ kind: "helper" }],
			surface: "support",
			access: { members: { roles: ["User"], everyone: true } },
		} as never);
	expect(removed).toThrow("top-level access");
	expect(removed).toThrow("<surface>:role:<role>");
	expect(removed).toThrow('everyone: ["<surface>"]');
	expect(removed).toThrow("every surface");
});
