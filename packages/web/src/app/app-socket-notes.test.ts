import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { THREADS } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import type { MessagesView, RoomsView, ServerFrame } from "../api-types.ts";
import {
	ADA_DISCORD,
	agentReply,
	BOB_DISCORD,
	type Booted,
	boot,
	Client,
	GUIDE,
	ofType,
	rest,
	SCOUT,
} from "../testing/app-host.ts";

describeDb("internal notes in rooms two owners read", () => {
	let two: Booted;
	beforeAll(async () => {
		two = await boot({ auth: "verifier", secondOwner: true });
	}, 30_000);
	afterAll(async () => {
		await two.stop();
	});
	afterEach(() => two.reset());

	test("the room list says which rooms take notes, threads not among them", async () => {
		const threads = two.host.context.services.get(THREADS);
		const thread = await threads.open(GUIDE, "Notes thread");
		if (!thread) throw new Error("the thread was not opened");
		const rooms = (await (await rest(two, "rooms")).json()) as RoomsView;
		const shown = rooms.rooms.filter((room) => room.kind !== "thread");
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.every((room) => room.notes === true)).toBe(true);
		const found = rooms.rooms.find((room) => room.key === thread.channel);
		expect(found).toBeDefined();
		expect(found).not.toHaveProperty("notes");
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({
			type: "send",
			id: "t1",
			room: thread.channel,
			text: "a note in a thread",
			mode: "note",
		});
		expect((await tab.take(ofType("refused"))).code).toBe("read_only");
		tab.close();
		await thread.close();
	});

	test("a note is shown to the other owner and kept, and the agent hears nothing of it", async () => {
		const ada = await Client.open(two, { "x-actor": "owner" });
		const bob = await Client.open(two, { "x-actor": "owner2" });
		if (!ada || !bob) throw new Error("an owner was refused");
		await ada.take(ofType("ready"));
		await bob.take(ofType("ready"));
		const before = two.seen.length;
		ada.send({
			type: "send",
			id: "n1",
			room: GUIDE,
			text: "note-for-bob-7731",
			mode: "note",
		});
		const accepted = await ada.take(ofType("accepted"));
		expect(accepted).toMatchObject({
			id: "n1",
			room: GUIDE,
			message: {
				kind: "owner",
				author: "Ada",
				principalId: ADA_DISCORD,
				text: "note-for-bob-7731",
				note: true,
			},
		});
		const shown = await bob.take(
			(frame): frame is Extract<ServerFrame, { type: "message" }> =>
				frame.type === "message" && frame.message.text === "note-for-bob-7731",
		);
		expect(shown.message).toMatchObject({
			id: accepted.message.id,
			kind: "owner",
			author: "Ada",
			note: true,
		});
		// No turn: nothing reached the runtime, nothing is typing, and nobody answers.
		expect(
			await bob.sees((frame) => frame.type === "activity" && frame.typing),
		).toBe(false);
		expect(two.seen.length).toBe(before);
		// The history of both owners holds it, marked.
		for (const who of ["owner", "owner2"]) {
			const history = (await (
				await rest(two, `rooms/${encodeURIComponent(GUIDE)}/messages`, { who })
			).json()) as MessagesView;
			expect(
				history.messages.find((m) => m.id === accepted.message.id),
			).toMatchObject({
				text: "note-for-bob-7731",
				note: true,
				author: "Ada",
			});
		}
		// A turn asked after it carries nothing of the note, and the turn's own message is no note.
		bob.send({
			type: "send",
			id: "q1",
			room: GUIDE,
			text: "ask-after-the-note",
		});
		const asked = await bob.take(ofType("accepted"));
		expect(asked.message).not.toHaveProperty("note");
		await bob.take(agentReply("guide"));
		const turn = two.seen.find((r) => r.text.includes("ask-after-the-note"));
		expect(turn).toBeDefined();
		expect(JSON.stringify(turn)).not.toContain("note-for-bob-7731");
		// The newest message of the room is the agent's reply; the note is below it, still marked.
		const noteOnly = (await (
			await rest(two, `rooms/${encodeURIComponent(GUIDE)}/messages`)
		).json()) as MessagesView;
		expect(
			noteOnly.messages.filter((m) => m.note).map((m) => m.text),
		).toContain("note-for-bob-7731");
		expect(
			noteOnly.messages.filter((m) => !m.note && m.kind === "agent").at(-1)
				?.text,
		).toBe("echo ask-after-the-note");
		ada.close();
		bob.close();
	});

	test("each owner's message carries its author's principal, live and in the history, so a page tells whose it is", async () => {
		const ada = await Client.open(two, { "x-actor": "owner" });
		const bob = await Client.open(two, { "x-actor": "owner2" });
		if (!ada || !bob) throw new Error("an owner was refused");
		await ada.take(ofType("ready"));
		await bob.take(ofType("ready"));
		// The log is the database's, so the texts are this run's own.
		const tag = `-${crypto.randomUUID().slice(0, 8)}`;
		ada.send({ type: "send", id: "w1", room: GUIDE, text: `from-ada${tag}` });
		const fromAda = await ada.take(ofType("accepted"));
		expect(fromAda.message).toMatchObject({
			kind: "owner",
			author: "Ada",
			principalId: ADA_DISCORD,
		});
		const shownToBob = await bob.take(
			(frame): frame is Extract<ServerFrame, { type: "message" }> =>
				frame.type === "message" && frame.message.text === `from-ada${tag}`,
		);
		expect(shownToBob.message).toMatchObject({
			kind: "owner",
			author: "Ada",
			principalId: ADA_DISCORD,
		});
		await ada.take(agentReply("guide"));
		bob.send({ type: "send", id: "w2", room: GUIDE, text: `from-bob${tag}` });
		const fromBob = await bob.take(ofType("accepted"));
		expect(fromBob.message).toMatchObject({
			kind: "owner",
			author: "Bob",
			principalId: BOB_DISCORD,
		});
		await bob.take(agentReply("guide"));
		for (const who of ["owner", "owner2"]) {
			const history = (await (
				await rest(two, `rooms/${encodeURIComponent(GUIDE)}/messages`, { who })
			).json()) as MessagesView;
			const owners = history.messages.filter(
				(m) => m.kind === "owner" && m.text.endsWith(tag),
			);
			expect(owners.map((m) => [m.author, m.principalId])).toEqual([
				["Ada", ADA_DISCORD],
				["Bob", BOB_DISCORD],
			]);
		}
		ada.close();
		bob.close();
	});

	test("the server never reads a message's text for @AI: a note frame whose text starts with it stays a note and the agent hears nothing", async () => {
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		const before = two.seen.length;
		for (const [id, text] of [
			["a1", "@AI mention-note-6612"],
			["a2", "forwarded: hey @AI, mention-note-6613"],
		] as const) {
			tab.send({ type: "send", id, room: SCOUT, text, mode: "note" });
			const kept = await tab.take(ofType("accepted"));
			expect(kept.message).toMatchObject({ text, note: true });
		}
		expect(
			await tab.sees((frame) => frame.type === "activity" && frame.typing),
		).toBe(false);
		expect(two.seen.length).toBe(before);
		tab.close();
	});

	test("a turn without a mode is still a turn, and a note needs words or files", async () => {
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({ type: "send", id: "p1", room: SCOUT, text: "plain-turn-5521" });
		await tab.take(agentReply("scout"));
		expect(two.seen.some((r) => r.text === "plain-turn-5521")).toBe(true);
		tab.send({
			type: "send",
			id: "e1",
			room: SCOUT,
			text: "   ",
			mode: "note",
		});
		expect(await tab.take(ofType("refused"))).toMatchObject({
			id: "e1",
			code: "empty",
		});
		tab.send({
			type: "send",
			id: "u1",
			room: SCOUT,
			text: "with a file that is not theirs",
			uploads: ["nope"],
			mode: "note",
		});
		expect((await tab.take(ofType("refused"))).code).toBe("unknown_upload");
		tab.close();
	});
});
