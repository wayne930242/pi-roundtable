import { expect, test } from "bun:test";
import type {
	ConversationTurnInput,
	ConversationTurns,
	InboundMessage,
} from "pi-roundtable";
import { promptScope } from "pi-roundtable";
import { checkPersonas, type WebChatLimits } from "./chat.ts";
import { oidcSpeakerId } from "./oidc.ts";
import { CLOSE_CODES } from "./protocol.ts";
import {
	type FakeSocket,
	fakeSocket,
	identity,
	speakerOf,
	TEST_LIMITS,
	testChat,
} from "./testing/fakes.ts";

/** A chat whose turns are recorded and answered at once, with its claim and surface linked. */
async function linked(answer = "done") {
	const turns: ConversationTurnInput[] = [];
	const runner: ConversationTurns = {
		run: async (input) => {
			turns.push(input);
			await registryOf().register({
				key: input.channel,
				kind: input.kind,
				visibility: input.conversation?.visibility ?? "shared",
				...(input.conversation?.visibility === "private"
					? { principalId: input.speaker.id }
					: {}),
				...(input.conversation?.title
					? { title: input.conversation.title }
					: {}),
			});
			const result = { ok: true as const, text: answer };
			await input.reply?.(result);
			return result;
		},
	};
	const harness = testChat({ turns: () => runner });
	const registryOf = () => harness.registry;
	const claim = harness.chat.claim();
	const runs: Promise<void>[] = [];
	await harness.chat.surface.start((message: InboundMessage) => {
		const admission = claim.admit(message);
		if (admission?.kind === "turn") runs.push(admission.run());
	});
	const settled = async () => {
		await Promise.all(runs.splice(0));
	};
	return { ...harness, claim, turns, settled };
}

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
		const admission = claim.admit(message);
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

test("an approval goes to the conversation's person, only they answer it, and only at its tier", async () => {
	const { chat, connect, say } = await linked();
	const conversation = chat.open(speakerOf("ada"), "helper");
	const ada = connect("ada");
	const eve = connect("eve");
	await say(ada, { type: "stop", conversation });
	const prompts = chat.surface.prompts(
		`web:${conversation}`,
		promptScope(speakerOf("ada"), "private"),
	);
	if (!prompts) throw new Error("no prompts for the conversation's person");
	// A card the speaker's tier cannot approve is never shown: it stays held.
	expect(await prompts.confirm("Approve?", "Delete it.")).toBe("expired");
	const asked = prompts.confirm("Approve?", "Send it.", undefined, "member");
	const prompt = ada.frames.find((f) => f.type === "prompt");
	if (prompt?.type !== "prompt") throw new Error("no prompt sent");
	expect(eve.frames.some((f) => f.type === "prompt")).toBe(false);
	await say(eve, {
		type: "approval",
		prompt: prompt.prompt.id,
		approved: true,
	});
	expect(eve.frames.at(-1)).toEqual({
		type: "error",
		code: "forbidden",
		ref: prompt.prompt.id,
	});
	await say(ada, {
		type: "approval",
		prompt: prompt.prompt.id,
		approved: true,
	});
	expect(await asked).toBe("approved");
	expect(ada.frames.at(-1)).toMatchObject({
		type: "prompt_closed",
		outcome: "approved",
	});
	expect(
		chat.surface.prompts(
			`web:${conversation}`,
			promptScope(speakerOf("eve"), "private"),
		),
	).toBeUndefined();
});

test("a question takes only an answer it allows, and an open prompt is sent again on reconnect", async () => {
	const { chat, connect, say } = await linked();
	const conversation = chat.open(speakerOf("ada"), "helper");
	const ada = connect("ada");
	await say(ada, { type: "stop", conversation });
	const prompts = chat.surface.prompts(
		`web:${conversation}`,
		promptScope(speakerOf("ada"), "private"),
	);
	const asked = prompts?.ask("Which?", {
		question: "Pick one",
		options: [{ label: "A" }, { label: "B" }],
		multi: false,
		allowOther: false,
	});
	const prompt = ada.frames.find((f) => f.type === "prompt");
	if (prompt?.type !== "prompt") throw new Error("no prompt sent");
	const id = prompt.prompt.id;
	chat.closed(ada);
	const again = connect("ada");
	expect(again.frames.filter((f) => f.type === "prompt")).toEqual([prompt]);
	for (const wrong of [
		{ choices: ["A", "B"] },
		{ choices: ["C"] },
		{ choices: [], text: "my own" },
		{ choices: [] },
	]) {
		await say(again, { type: "answer", prompt: id, ...wrong });
		expect(again.frames.at(-1)).toEqual({
			type: "error",
			code: "bad_frame",
			ref: id,
		});
	}
	await say(again, { type: "answer", prompt: id, choices: ["B"] });
	expect(await asked).toEqual({ choices: ["B"] });
});

test("a token valid for longer than a timer can wait keeps its connection open", async () => {
	const { chat } = await linked();
	const lasting = chat.admitIdentity(identity("ada", ["User"]));
	lasting.identity.expiresAt = new Date(Date.now() + 40 * 24 * 3_600_000);
	const connection = { ...lasting, timers: [] };
	chat.connections.reserve(connection);
	const socket = fakeSocket(connection);
	chat.opened(socket);
	await Bun.sleep(30);
	expect(socket.closed).toBeUndefined();
	expect(socket.frames.some((f) => f.type === "reauth")).toBe(false);
	chat.closed(socket);
});

test("a fresh token renews the connection; one for someone else, or none in time, ends it", async () => {
	const { chat } = await linked();
	const admit = (id: string) => chat.admitIdentity(identity(id, ["User"]));
	const verifying = testChat({
		verifier: async (token) => identity(token, ["User"]),
	});
	const ada = verifying.connect("ada");
	await verifying.say(ada, { type: "auth", token: "ada" });
	expect(ada.frames.filter((f) => f.type === "ready")).toHaveLength(2);
	await verifying.say(ada, { type: "auth", token: "eve" });
	expect(ada.closed?.code).toBe(CLOSE_CODES.notAdmitted);
	// A connection whose token lapses is closed with 4401 after a reauth request.
	const lapsing = admit("ada");
	lapsing.identity.expiresAt = new Date(Date.now() + 50);
	const connection = { ...lapsing, timers: [] };
	chat.connections.reserve(connection);
	const socket = fakeSocket(connection);
	chat.opened(socket);
	await Bun.sleep(80);
	expect(socket.frames.some((f) => f.type === "reauth")).toBe(true);
	expect(socket.closed?.code).toBe(CLOSE_CODES.tokenExpired);
	chat.closed(socket);
});

/** A chat whose turns wait until `finish()`, so they stay running; `fail` makes each turn throw. */
async function gated(
	limits: Partial<WebChatLimits> = {},
	options: { fail?: boolean; start?: boolean } = {},
) {
	const turns: ConversationTurnInput[] = [];
	let open = Promise.withResolvers<void>();
	const runner: ConversationTurns = {
		run: async (input) => {
			turns.push(input);
			await harness.registry.register({
				key: input.channel,
				kind: input.kind,
				visibility: "private",
				principalId: input.speaker.id,
			});
			await open.promise;
			if (options.fail) throw new Error("the model is down");
			return { ok: true as const, text: "done" };
		},
	};
	let clock = 0;
	const harness = testChat({
		turns: () => runner,
		limits: { ...TEST_LIMITS, ...limits },
		now: () => clock,
	});
	const claim = harness.chat.claim();
	const runs: Promise<void>[] = [];
	const start = () =>
		harness.chat.surface.start((message: InboundMessage) => {
			const admission = claim.admit(message);
			if (admission?.kind === "turn")
				runs.push(admission.run().catch(() => undefined));
		});
	if (options.start !== false) await start();
	/** Lets every waiting turn end, and waits for them. */
	const finish = async () => {
		open.resolve();
		await Promise.all(runs.splice(0));
		open = Promise.withResolvers<void>();
	};
	const errors = (socket: FakeSocket) =>
		socket.frames.filter((f) => f.type === "error");
	const accepted = (socket: FakeSocket) =>
		socket.frames.flatMap((f) => (f.type === "accepted" ? [f] : []));
	return {
		...harness,
		turns,
		finish,
		start,
		errors,
		accepted,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

test("a person runs at most turnsPerPrincipal turns at once across conversations; one more is refused busy", async () => {
	const { connect, say, turns, finish, errors, accepted, chat } = await gated({
		turnsPerPrincipal: 2,
		unusedConversationsPerPrincipal: 4,
	});
	const ada = connect("ada");
	await say(ada, { type: "send", id: "1", persona: "helper", text: "one" });
	await say(ada, { type: "send", id: "2", persona: "helper", text: "two" });
	const opened = chat.open(speakerOf("ada"), "helper");
	await say(ada, { type: "send", id: "3", persona: "helper", text: "three" });
	await say(ada, {
		type: "send",
		id: "4",
		conversation: opened,
		text: "four",
	});
	expect(errors(ada)).toEqual([
		{ type: "error", code: "busy", ref: "3" },
		{ type: "error", code: "busy", ref: "4" },
	]);
	expect(accepted(ada)).toHaveLength(2);
	expect(turns).toHaveLength(2);
	// A refused message to a persona opens no conversation: room is left for a fourth.
	chat.open(speakerOf("ada"), "helper");
	expect(() => chat.open(speakerOf("ada"), "helper")).toThrow(
		"too_many_conversations",
	);
	// Someone else is not held back by ada's turns.
	const eve = connect("eve");
	await say(eve, { type: "send", id: "e", persona: "helper", text: "hi" });
	expect(errors(eve)).toEqual([]);
	await finish();
	await say(ada, {
		type: "send",
		id: "5",
		conversation: opened,
		text: "five",
	});
	expect(errors(ada)).toHaveLength(2);
	expect(turns).toHaveLength(4);
	await finish();
});

test("a conversation holds one running turn and at most one queued behind it", async () => {
	const { connect, say, turns, finish, errors, accepted } = await gated({
		turnsPerPrincipal: 5,
	});
	const ada = connect("ada");
	await say(ada, { type: "send", id: "1", persona: "helper", text: "one" });
	const [first] = accepted(ada);
	const conversation = first?.conversation ?? "";
	await say(ada, { type: "send", id: "2", conversation, text: "two" });
	await say(ada, { type: "send", id: "3", conversation, text: "three" });
	expect(errors(ada)).toEqual([{ type: "error", code: "busy", ref: "3" }]);
	expect(turns).toHaveLength(2);
	await finish();
	await say(ada, { type: "send", id: "4", conversation, text: "four" });
	expect(errors(ada)).toHaveLength(1);
	await finish();
});

test("a failed turn, a dropped message, and a refused delivery free their place", async () => {
	const failing = await gated({ turnsPerPrincipal: 1 }, { fail: true });
	const ada = failing.connect("ada");
	await failing.say(ada, {
		type: "send",
		id: "1",
		persona: "helper",
		text: "a",
	});
	await failing.finish();
	await failing.say(ada, {
		type: "send",
		id: "2",
		persona: "helper",
		text: "b",
	});
	expect(failing.errors(ada)).toEqual([]);
	await failing.finish();

	const unstarted = await gated({ turnsPerPrincipal: 1 }, { start: false });
	const eve = unstarted.connect("eve");
	await expect(
		unstarted.say(eve, { type: "send", id: "1", persona: "helper", text: "a" }),
	).rejects.toThrow("has not started");
	await unstarted.start();
	await unstarted.say(eve, {
		type: "send",
		id: "2",
		persona: "helper",
		text: "b",
	});
	expect(unstarted.errors(eve)).toEqual([]);
	await unstarted.finish();

	const dropping = await gated({ turnsPerPrincipal: 1 }, { start: false });
	const claim = dropping.chat.claim();
	await dropping.chat.surface.start((message) => {
		// Another author's message: the claim drops it.
		claim.admit({ ...message, authorId: "someone-else" });
	});
	const bob = dropping.connect("bob");
	await dropping.say(bob, {
		type: "send",
		id: "1",
		persona: "helper",
		text: "a",
	});
	await dropping.say(bob, {
		type: "send",
		id: "2",
		persona: "helper",
		text: "b",
	});
	expect(dropping.errors(bob)).toEqual([]);
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
