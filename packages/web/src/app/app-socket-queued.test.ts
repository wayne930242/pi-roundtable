import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import type { MessagesView } from "../api-types.ts";
import { until } from "../testing/app-fixture.ts";
import {
	activity,
	agentReply,
	type Booted,
	boot,
	Client,
	ofType,
	rest,
	SCOUT,
} from "../testing/app-host.ts";

describeDb("messages sent during a turn in the app's rooms", () => {
	let two: Booted;
	beforeAll(async () => {
		two = await boot({ auth: "verifier", secondOwner: true });
	}, 30_000);
	afterAll(async () => {
		await two.stop();
	});
	afterEach(() => two.reset());

	/** A turn that runs until `release`, so messages sent meanwhile are steered or queued. */
	function holdTurn(marker: string) {
		const gate = Promise.withResolvers<void>();
		two.scripts.set(marker, async (_request, signal) => {
			const aborted = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await Promise.race([gate.promise, aborted.promise]);
			return { ok: true, text: `held ${marker}` };
		});
		return gate.resolve;
	}

	const messagesOf = async (room: string) =>
		(
			(await (
				await rest(two, `rooms/${encodeURIComponent(room)}/messages`)
			).json()) as MessagesView
		).messages;

	/** Sends to the room and waits until the host has the message queued or steered. */
	async function sendWhileRunning(
		tab: Client,
		room: string,
		id: string,
		text: string,
		delivery: "queued" | "steered",
	) {
		tab.send({ type: "send", id, room, text });
		const accepted = await tab.take(
			(frame) => frame.type === "accepted" && frame.id === id,
		);
		if (accepted.type !== "accepted") throw new Error("expected accepted");
		const shown = await tab.take(
			(frame) =>
				frame.type === "edited" &&
				frame.message.id === accepted.message.id &&
				frame.message.delivery === delivery,
		);
		if (shown.type !== "edited") throw new Error("expected edited");
		return shown.message;
	}

	async function startHeld(tab: Client, room: string, marker: string) {
		tab.send({ type: "send", id: `${marker}-first`, room, text: marker });
		await tab.take(activity(room, { typing: true }));
	}

	test("a message the running turn takes shows as added to it, and stays so after a reload", async () => {
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		const release = holdTurn("hold-steer-1");
		await startHeld(tab, SCOUT, "hold-steer-1");
		const steered = await sendWhileRunning(
			tab,
			SCOUT,
			"st1",
			"steer-me later",
			"steered",
		);
		expect(
			(await messagesOf(SCOUT)).find((m) => m.id === steered.id),
		).toMatchObject({
			delivery: "steered",
		});
		// A steered message offers neither edit nor cancel: it is not in the queue.
		tab.send({ type: "cancel_queued", room: SCOUT, message: steered.id });
		expect((await tab.take(ofType("refused"))).code).toBe("not_queued");
		tab.send({
			type: "edit_queued",
			room: SCOUT,
			message: steered.id,
			text: "changed my mind",
		});
		expect((await tab.take(ofType("refused"))).code).toBe("not_queued");
		release();
		await tab.take(activity(SCOUT, { typing: false }));
		tab.close();
	});

	test("a queued message shows as queued, even after a reload, and is a normal message once its turn starts", async () => {
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		const release = holdTurn("hold-queue-2");
		await startHeld(tab, SCOUT, "hold-queue-2");
		const queued = await sendWhileRunning(
			tab,
			SCOUT,
			"q2",
			"queued-text-2",
			"queued",
		);
		expect(
			(await messagesOf(SCOUT)).find((m) => m.id === queued.id),
		).toMatchObject({
			delivery: "queued",
			text: "queued-text-2",
		});
		release();
		// The mark coming off and the reply are separate frames, in either order.
		const started = await until(async () =>
			tab.frames.find(
				(frame) =>
					frame.type === "edited" &&
					frame.message.id === queued.id &&
					frame.message.delivery === undefined,
			),
		);
		expect(started).toMatchObject({ message: { text: "queued-text-2" } });
		await until(async () =>
			tab.frames.find(
				(frame) =>
					frame.type === "message" &&
					frame.message.text === "echo queued-text-2",
			),
		);
		expect(
			(await messagesOf(SCOUT)).find((m) => m.id === queued.id)?.delivery,
		).toBeUndefined();
		tab.close();
	});

	test("an edit gives the queued turn the new text and shows it edited; the turn runs on it", async () => {
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		const release = holdTurn("hold-edit-3");
		await startHeld(tab, SCOUT, "hold-edit-3");
		const queued = await sendWhileRunning(
			tab,
			SCOUT,
			"q3",
			"first-wording-3",
			"queued",
		);
		tab.send({
			type: "edit_queued",
			room: SCOUT,
			message: queued.id,
			text: "second-wording-3",
		});
		const edited = await tab.take(
			(frame) =>
				frame.type === "edited" && frame.message.text === "second-wording-3",
		);
		expect(edited).toMatchObject({
			message: { id: queued.id, delivery: "queued", edited: true },
		});
		release();
		const reply = await tab.take(
			(frame) =>
				frame.type === "message" &&
				frame.message.text === "echo second-wording-3",
		);
		expect(reply.type).toBe("message");
		expect(two.seen.some((r) => r.text.includes("first-wording-3"))).toBe(
			false,
		);
		tab.close();
	});

	test("a cancel keeps the message, dimmed as cancelled, and its turn never runs", async () => {
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		const release = holdTurn("hold-cancel-4");
		await startHeld(tab, SCOUT, "hold-cancel-4");
		const queued = await sendWhileRunning(
			tab,
			SCOUT,
			"q4",
			"never-run-4",
			"queued",
		);
		tab.send({ type: "cancel_queued", room: SCOUT, message: queued.id });
		const cancelled = await tab.take(
			(frame) =>
				frame.type === "edited" &&
				frame.message.id === queued.id &&
				frame.message.delivery === "cancelled",
		);
		expect(cancelled).toMatchObject({ message: { text: "never-run-4" } });
		// Cancelling again, or editing it now, is too late: it is no longer queued.
		tab.send({ type: "cancel_queued", room: SCOUT, message: queued.id });
		expect((await tab.take(ofType("refused"))).code).toBe("not_queued");
		release();
		await tab.take(activity(SCOUT, { typing: false }));
		await Bun.sleep(100);
		expect(two.seen.some((r) => r.text.includes("never-run-4"))).toBe(false);
		expect(
			(await messagesOf(SCOUT)).find((m) => m.id === queued.id),
		).toMatchObject({ delivery: "cancelled" });
		tab.close();
	});

	test("once its turn has started a queued message can no longer be edited or cancelled", async () => {
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		const release = holdTurn("hold-late-5");
		const slow = Promise.withResolvers<void>();
		two.scripts.set("queued-late-5", async () => {
			await slow.promise;
			return { ok: true, text: "late done" };
		});
		await startHeld(tab, SCOUT, "hold-late-5");
		const queued = await sendWhileRunning(
			tab,
			SCOUT,
			"q5",
			"queued-late-5",
			"queued",
		);
		release();
		await tab.take(
			(frame) =>
				frame.type === "edited" &&
				frame.message.id === queued.id &&
				frame.message.delivery === undefined,
		);
		tab.send({
			type: "edit_queued",
			room: SCOUT,
			message: queued.id,
			text: "too late",
		});
		expect((await tab.take(ofType("refused"))).code).toBe("not_queued");
		tab.send({ type: "cancel_queued", room: SCOUT, message: queued.id });
		expect((await tab.take(ofType("refused"))).code).toBe("not_queued");
		slow.resolve();
		await tab.take(agentReply("scout"));
		expect(
			(await messagesOf(SCOUT)).find((m) => m.id === queued.id)?.text,
		).toBe("queued-late-5");
		tab.close();
	});

	test("only the author changes a queued message", async () => {
		const ada = await Client.open(two, { "x-actor": "owner" });
		const bob = await Client.open(two, { "x-actor": "owner2" });
		if (!ada || !bob) throw new Error("an owner was refused");
		await ada.take(ofType("ready"));
		await bob.take(ofType("ready"));
		const release = holdTurn("hold-author-6");
		await startHeld(ada, SCOUT, "hold-author-6");
		const queued = await sendWhileRunning(
			ada,
			SCOUT,
			"q6",
			"ada-wrote-6",
			"queued",
		);
		bob.send({ type: "cancel_queued", room: SCOUT, message: queued.id });
		expect((await bob.take(ofType("refused"))).code).toBe("forbidden");
		bob.send({
			type: "edit_queued",
			room: SCOUT,
			message: queued.id,
			text: "bob rewrote",
		});
		expect((await bob.take(ofType("refused"))).code).toBe("forbidden");
		release();
		await ada.take(agentReply("scout"));
		await ada.take(agentReply("scout")).catch(() => undefined);
		expect(two.seen.some((r) => r.text.includes("ada-wrote-6"))).toBe(true);
		expect(two.seen.some((r) => r.text.includes("bob rewrote"))).toBe(false);
		ada.close();
		bob.close();
	});

	test("an edit or cancel names a message of the room, an owner's, or is refused", async () => {
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({ type: "cancel_queued", room: SCOUT, message: 2 ** 40 });
		expect((await tab.take(ofType("refused"))).code).toBe("not_queued");
		tab.send({
			type: "edit_queued",
			room: "discord:123",
			message: 1,
			text: "x",
		});
		expect((await tab.take(ofType("refused"))).code).toBe("unknown_room");
		tab.send({ type: "edit_queued", room: SCOUT, message: 0, text: "x" });
		expect((await tab.take(ofType("refused"))).code).toBe("bad_frame");
		tab.send({ type: "edit_queued", room: SCOUT, message: 1 });
		expect((await tab.take(ofType("refused"))).code).toBe("bad_frame");
		tab.close();
	});
});
