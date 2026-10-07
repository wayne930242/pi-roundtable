import { expect, test } from "bun:test";
import type {
	ConversationTurnInput,
	ConversationTurns,
	InboundMessage,
} from "pi-roundtable";
import { CLOSE_CODES } from "./protocol.ts";
import { fakeSocket, identity, speakerOf, testChat } from "./testing/fakes.ts";

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
	const prompts = chat.surface.prompts(`web:${conversation}`, speakerOf("ada"));
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
		chat.surface.prompts(`web:${conversation}`, speakerOf("eve")),
	).toBeUndefined();
});

test("a question takes only an answer it allows, and an open prompt is sent again on reconnect", async () => {
	const { chat, connect, say } = await linked();
	const conversation = chat.open(speakerOf("ada"), "helper");
	const ada = connect("ada");
	await say(ada, { type: "stop", conversation });
	const prompts = chat.surface.prompts(`web:${conversation}`, speakerOf("ada"));
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
