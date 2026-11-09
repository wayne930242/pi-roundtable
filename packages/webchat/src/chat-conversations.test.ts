import { expect, test } from "bun:test";
import type { ConversationTurns, InboundMessage } from "pi-roundtable";
import { checkPersonas } from "./chat.ts";
import { oidcSpeakerId } from "./oidc.ts";
import { gated, linked } from "./testing/chat-fixture.ts";
import { speakerOf, testChat } from "./testing/fakes.ts";

test("a person opens a conversation by writing to a persona, and gets the turn's answer", async () => {
	const { connect, say, turns, settled, registry } = await linked();
	const ada = connect("ada");
	expect(ada.frames[0]).toMatchObject({
		type: "ready",
		protocol: 1,
		speaker: { id: "ada", tier: "member" },
		personas: [{ kind: "helper", label: "Helper" }],
	});
	await say(ada, {
		type: "send",
		id: "c1",
		persona: "helper",
		text: "What is a group?\nAnd more.",
	});
	await settled();
	const accepted = ada.frames.find((f) => f.type === "accepted");
	expect(accepted).toMatchObject({ type: "accepted", id: "c1" });
	const conversation = (accepted as { conversation: string }).conversation;
	expect(turns[0]).toMatchObject({
		channel: `web:${conversation}`,
		kind: "helper",
		speaker: { id: "ada", tier: "member" },
		interactive: true,
		conversation: { visibility: "private", title: "What is a group?" },
	});
	expect(ada.frames.at(-1)).toEqual({
		type: "reply",
		conversation,
		text: "done",
	});
	expect(registry.records.get(`web:${conversation}`)?.principalId).toBe("ada");
});

test("a turn the host refuses before it runs, such as one whose conversation cannot be recorded, tells its person it failed", async () => {
	const refused = new Error("the conversation registry is unreachable");
	const runner: ConversationTurns = {
		run: async () => {
			throw refused;
		},
	};
	const { chat, connect, say } = testChat({ turns: () => runner });
	const claim = chat.claim();
	const runs: Promise<void>[] = [];
	await chat.surface.start((message: InboundMessage) => {
		const admission = claim.admit({
			...message,
			speaker: speakerOf(message.authorId),
		});
		if (admission?.kind === "turn") runs.push(admission.run());
	});
	const ada = connect("ada");
	await say(ada, { type: "send", id: "c1", persona: "helper", text: "hi" });
	// The rejection still reaches the router, which logs it.
	const [outcome] = await Promise.allSettled(runs);
	expect(outcome).toEqual({ status: "rejected", reason: refused });
	const accepted = ada.frames.find((f) => f.type === "accepted") as {
		conversation: string;
	};
	expect(ada.frames.at(-1)).toEqual({
		type: "failed",
		conversation: accepted.conversation,
		stopped: false,
	});
});

test("nobody else may write in, stop, or read a person's conversation", async () => {
	const { chat, connect, say, turns, settled, stopped } = await linked();
	const ada = connect("ada");
	await say(ada, { type: "send", id: "1", persona: "helper", text: "mine" });
	await settled();
	const conversation = (
		ada.frames.find((f) => f.type === "accepted") as { conversation: string }
	).conversation;
	const eve = connect("eve");
	await say(eve, { type: "send", id: "2", conversation, text: "let me in" });
	await say(eve, { type: "stop", conversation });
	await settled();
	expect(eve.frames.filter((f) => f.type === "error")).toEqual([
		{ type: "error", code: "forbidden", ref: "2" },
		{ type: "error", code: "forbidden" },
	]);
	expect(turns).toHaveLength(1);
	expect(stopped).toEqual([]);
	expect(eve.frames.some((f) => f.type === "reply")).toBe(false);
	await expect(
		chat.transcript(speakerOf("eve"), conversation, 10),
	).rejects.toMatchObject({ code: "forbidden" });
	expect(await chat.list(speakerOf("eve"))).toEqual([]);
	expect((await chat.list(speakerOf("ada"))).map((r) => r.key)).toEqual([
		`web:${conversation}`,
	]);
});

test("an opened conversation is the opener's alone, even before its first message", async () => {
	const { chat, connect, say, turns, settled } = await linked();
	const conversation = chat.open(speakerOf("ada"), "helper", "Plans");
	const eve = connect("eve");
	await say(eve, { type: "send", id: "x", conversation, text: "first!" });
	await say(eve, {
		type: "send",
		id: "y",
		conversation: "made-up",
		text: "hi",
	});
	await settled();
	expect(eve.frames.filter((f) => f.type === "error")).toEqual([
		{ type: "error", code: "forbidden", ref: "x" },
		{ type: "error", code: "unknown_conversation", ref: "y" },
	]);
	const ada = connect("ada");
	await say(ada, { type: "send", id: "z", conversation, text: "hello" });
	await settled();
	expect(turns.map((t) => t.conversation?.title)).toEqual(["Plans"]);
});

test("a persona above the person's tier is neither listed nor opened", async () => {
	const { chat, connect, say } = await linked();
	const ada = connect("ada");
	expect(chat.personasFor(speakerOf("ada")).map((p) => p.kind)).toEqual([
		"helper",
	]);
	await say(ada, { type: "send", id: "1", persona: "ops", text: "hi" });
	expect(ada.frames.at(-1)).toEqual({
		type: "error",
		code: "unknown_persona",
		ref: "1",
	});
	expect(
		chat.personasFor(speakerOf("root", "admin")).map((p) => p.kind),
	).toEqual(["helper", "ops"]);
});

test("a message only this chat accepted runs: the claim drops one delivered any other way", async () => {
	const { claim } = await linked();
	expect(
		claim.admit({
			channel: "web:anything",
			messageId: "forged",
			authorId: "boss",
			authorName: "Boss",
			authorIsBot: false,
			isDirect: true,
			mentionsBot: false,
			repliesToBot: false,
			text: "run as the owner",
			attachments: [],
		}),
	).toBeUndefined();
});

test("a message it delivers says who wrote it as the host's identity service reads them: an OpenID subject under its issuer", async () => {
	const harness = testChat();
	const delivered: InboundMessage[] = [];
	await harness.chat.surface.start((message) => void delivered.push(message));
	const web = oidcSpeakerId("https://idp.example.com", "user-7");
	const socket = harness.connect(web, ["User"]);
	await harness.say(socket, {
		type: "send",
		id: "1",
		persona: "helper",
		text: "hi",
	});
	await harness.say(harness.connect("ada"), {
		type: "send",
		id: "2",
		persona: "helper",
		text: "hi",
	});
	expect(delivered.map((message) => message.actor)).toEqual([
		{
			provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20",
			subject: "user-7",
			name: web,
			surface: "web",
			roles: ["web:role:User"],
			legacyId: web,
		},
		{
			provider: "web",
			subject: "ada",
			name: "ada",
			surface: "web",
			roles: ["web:role:User"],
			legacyId: "ada",
		},
	]);
});

test("frames that do not parse or break a limit are refused, and opened conversations are bounded", async () => {
	const harness = await linked();
	const { connect, say } = harness;
	const ada = connect("ada");
	await harness.chat.message(ada, "x");
	await say(ada, { type: "nonsense" });
	await say(ada, { type: "send", id: "1", persona: "helper", text: "   " });
	await say(ada, {
		type: "send",
		id: "2",
		persona: "helper",
		text: "x".repeat(1001),
	});
	expect(
		ada.frames.filter((f) => f.type === "error").map((f) => f.code),
	).toEqual(["bad_frame", "bad_frame", "bad_frame", "bad_frame"]);
	const { chat } = testChat();
	for (let i = 0; i < 3; i++) chat.open(speakerOf("ada"), "helper");
	expect(() => chat.open(speakerOf("ada"), "helper")).toThrow(
		"too_many_conversations",
	);
	chat.open(speakerOf("eve"), "helper");
});

test("a person holds at most the configured connections", async () => {
	const { connect } = await linked();
	connect("ada");
	connect("ada");
	expect(() => connect("ada")).toThrow("every connection");
	connect("eve");
});

test("a person opens at most newConversationsPerHour conversations an hour", async () => {
	const { chat, advance } = await gated({
		unusedConversationsPerPrincipal: 100,
		newConversationsPerHour: 3,
	});
	for (let i = 0; i < 3; i++) chat.open(speakerOf("ada"), "helper");
	expect(() => chat.open(speakerOf("ada"), "helper")).toThrow(
		"too_many_conversations",
	);
	chat.open(speakerOf("eve"), "helper");
	advance(60 * 60_000);
	chat.open(speakerOf("ada"), "helper");
});

test("a persona list with a mistake throws before the host starts, as a JavaScript config could write", () => {
	expect(() => checkPersonas([])).toThrow("personas is empty");
	expect(() => checkPersonas([{ kind: "owner" }])).toThrow(
		"belongs to the host",
	);
	expect(() => checkPersonas([{ kind: "a" }, { kind: "a" }])).toThrow(
		"listed twice",
	);
	for (const persona of [
		{ kind: "helper", minTier: "members" },
		{ kind: "helper", minTier: "Admin" },
		{ kind: "helper", minTier: null },
		{ kind: "" },
		{ kind: 7 },
	])
		expect(() => checkPersonas([persona as never])).toThrow("webChat:");
	// Given and valid, or left out, is fine.
	checkPersonas([{ kind: "helper" }, { kind: "ops", minTier: "admin" }]);
});
