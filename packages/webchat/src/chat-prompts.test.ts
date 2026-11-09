import { expect, test } from "bun:test";
import { promptScope } from "pi-roundtable";
import { APPROVAL_MAX_BYTES, CLOSE_CODES } from "./protocol.ts";
import { linked } from "./testing/chat-fixture.ts";
import { fakeSocket, identity, speakerOf, testChat } from "./testing/fakes.ts";

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
	expect(await prompts.confirm("Approve?", "Delete it.")).toBe("unavailable");
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

test("an approval frame carries the structured details beside its unchanged text", async () => {
	const { chat, connect, say } = await linked();
	const conversation = chat.open(speakerOf("ada"), "helper");
	const ada = connect("ada");
	await say(ada, { type: "stop", conversation });
	const prompts = chat.surface.prompts(
		`web:${conversation}`,
		promptScope(speakerOf("ada"), "private"),
	);
	if (!prompts) throw new Error("no prompts for the conversation's person");
	const input = { body: "x".repeat(5_000), to: "a@b.c" };
	const details = {
		action: "send mail",
		tool: "mail_send",
		input,
		files: [{ path: "a.png", bytes: 2048 }, { path: "gone.png" }],
	};
	const asked = prompts.confirm(
		"Approve?",
		"**send mail**",
		undefined,
		"member",
		undefined,
		details,
	);
	const plain = prompts.confirm("Approve?", "Send it.", undefined, "member");
	const frames = ada.frames.flatMap((f) =>
		f.type === "prompt" && f.prompt.kind === "approval" ? [f.prompt] : [],
	);
	expect(frames[0]).toEqual({
		id: frames[0]?.id ?? "",
		kind: "approval",
		title: "Approve?",
		message: "**send mail**",
		approval: details,
	});
	// The full input travels in the frame, and the open prompt keeps it for a reconnect.
	expect(frames[0]?.approval?.input).toEqual(input);
	expect(frames[1]).not.toHaveProperty("approval");
	for (const frame of frames)
		await say(ada, { type: "approval", prompt: frame.id, approved: false });
	expect(await asked).toBe("declined");
	expect(await plain).toBe("declined");
});

test("an approval whose input is over the frame limit carries its values cut and says so", async () => {
	const { chat, connect, say } = await linked();
	const conversation = chat.open(speakerOf("ada"), "helper");
	const ada = connect("ada");
	await say(ada, { type: "stop", conversation });
	const prompts = chat.surface.prompts(
		`web:${conversation}`,
		promptScope(speakerOf("ada"), "private"),
	);
	if (!prompts) throw new Error("no prompts for the conversation's person");
	const input = {
		dataBase64: "A".repeat(2_000_000),
		note: "😀".repeat(400_000),
		to: "a@b.c",
	};
	const asked = prompts.confirm(
		"Approve?",
		"**upload**",
		undefined,
		"member",
		undefined,
		{ action: "upload", tool: "upload", input, files: [{ path: "a.bin" }] },
	);
	const frame = ada.frames.flatMap((f) =>
		f.type === "prompt" && f.prompt.kind === "approval" ? [f.prompt] : [],
	)[0];
	const approval = frame?.approval;
	expect(approval?.truncated).toBe(true);
	expect(
		new TextEncoder().encode(JSON.stringify(approval)).length,
	).toBeLessThanOrEqual(APPROVAL_MAX_BYTES);
	expect(approval?.input.to).toBe("a@b.c");
	expect(String(approval?.input.dataBase64)).toContain("… [2000000 chars]");
	expect(String(approval?.input.note)).toContain("… [400000 chars]");
	expect(String(approval?.input.note)).not.toMatch(/[\ud800-\udbff]… /);
	// The text card travels whole beside it.
	expect(frame?.message).toBe("**upload**");
	if (frame)
		await say(ada, { type: "approval", prompt: frame.id, approved: false });
	expect(await asked).toBe("declined");
});

test("an approval's copy text never costs the call's input: a copy too large for the frame is left out and the input stays whole; a copy that fits is carried", async () => {
	const { chat, connect, say } = await linked();
	const conversation = chat.open(speakerOf("ada"), "helper");
	const ada = connect("ada");
	await say(ada, { type: "stop", conversation });
	const prompts = chat.surface.prompts(
		`web:${conversation}`,
		promptScope(speakerOf("ada"), "private"),
	);
	if (!prompts) throw new Error("no prompts for the conversation's person");
	const ask = (input: Record<string, unknown>, copy: string) =>
		prompts.confirm("Approve?", "**run**", undefined, "member", undefined, {
			action: "run",
			tool: "bash",
			input,
			copy: { text: copy },
		});
	const approvals = () =>
		ada.frames.flatMap((f) =>
			f.type === "prompt" && f.prompt.kind === "approval" ? [f.prompt] : [],
		);
	const input = { command: "echo hello", note: "x".repeat(1_000) };
	const decline = async (asked: Promise<unknown>) => {
		for (const frame of approvals())
			await say(ada, { type: "approval", prompt: frame.id, approved: false });
		await asked;
	};
	// A large copy beside an ordinary input: the input is whole and untruncated, the copy is left out.
	const large = ask(input, "😀".repeat(100_000));
	const first = approvals()[0]?.approval;
	expect(first?.input).toEqual(input);
	expect(first?.truncated).toBeUndefined();
	expect(first?.copy).toBeUndefined();
	// A small copy that fits is carried beside the whole input.
	const small = ask(input, "echo hello");
	const second = approvals()[1]?.approval;
	expect(second?.input).toEqual(input);
	expect(second?.copy).toEqual({ text: "echo hello" });
	// An input that needs cutting keeps all the room it can: the copy that does not fit after is left out.
	const cut = ask({ ...input, data: "A".repeat(2_000_000) }, "echo hello");
	const third = approvals()[2]?.approval;
	expect(third?.truncated).toBe(true);
	expect(String(third?.input.data)).toContain("… [2000000 chars]");
	expect(
		new TextEncoder().encode(JSON.stringify(third)).length,
	).toBeLessThanOrEqual(APPROVAL_MAX_BYTES);
	await decline(Promise.all([large, small, cut]));
});

test("a refused tool's end reaches the client with its reason, and a plain failure has none", async () => {
	const { chat, connect, say } = await linked();
	const conversation = chat.open(speakerOf("ada"), "helper");
	const ada = connect("ada");
	await say(ada, { type: "stop", conversation });
	const channel = `web:${conversation}` as const;
	chat.surface.progress(channel, {
		type: "tool_end",
		id: "1",
		tool: "mail",
		ok: false,
		refused: "declined",
	});
	chat.surface.progress(channel, {
		type: "tool_end",
		id: "2",
		tool: "mail",
		ok: false,
	});
	const ends = ada.frames.flatMap((f) =>
		f.type === "progress" && f.event.type === "tool_end" ? [f.event] : [],
	);
	expect(ends).toEqual([
		{ type: "tool_end", id: "1", tool: "mail", ok: false, refused: "declined" },
		{ type: "tool_end", id: "2", tool: "mail", ok: false },
	]);
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
	const lasting = await chat.admitIdentity(identity("ada", ["User"]));
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
	const lapsing = await admit("ada");
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
