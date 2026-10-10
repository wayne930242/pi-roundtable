import { expect, test } from "bun:test";
import type {
	ConversationTurnInput,
	ConversationTurns,
	InboundMessage,
} from "pi-roundtable";
import { Refusal } from "./chat.ts";
import { speakerOf, TEST_LIMITS, testChat } from "./testing/fakes.ts";

/** A chat whose turns are recorded and answered at once, with its claim and surface linked. */
async function linked() {
	const turns: ConversationTurnInput[] = [];
	const runner: ConversationTurns = {
		run: async (input) => {
			turns.push(input);
			await harness.registry.register({
				key: input.channel,
				kind: input.kind,
				visibility: "private",
				principalId: input.speaker.principalId,
			});
			const result = { ok: true as const, text: "done" };
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
	const settled = async () => {
		await Promise.all(runs.splice(0));
	};
	return { ...harness, turns, settled };
}

const upload = (
	body: Exclude<RequestInit["body"], undefined>,
	type = "text/plain",
	headers: Record<string, string> = {},
) =>
	new Request("http://chat.test/chat/conversations/x/files", {
		method: "POST",
		headers: { "content-type": type, ...headers },
		body,
	});

async function refusalOf(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Refusal) return error.code;
		throw error;
	}
	throw new Error("expected a Refusal");
}

test("ready tells a client the attachment limits and types", async () => {
	const { connect } = await linked();
	const ada = connect("ada");
	expect(ada.frames[0]).toMatchObject({
		type: "ready",
		attachments: {
			maxBytes: TEST_LIMITS.attachmentBytes,
			perMessage: TEST_LIMITS.attachmentsPerMessage,
			types: TEST_LIMITS.attachmentTypes,
		},
	});
});

test("a message that references an upload runs its turn with the file as an attachment", async () => {
	const { chat, connect, say, turns, settled } = await linked();
	const ada = connect("ada");
	const conversation = chat.open(speakerOf("ada"), "helper");
	const uploaded = await chat.upload(
		speakerOf("ada"),
		conversation,
		upload('{"events":[]}', "application/json"),
		"session.json",
	);
	await say(ada, {
		type: "send",
		id: "m1",
		conversation,
		text: "see the recording",
		attachments: [uploaded.file],
	});
	await settled();
	expect(ada.frames.find((f) => f.type === "error")).toBeUndefined();
	expect(turns).toHaveLength(1);
	expect(turns[0]?.text).toBe("see the recording");
	expect(turns[0]?.attachments?.files).toMatchObject([
		{
			file: uploaded.file,
			name: "session.json",
			contentType: "application/json",
		},
	]);
	expect(ada.frames.at(-1)).toMatchObject({ type: "reply", text: "done" });
});

test("a message without attachments runs a turn that carries none", async () => {
	const { chat, connect, say, turns, settled } = await linked();
	const ada = connect("ada");
	const conversation = chat.open(speakerOf("ada"), "helper");
	await say(ada, { type: "send", id: "m1", conversation, text: "hello" });
	await settled();
	expect(turns).toHaveLength(1);
	expect("attachments" in (turns[0] ?? {})).toBe(false);
});

test("an upload belongs to its conversation's person: another person is forbidden, an unknown conversation is not found", async () => {
	const { chat, connect } = await linked();
	connect("ada");
	connect("bob");
	const conversation = chat.open(speakerOf("ada"), "helper");
	expect(
		await refusalOf(
			chat.upload(speakerOf("bob"), conversation, upload("x"), "a.txt"),
		),
	).toBe("forbidden");
	expect(
		await refusalOf(
			chat.upload(speakerOf("ada"), "no-such", upload("x"), "a.txt"),
		),
	).toBe("unknown_conversation");
});

test("an upload to a conversation recorded for someone else, or shared, is forbidden", async () => {
	const { chat, registry } = await linked();
	await registry.register({
		key: "web:theirs",
		kind: "helper",
		visibility: "private",
		principalId: "bob",
	});
	await registry.register({
		key: "web:common",
		kind: "helper",
		visibility: "shared",
	});
	for (const conversation of ["theirs", "common"])
		expect(
			await refusalOf(
				chat.upload(speakerOf("ada"), conversation, upload("x"), "a.txt"),
			),
		).toBe("forbidden");
});

test("a message naming a file nobody uploaded is refused whole with unknown_attachment, and opens nothing", async () => {
	const { chat, connect, say, turns, settled } = await linked();
	const ada = connect("ada");
	const conversation = chat.open(speakerOf("ada"), "helper");
	await say(ada, {
		type: "send",
		id: "m1",
		conversation,
		text: "see",
		attachments: ["missing.png"],
	});
	await settled();
	expect(ada.frames.at(-1)).toEqual({
		type: "error",
		code: "unknown_attachment",
		ref: "m1",
	});
	expect(ada.frames.some((f) => f.type === "accepted")).toBe(false);
	expect(turns).toEqual([]);
	// The place the refused message would have held is free again.
	await say(ada, { type: "send", id: "m2", conversation, text: "plain" });
	await settled();
	expect(turns).toHaveLength(1);
});

test("a file uploaded to another conversation of the same person is not accepted here", async () => {
	const { chat, connect, say, turns, settled } = await linked();
	const ada = connect("ada");
	const first = chat.open(speakerOf("ada"), "helper");
	const second = chat.open(speakerOf("ada"), "helper");
	const uploaded = await chat.upload(
		speakerOf("ada"),
		first,
		upload("x"),
		"a.txt",
	);
	await say(ada, {
		type: "send",
		id: "m1",
		conversation: second,
		text: "see",
		attachments: [uploaded.file],
	});
	await settled();
	expect(ada.frames.at(-1)).toMatchObject({
		type: "error",
		code: "unknown_attachment",
	});
	expect(turns).toEqual([]);
});

test("a file another person uploaded is not accepted", async () => {
	const { chat, connect, say, turns, settled, attachments } = await linked();
	const ada = connect("ada");
	const conversation = chat.open(speakerOf("ada"), "helper");
	const stored = await attachments.save(`web:${conversation}`, "bob", {
		name: "a.txt",
		contentType: "text/plain",
		data: new TextEncoder().encode("x"),
	});
	await say(ada, {
		type: "send",
		id: "m1",
		conversation,
		text: "see",
		attachments: [stored.file],
	});
	await settled();
	expect(ada.frames.at(-1)).toMatchObject({
		type: "error",
		code: "unknown_attachment",
	});
	expect(turns).toEqual([]);
});

test("a message that opens a conversation cannot carry uploads, which need a conversation first", async () => {
	const { connect, say, turns, settled } = await linked();
	const ada = connect("ada");
	await say(ada, {
		type: "send",
		id: "m1",
		persona: "helper",
		text: "see",
		attachments: ["f1-a.txt"],
	});
	await settled();
	expect(ada.frames.at(-1)).toMatchObject({
		type: "error",
		code: "unknown_attachment",
	});
	expect(turns).toEqual([]);
	// The refused message opened no conversation, so the person's allowance of unused ones is whole.
	for (let i = 0; i < TEST_LIMITS.unusedConversationsPerPrincipal; i += 1)
		await say(ada, {
			type: "send",
			id: `n${i}`,
			persona: "helper",
			text: "hi",
		});
	await settled();
	expect(ada.frames.filter((f) => f.type === "accepted")).toHaveLength(
		TEST_LIMITS.unusedConversationsPerPrincipal,
	);
});

test("a message past the per-message limit is a bad frame, and a repeated file counts each time", async () => {
	const { chat, connect, say, turns, settled } = await linked();
	const ada = connect("ada");
	const conversation = chat.open(speakerOf("ada"), "helper");
	const files: string[] = [];
	for (let i = 0; i < TEST_LIMITS.attachmentsPerMessage + 1; i += 1)
		files.push(
			(
				await chat.upload(
					speakerOf("ada"),
					conversation,
					upload("x"),
					`${i}.txt`,
				)
			).file,
		);
	await say(ada, {
		type: "send",
		id: "m1",
		conversation,
		text: "see",
		attachments: files,
	});
	await settled();
	expect(ada.frames.at(-1)).toEqual({
		type: "error",
		code: "bad_frame",
		ref: "m1",
	});
	const one = files[0] as string;
	await say(ada, {
		type: "send",
		id: "m2",
		conversation,
		text: "see",
		attachments: Array.from(
			{ length: TEST_LIMITS.attachmentsPerMessage + 1 },
			() => one,
		),
	});
	expect(ada.frames.at(-1)).toEqual({
		type: "error",
		code: "bad_frame",
		ref: "m2",
	});
	expect(turns).toEqual([]);
});

test("the person's waiting uploads stay for the next message after a refused one", async () => {
	const { chat, connect, say, turns, settled } = await linked();
	const ada = connect("ada");
	const conversation = chat.open(speakerOf("ada"), "helper");
	const uploaded = await chat.upload(
		speakerOf("ada"),
		conversation,
		upload("x"),
		"a.txt",
	);
	await say(ada, {
		type: "send",
		id: "m1",
		conversation,
		text: "see",
		attachments: [uploaded.file, "missing.txt"],
	});
	expect(ada.frames.at(-1)).toMatchObject({ code: "unknown_attachment" });
	await say(ada, {
		type: "send",
		id: "m2",
		conversation,
		text: "again",
		attachments: [uploaded.file],
	});
	await settled();
	expect(turns[0]?.attachments?.files).toHaveLength(1);
});
