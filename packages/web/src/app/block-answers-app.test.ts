import { afterAll, beforeAll, expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import type {
	BlockFields,
	MessagesView,
	RoomMessage,
	ServerFrame,
} from "../api-types.ts";
import {
	activity,
	type Booted,
	boot,
	Client,
	ofType,
	rest,
	SCOUT,
} from "../testing/app-host.ts";

const OPTIONS = (first: string, second: string) =>
	["```options", `- title: ${first}`, `- title: ${second}`, "```"].join("\n");

/** The first frame the tab has received from its `from`th on that `match` accepts, whatever order the others came in; waits a few seconds. */
async function waitFor<T extends ServerFrame>(
	tab: Client,
	match: (frame: ServerFrame) => frame is T,
	from?: number,
): Promise<T>;
async function waitFor(
	tab: Client,
	match: (frame: ServerFrame) => boolean,
	from?: number,
): Promise<ServerFrame>;
async function waitFor(
	tab: Client,
	match: (frame: ServerFrame) => boolean,
	from = 0,
): Promise<ServerFrame> {
	const deadline = Date.now() + 4000;
	for (;;) {
		const found = tab.frames.slice(from).find(match);
		if (found) return found;
		if (Date.now() > deadline)
			throw new Error(
				`no frame arrived; got ${tab.frames.map((f) => f.type).join(", ")}`,
			);
		await Bun.sleep(10);
	}
}

describeDb("an interactive block answered over a real host", () => {
	let app: Booted;
	beforeAll(async () => {
		app = await boot({ auth: "verifier" });
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});

	const open = async (who = "owner") => {
		const tab = await Client.open(app, { "x-actor": who });
		if (!tab) throw new Error(`${who} was refused`);
		await waitFor(tab, ofType("ready"));
		return tab;
	};
	const history = async (): Promise<RoomMessage[]> =>
		(
			(await (
				await rest(app, `rooms/${encodeURIComponent(SCOUT)}/messages`)
			).json()) as MessagesView
		).messages;

	/** The agent replies to `marker` with a block; resolves to the stored reply. */
	async function asked(tab: Client, marker: string, block: string) {
		app.scripts.set(marker, async () => ({
			ok: true,
			text: `Choose.\n\n${block}`,
		}));
		tab.send({ type: "send", id: `ask-${marker}`, room: SCOUT, text: marker });
		const frame = await waitFor(
			tab,
			(one) =>
				one.type === "message" &&
				one.message.agent === "scout" &&
				one.message.text.includes(block),
		);
		if (frame.type !== "message") throw new Error("expected a message");
		return frame.message;
	}
	const answerOf = (
		reply: RoomMessage,
		title: string,
		id = `a-${title}`,
		block = 0,
	) => ({
		type: "block_answer",
		id,
		room: SCOUT,
		message: reply.id,
		block,
		answer: { kind: "pick", fields: [["picked", title]] },
	});
	/** A turn that runs until released, so an answer sent meanwhile is steered or queued. */
	function holdTurn(marker: string) {
		const gate = Promise.withResolvers<void>();
		app.scripts.set(marker, async () => {
			await gate.promise;
			return { ok: true, text: `held ${marker}` };
		});
		return gate.resolve;
	}
	const lockedWith =
		(reply: RoomMessage, fields: BlockFields | undefined) =>
		(frame: ServerFrame) =>
			frame.type === "edited" &&
			frame.message.id === reply.id &&
			JSON.stringify(frame.message.answers?.[0]?.fields) ===
				JSON.stringify(fields);

	test("an answer to an idle room starts a turn that reads it as the owner's message, and the block locks on every socket and in history", async () => {
		const tab = await open();
		const other = await open();
		const reply = await asked(tab, "ask-idle", OPTIONS("SQLite", "Postgres"));
		tab.send(answerOf(reply, "SQLite"));
		const accepted = await waitFor(
			tab,
			(frame) => frame.type === "accepted" && frame.id === "a-SQLite",
		);
		expect(accepted).toMatchObject({
			room: SCOUT,
			message: { kind: "owner", author: "Ada", text: 'User picked "SQLite".' },
		});
		// The turn the answer started read exactly that text, as the owner's.
		const turn = app.seen.find((request) =>
			request.text.includes('User picked "SQLite".'),
		);
		expect(turn?.channel).toBe(SCOUT);
		expect(turn?.speaker).toMatchObject({ tier: "owner" });
		// The other tab sees the answer as a message and the block locked.
		await waitFor(
			other,
			(frame) =>
				frame.type === "message" &&
				frame.message.text === 'User picked "SQLite".',
		);
		await waitFor(other, lockedWith(reply, [["picked", "SQLite"]]));
		await waitFor(tab, lockedWith(reply, [["picked", "SQLite"]]));
		const stored = (await history()).find((one) => one.id === reply.id);
		expect(stored?.answers).toEqual([
			{ block: 0, fields: [["picked", "SQLite"]] },
		]);
		tab.close();
		other.close();
	});

	test("a second answer, from any tab, is refused with what answered the block, and starts no turn", async () => {
		const tab = await open();
		const other = await open();
		const reply = await asked(tab, "ask-twice", OPTIONS("Red", "Blue"));
		tab.send(answerOf(reply, "Red", "first"));
		await waitFor(
			tab,
			(frame) => frame.type === "accepted" && frame.id === "first",
		);
		const before = app.seen.length;
		other.send(answerOf(reply, "Blue", "second"));
		const refused = await waitFor(other, ofType("block_refused"));
		expect(refused).toMatchObject({
			id: "second",
			room: SCOUT,
			message: reply.id,
			block: 0,
			code: "answered",
			fields: [["picked", "Red"]],
		});
		await Bun.sleep(150);
		expect(
			app.seen.slice(before).some((request) => request.text.includes("Blue")),
		).toBe(false);
		tab.close();
		other.close();
	});

	test("an answer sent during a turn is steered into it when the turn takes it, as a typed message is", async () => {
		const tab = await open();
		const reply = await asked(tab, "ask-steer", OPTIONS("steer-me", "other"));
		const release = holdTurn("hold-steer-answer");
		const mark = tab.frames.length;
		tab.send({
			type: "send",
			id: "h1",
			room: SCOUT,
			text: "hold-steer-answer",
		});
		await waitFor(tab, activity(SCOUT, { typing: true }), mark);
		tab.send(answerOf(reply, "steer-me"));
		const accepted = await waitFor(
			tab,
			(frame) => frame.type === "accepted" && frame.id === "a-steer-me",
		);
		if (accepted.type !== "accepted") throw new Error("expected accepted");
		await waitFor(
			tab,
			(frame) =>
				frame.type === "edited" &&
				frame.message.id === accepted.message.id &&
				frame.message.delivery === "steered",
		);
		release();
		tab.close();
	});

	test("an answer that waits for its turn can be cancelled, and the block opens again", async () => {
		const tab = await open();
		const reply = await asked(tab, "ask-queued", OPTIONS("first", "second"));
		const release = holdTurn("hold-queue-answer");
		const mark = tab.frames.length;
		tab.send({
			type: "send",
			id: "h2",
			room: SCOUT,
			text: "hold-queue-answer",
		});
		await waitFor(tab, activity(SCOUT, { typing: true }), mark);
		tab.send(answerOf(reply, "second"));
		const accepted = await waitFor(
			tab,
			(frame) => frame.type === "accepted" && frame.id === "a-second",
		);
		if (accepted.type !== "accepted") throw new Error("expected accepted");
		await waitFor(
			tab,
			(frame) =>
				frame.type === "edited" &&
				frame.message.id === accepted.message.id &&
				frame.message.delivery === "queued",
		);
		await waitFor(tab, lockedWith(reply, [["picked", "second"]]));
		tab.send({
			type: "cancel_queued",
			room: SCOUT,
			message: accepted.message.id,
		});
		const reopened = await waitFor(
			tab,
			(frame) =>
				frame.type === "edited" &&
				frame.message.id === reply.id &&
				frame.message.answers === undefined,
		);
		expect(reopened.type).toBe("edited");
		expect(
			(await history()).find((one) => one.id === reply.id)?.answers,
		).toBeUndefined();
		// Answered again, the block takes it.
		tab.send(answerOf(reply, "first", "again"));
		await waitFor(
			tab,
			(frame) => frame.type === "accepted" && frame.id === "again",
		);
		release();
		tab.close();
	});

	test("a block of an earlier conversation and a room that is not the app's are refused", async () => {
		const tab = await open();
		const reply = await asked(tab, "ask-old", OPTIONS("a", "b"));
		tab.send({ ...answerOf(reply, "a", "r1"), room: "app:agent.nobody" });
		expect(await waitFor(tab, ofType("block_refused"))).toMatchObject({
			id: "r1",
			code: "unknown_room",
		});
		expect(
			(
				await rest(app, `rooms/${encodeURIComponent(SCOUT)}/start-over`, {
					method: "POST",
				})
			).status,
		).toBe(200);
		tab.send(answerOf(reply, "a", "old"));
		expect(
			await waitFor(
				tab,
				(frame) => frame.type === "block_refused" && frame.id === "old",
			),
		).toMatchObject({
			id: "old",
			code: "unanswerable",
		});
		tab.close();
	});
});
