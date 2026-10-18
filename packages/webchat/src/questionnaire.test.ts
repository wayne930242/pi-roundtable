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
import {
	type FakeSocket,
	speakerOf,
	TEST_LIMITS,
	testChat,
} from "./testing/fakes.ts";

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

/** The v1 harness's assertion: no `questionnaire` prompt, and no close for one, ever reached it. */
function neverQuestionnaire(socket: FakeSocket) {
	expect(kinds(socket)).not.toContain("questionnaire");
	const ids = new Set(
		socket.frames.flatMap((f) =>
			f.type === "prompt" && (f.prompt.kind as string) === "questionnaire"
				? [f.prompt.id]
				: [],
		),
	);
	expect(ids.size).toBe(0);
}

async function setup() {
	const harness = testChat();
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
	const desk = new PromptDesk({ send: () => undefined, timeoutMs: 1000 });
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
	expect(TEST_LIMITS.promptTimeoutMs).toBeGreaterThan(0);
});
