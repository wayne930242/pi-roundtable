import { expect, test } from "bun:test";
import {
	type AskSupport,
	type OwnerQuestion,
	promptScope,
	type Questionnaire,
} from "pi-roundtable";
import { PromptDesk } from "./prompts.ts";
import {
	ADVERTISED_ASK,
	type PromptFrame,
	parseClientFrame,
	type ServerFrame,
} from "./protocol.ts";
import { type FakeSocket, speakerOf, testChat } from "./testing/fakes.ts";

const single: OwnerQuestion = {
	question: "Pick one",
	options: [{ label: "A" }, { label: "B" }],
	multi: false,
	allowOther: false,
};
const set: Questionnaire = {
	questions: [
		{ ...single, header: "First" },
		{
			question: "Which mock-up?",
			options: [
				{ label: "X", preview: "<x/>" },
				{ label: "Y", preview: "<y/>" },
			],
			multi: true,
			allowOther: true,
		},
	],
};

const neverDeclared = (socket: FakeSocket) =>
	expect(socket.data.askSupport).toBeUndefined();
const kinds = (socket: FakeSocket) =>
	socket.frames.flatMap((f) => (f.type === "prompt" ? [f.prompt.kind] : []));
const seen = (socket: FakeSocket, kind: PromptFrame["kind"]) =>
	socket.frames.filter((f) => f.type === "prompt" && f.prompt.kind === kind);

/**
 * What a client does: declare after a `ready` that has `prompts`, and never otherwise.
 * `ready` is the one it saw last, so a pre-0.20 server's ready is a ready without `prompts`.
 */
async function client(
	harness: ReturnType<typeof testChat>,
	socket: FakeSocket,
	ready: ServerFrame | undefined = socket.frames.find(
		(f) => f.type === "ready",
	),
	ask?: AskSupport,
) {
	if (ready?.type === "ready" && ready.prompts)
		await harness.declare(socket, ask);
}

/**
 * The v1 harness's assertion: no `questionnaire` prompt reached the socket, and no close for any
 * of the questionnaire `ids` (which only other tabs saw) did either.
 */
function neverQuestionnaire(socket: FakeSocket, ids: string[] = []) {
	expect(kinds(socket)).not.toContain("questionnaire");
	expect(
		socket.frames.filter(
			(f) => f.type === "prompt_closed" && ids.includes(f.prompt),
		),
	).toEqual([]);
}

/** Every `prompt_closed` a socket received. */
const closes = (socket: FakeSocket) =>
	socket.frames.flatMap((f) => (f.type === "prompt_closed" ? [f] : []));

/** The id of the questionnaire a socket was sent last. */
function questionnaireId(socket: FakeSocket): string {
	const frame = seen(socket, "questionnaire").at(-1);
	if (frame?.type !== "prompt") throw new Error("no questionnaire");
	return frame.prompt.id;
}

async function setup(graceMs = 60_000) {
	const harness = testChat({ promptGraceMs: graceMs });
	const conversation = harness.chat.open(speakerOf("ada"), "helper");
	// A conversation is known to its owner once the person writes in it.
	const first = harness.connect("ada");
	await harness.say(first, { type: "stop", conversation });
	harness.chat.closed(first);
	const prompts = () => {
		const found = harness.chat.surface.prompts(
			`web:${conversation}`,
			promptScope(speakerOf("ada"), "private"),
		);
		if (!found) throw new Error("no prompts");
		return found;
	};
	return { ...harness, conversation, prompts };
}

test("the ready frame advertises questionnaires, and the protocol version stays v1", async () => {
	const { connect } = await setup();
	const ada = connect("ada");
	const ready = ada.frames.find((f) => f.type === "ready");
	if (ready?.type !== "ready") throw new Error("no ready");
	expect(ready.prompts).toEqual({ ask: ADVERTISED_ASK });
	expect(ready.protocol).toBe(1);
});

test("matrix: an old client on a new server never declares, gets no questionnaire, and is asked one question at a time", async () => {
	const { connect, prompts } = await setup();
	const ada = connect("ada");
	// It ignores `ready.prompts`, as a pre-0.20 client does.
	expect(prompts().asks).toBeUndefined();
	expect(prompts().questionnaire).toBeUndefined();
	void prompts().ask("Which?", single);
	expect(kinds(ada)).toEqual(["ask"]);
	neverQuestionnaire(ada);
});

test("matrix: a new client on an old server sees no ready.prompts and declares nothing", async () => {
	const harness = await setup();
	const ada = harness.connect("ada");
	const oldReady: ServerFrame = {
		type: "ready",
		protocol: 1,
		speaker: { id: "ada", name: "ada", tier: "member", principalId: "ada" },
		personas: [],
		attachments: { maxBytes: 1, perMessage: 1, types: [] },
		expiresAt: new Date().toISOString(),
	};
	await client(harness, ada, oldReady);
	neverDeclared(ada);
	expect(harness.prompts().asks).toBeUndefined();
	expect(harness.prompts().questionnaire).toBeUndefined();
});

test("matrix: a new client on a new server declares, is sent the questionnaire, and answers it", async () => {
	const harness = await setup();
	const ada = harness.connect("ada");
	await client(harness, ada);
	expect(harness.prompts().asks).toEqual(ADVERTISED_ASK);
	const asked = harness.prompts().questionnaire?.("Set", set);
	const frame = seen(ada, "questionnaire")[0];
	if (frame?.type !== "prompt" || frame.prompt.kind !== "questionnaire")
		throw new Error("no questionnaire");
	expect(frame.prompt.questions).toEqual([...set.questions]);
	await harness.say(ada, {
		type: "answers",
		prompt: frame.prompt.id,
		answers: [{ choices: ["B"] }, null],
		note: " ship it ",
	});
	expect(await asked).toEqual({
		answers: [{ choices: ["B"] }, undefined],
		note: "ship it",
	});
	expect(ada.frames.at(-1)).toMatchObject({
		type: "prompt_closed",
		outcome: "answered",
	});
});

test("matrix: with an old tab and a new tab open, only the new tab is sent the questionnaire", async () => {
	const harness = await setup();
	const old = harness.connect("ada");
	const fresh = harness.connect("ada");
	await client(harness, fresh);
	const asked = harness.prompts().questionnaire?.("Set", set);
	expect(seen(fresh, "questionnaire")).toHaveLength(1);
	neverQuestionnaire(old);
	const frame = seen(fresh, "questionnaire")[0];
	if (frame?.type !== "prompt") throw new Error("no frame");
	await harness.say(fresh, {
		type: "answers",
		prompt: frame.prompt.id,
		answers: [{ choices: ["A"] }, null],
	});
	await asked;
	// The close of a prompt the old tab never saw does not reach it either.
	expect(old.frames.map((f) => f.type)).toEqual(["ready"]);
});

test("matrix: the person's support is the least of the tabs that declared", async () => {
	const harness = await setup();
	const a = harness.connect("ada");
	const b = harness.connect("ada");
	await client(harness, a);
	await harness.declare(b, { questions: 2, previews: false, note: false });
	expect(harness.prompts().asks).toEqual({
		questions: 2,
		previews: false,
		note: false,
	});
	// A set with previews does not reach the tab that cannot show them.
	void harness.prompts().questionnaire?.("Set", set);
	expect(seen(a, "questionnaire")).toHaveLength(1);
	neverQuestionnaire(b);
});

test("matrix: on reconnect the open questionnaire waits for the declaration, then is sent", async () => {
	const harness = await setup();
	const first = harness.connect("ada");
	await client(harness, first);
	void harness.prompts().questionnaire?.("Set", set);
	expect(seen(first, "questionnaire")).toHaveLength(1);
	harness.chat.closed(first);
	const again = harness.connect("ada");
	// `ready` came and the open prompts were re-sent, before the client could declare: not yet.
	neverQuestionnaire(again);
	await client(harness, again);
	expect(seen(again, "questionnaire")).toHaveLength(1);
	// A repeated declaration (after a reauth's ready) does not send it a third time.
	await client(harness, again);
	expect(seen(again, "questionnaire")).toHaveLength(1);
});

test("a v1 client harness never receives a questionnaire in any of the flows above", async () => {
	const harness = await setup();
	const old = harness.connect("ada");
	const fresh = harness.connect("ada");
	await client(harness, fresh);
	void harness.prompts().questionnaire?.("Set", set);
	harness.chat.closed(old);
	const reconnected = harness.connect("ada");
	neverQuestionnaire(reconnected);
	neverQuestionnaire(old);
});

test("a questionnaire is not in the open prompts of a connection that declared nothing", () => {
	const desk = new PromptDesk({
		send: () => undefined,
		sendWhere: () => undefined,
		sendOne: () => undefined,
		supports: () => [],
		timeoutMs: 1000,
	});
	const scope = promptScope(speakerOf("ada"), "private");
	void desk.prompts("c", scope).ask("Which?", single);
	expect(desk.openFor("ada").map((f) => f.type)).toEqual(["prompt"]);
});

test("answers: a malformed frame, an answer that does not fit, and another person are refused", async () => {
	const harness = await setup();
	const ada = harness.connect("ada");
	const bob = harness.connect("bob");
	await client(harness, ada);
	void harness.prompts().questionnaire?.("Set", set);
	const frame = seen(ada, "questionnaire")[0];
	if (frame?.type !== "prompt") throw new Error("no frame");
	const id = frame.prompt.id;
	const refusal = (socket: FakeSocket) => socket.frames.at(-1);
	for (const malformed of [
		{ answers: "A" },
		{ answers: [] },
		{ answers: [1] },
		{ answers: [{ choices: [1] }] },
		{ answers: [{ choices: ["A"], text: 3 }] },
		{ answers: [null, null, null, null, null] },
		{ answers: [null], note: 3 },
	]) {
		await harness.say(ada, { type: "answers", prompt: id, ...malformed });
		expect(refusal(ada)).toEqual({ type: "error", code: "bad_frame" });
	}
	for (const unfit of [
		{ answers: [null, null] },
		{ answers: [{ choices: ["Z"] }, null] },
		{ answers: [{ choices: ["A", "B"] }, null] },
		{ answers: [{ choices: ["A"] }] },
		{ answers: [{ choices: ["A"] }, { choices: ["X"], text: "x" }, null] },
	]) {
		await harness.say(ada, { type: "answers", prompt: id, ...unfit });
		expect(refusal(ada)).toEqual({ type: "error", code: "bad_frame", ref: id });
	}
	await harness.say(bob, {
		type: "answers",
		prompt: id,
		answers: [{ choices: ["A"] }, null],
	});
	expect(refusal(bob)).toEqual({ type: "error", code: "forbidden", ref: id });
	await harness.say(ada, {
		type: "answers",
		prompt: "nope",
		answers: [{ choices: ["A"] }, null],
	});
	expect(refusal(ada)).toEqual({
		type: "error",
		code: "unknown_prompt",
		ref: "nope",
	});
});

test("prompt_features: only a well-formed declaration is taken", () => {
	const ask = { questions: 4, previews: true, note: false };
	expect(
		parseClientFrame(JSON.stringify({ type: "prompt_features", ask })),
	).toEqual({
		type: "prompt_features",
		ask,
	});
	for (const bad of [
		{},
		{ ask: { questions: 0, previews: true, note: true } },
		{ ask: { questions: 5, previews: true, note: true } },
		{ ask: { questions: 1.5, previews: true, note: true } },
		{ ask: { questions: 2, previews: "yes", note: true } },
		{ ask: { questions: 2, previews: true } },
	])
		expect(
			parseClientFrame(JSON.stringify({ type: "prompt_features", ...bad })),
		).toBeUndefined();
});

test("a malformed prompt_features frame is refused as bad_frame", async () => {
	const harness = await setup();
	const ada = harness.connect("ada");
	await harness.say(ada, { type: "prompt_features", ask: { questions: 9 } });
	expect(ada.frames.at(-1)).toEqual({ type: "error", code: "bad_frame" });
});

test("a declaring tab that closes mid-questionnaire: the prompt expires after the grace and the old tab sees nothing", async () => {
	const harness = await setup(30);
	const old = harness.connect("ada");
	const fresh = harness.connect("ada");
	await client(harness, fresh);
	const asked = harness.prompts().questionnaire?.("Set", set);
	const id = questionnaireId(fresh);
	harness.chat.closed(fresh);
	// The old tab cannot answer it: it is not shown one, and a v1 `answer` finds no `ask`.
	await harness.say(old, { type: "answer", prompt: id, choices: ["A"] });
	expect(old.frames.at(-1)).toMatchObject({ code: "unknown_prompt" });
	expect(await asked).toBeUndefined();
	neverQuestionnaire(old, [id]);
	// A re-ask now falls back to the sequential path.
	expect(harness.prompts().asks).toBeUndefined();
});

test("a declaring tab that reconnects within the grace keeps the questionnaire", async () => {
	const harness = await setup(60);
	const first = harness.connect("ada");
	await client(harness, first);
	let settled = false;
	const asked = harness.prompts().questionnaire?.("Set", set);
	void asked?.then(() => {
		settled = true;
	});
	const id = questionnaireId(first);
	harness.chat.closed(first);
	await Bun.sleep(20);
	const again = harness.connect("ada");
	await client(harness, again);
	await Bun.sleep(80);
	expect(settled).toBe(false);
	await harness.say(again, {
		type: "answers",
		prompt: id,
		answers: [{ choices: ["A"] }, null],
	});
	expect(await asked).toEqual({ answers: [{ choices: ["A"] }, undefined] });
});

test("a questionnaire sent to no tab that can show it expires after the grace, not the prompt timeout", async () => {
	const harness = await setup(30);
	const old = harness.connect("ada");
	// The old tab never declared: the set reaches no one. With a tab or none, the wait is the same
	// short grace, because a panel that declares in time can still take it.
	const asked = harness.prompts().questionnaire;
	expect(asked).toBeUndefined();
	// A declaring tab appears, asks, then narrows so it cannot show the set: sent to it, then stranded.
	const fresh = harness.connect("ada");
	await client(harness, fresh);
	const pending = harness.prompts().questionnaire?.("Set", set);
	const id = questionnaireId(fresh);
	await harness.declare(fresh, { questions: 1, previews: false, note: false });
	// It was sent the set, so it hears the close; the old tab never does.
	expect(await pending).toBeUndefined();
	expect(closes(fresh).map((c) => c.prompt)).toEqual([id]);
	neverQuestionnaire(old, [id]);
});

test("a questionnaire asked while no tab is connected expires after the grace", async () => {
	const harness = await setup(30);
	const first = harness.connect("ada");
	await client(harness, first);
	const questionnaire = harness.prompts().questionnaire;
	harness.chat.closed(first);
	const started = Date.now();
	expect(await questionnaire?.("Set", set)).toBeUndefined();
	expect(Date.now() - started).toBeLessThan(1000);
});

test("cancel and expiry of a questionnaire do not reach a v1 tab", async () => {
	const harness = await setup(30);
	const old = harness.connect("ada");
	const fresh = harness.connect("ada");
	await client(harness, fresh);
	const stop = new AbortController();
	const cancelled = harness.prompts().questionnaire?.("Set", set, stop.signal);
	const id = questionnaireId(fresh);
	stop.abort();
	expect(await cancelled).toBeUndefined();
	expect(closes(fresh).map((c) => [c.prompt, c.outcome])).toEqual([
		[id, "cancelled"],
	]);
	neverQuestionnaire(old, [id]);
	// Expiry: the declaring tab closes, the grace runs out.
	const expiring = harness.prompts().questionnaire?.("Set", set);
	const second = questionnaireId(fresh);
	harness.chat.closed(fresh);
	expect(await expiring).toBeUndefined();
	neverQuestionnaire(old, [id, second]);
});

test("a tab that narrows its declaration still hears the close of a questionnaire it was sent", async () => {
	const harness = await setup();
	const ada = harness.connect("ada");
	await client(harness, ada);
	const asked = harness.prompts().questionnaire?.("Set", set);
	const id = questionnaireId(ada);
	await harness.declare(ada, { questions: 1, previews: false, note: false });
	const other = harness.connect("ada");
	await client(harness, other);
	await harness.say(other, {
		type: "answers",
		prompt: id,
		answers: [{ choices: ["A"] }, null],
	});
	await asked;
	expect(closes(ada).map((c) => c.prompt)).toEqual([id]);
	expect(closes(other).map((c) => c.prompt)).toEqual([id]);
});

test("a second tab answering after the first gets unknown_prompt", async () => {
	const harness = await setup();
	const a = harness.connect("ada");
	const b = harness.connect("ada");
	await client(harness, a);
	await client(harness, b);
	const asked = harness.prompts().questionnaire?.("Set", set);
	const id = questionnaireId(a);
	const body = {
		type: "answers",
		prompt: id,
		answers: [{ choices: ["A"] }, null],
	};
	await harness.say(a, body);
	await asked;
	await harness.say(b, body);
	expect(b.frames.at(-1)).toEqual({
		type: "error",
		code: "unknown_prompt",
		ref: id,
	});
});

test("own text and the note are taken at 1000 characters and refused at 1001", async () => {
	const harness = await setup();
	const ada = harness.connect("ada");
	await client(harness, ada);
	const asked = harness.prompts().questionnaire?.("Set", set);
	const id = questionnaireId(ada);
	const send = (text: string, note: string) =>
		harness.say(ada, {
			type: "answers",
			prompt: id,
			answers: [null, { choices: [], text }],
			note,
		});
	await send("x".repeat(1001), "n");
	expect(ada.frames.at(-1)).toEqual({
		type: "error",
		code: "bad_frame",
		ref: id,
	});
	await send("x", "n".repeat(1001));
	expect(ada.frames.at(-1)).toEqual({
		type: "error",
		code: "bad_frame",
		ref: id,
	});
	await send("x".repeat(1000), "n".repeat(1000));
	expect(await asked).toMatchObject({ note: "n".repeat(1000) });
});

test("a reauth greeting re-sends the open questionnaire to a declaring connection even if it was already sent", async () => {
	const harness = await setup();
	const ada = harness.connect("ada");
	await client(harness, ada);
	void harness.prompts().questionnaire?.("Set", set);
	// A fresh `ready` (as after reauth) re-sends the open prompts the connection can show.
	harness.chat.opened(ada);
	expect(seen(ada, "questionnaire")).toHaveLength(2);
	const old = harness.connect("ada");
	harness.chat.opened(old);
	neverQuestionnaire(old);
});

test("a tab that narrows its declaration and widens again is sent the questionnaire again and can answer it", async () => {
	const harness = await setup(60);
	const ada = harness.connect("ada");
	await client(harness, ada);
	const asked = harness.prompts().questionnaire?.("Set", set);
	const id = questionnaireId(ada);
	await harness.declare(ada, { questions: 1, previews: false, note: false });
	await harness.declare(ada);
	expect(seen(ada, "questionnaire")).toHaveLength(2);
	await harness.say(ada, {
		type: "answers",
		prompt: id,
		answers: [{ choices: ["A"] }, null],
	});
	expect(await asked).toEqual({ answers: [{ choices: ["A"] }, undefined] });
});

test("a questionnaire obtained while a declaring tab was open expires after the grace when it closes before the call, and a v1 tab sees nothing", async () => {
	const harness = await setup(30);
	const old = harness.connect("ada");
	const fresh = harness.connect("ada");
	await client(harness, fresh);
	const questionnaire = harness.prompts().questionnaire;
	harness.chat.closed(fresh);
	expect(await questionnaire?.("Set", set)).toBeUndefined();
	expect(old.frames.map((f) => f.type)).toEqual(["ready"]);
});
