import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import type { HostCardView } from "../api-types.ts";
import {
	app,
	Client,
	external,
	hostAppSuite,
	ofType,
	PNG,
	post,
	READ_WRITE,
	ROOM_A,
	ROOM_A_ID,
	ROOM_B,
	rest,
	web,
} from "../testing/host-app-host.ts";
import type { HostListView, HostMessagesView, HostRoomView } from "./views.ts";

describeDb("the host rooms over a real host: lists, posts and cards", () => {
	hostAppSuite();

	test("a kind's list is the viewer's own: a reader gets their rooms, and the app counts what is unread, not the host", async () => {
		const list = (await (
			await rest(app, "host/inbox", { who: "mel" })
		).json()) as HostListView;
		expect(list).toMatchObject({ kind: "inbox", label: "Inbox" });
		expect(list.rooms.map((room) => room.key)).toEqual([ROOM_A]);
		expect(list.rooms[0]).toMatchObject({
			title: `Thread ${ROOM_A_ID}`,
			picture: { initials: "TH", color: "#336699" },
		});
		// The host said 99; the app has nothing to read in a room with no messages.
		expect(list.rooms[0]?.unread).toBeUndefined();
		const ada = (await (
			await rest(app, "host/inbox", { who: "ada" })
		).json()) as HostListView;
		expect(ada.rooms.map((room) => room.key).sort()).toEqual(
			[ROOM_A, ROOM_B].sort(),
		);
		// Config names the kind for those who may list it.
		const config = (await (
			await rest(app, "config", { who: "mel" })
		).json()) as {
			kinds?: { kind: string; label: string; icon?: string }[];
			pages?: { id: string }[];
		};
		expect(config.kinds).toEqual([
			{ kind: "inbox", label: "Inbox", icon: "chat" },
		]);
		expect(config.pages ?? []).toEqual([]);
		const zed = (await (await rest(app, "config", { who: "zed" })).json()) as {
			kinds?: unknown[];
		};
		expect(zed.kinds ?? []).toEqual([]);
	});

	test("someone the kind gives nothing gets 404 on the list, the room, its messages, an action, a send and a file, and cannot follow it", async () => {
		const file = await web.rooms.saveFile(ROOM_A, {
			name: "photo.png",
			type: "image/png",
			bytes: PNG,
		});
		const zed = await Client.open(app, "zed");
		expect((await rest(app, "host/inbox", { who: "zed" })).status).toBe(404);
		expect(
			(await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "zed" })).status,
		).toBe(404);
		expect(
			(await rest(app, `host/inbox/${ROOM_A_ID}/messages`, { who: "zed" }))
				.status,
		).toBe(404);
		expect(
			(
				await post(
					app,
					`host/inbox/${ROOM_A_ID}/act`,
					{ action: "assign" },
					"zed",
				)
			).status,
		).toBe(404);
		expect((await rest(app, `files/${file}`, { who: "zed" })).status).toBe(404);
		// Another kind of lookup: a room of a kind nobody registered.
		expect(
			(await rest(app, `host/nothing/${ROOM_A_ID}`, { who: "ada" })).status,
		).toBe(404);
		zed.send({ type: "subscribe", room: ROOM_A });
		expect(await zed.take(ofType("refused"))).toMatchObject({
			code: "unknown_room",
		});
		zed.send({
			type: "send",
			id: "z1",
			room: ROOM_A,
			text: "let me in",
			mode: "note",
		});
		expect(await zed.take(ofType("refused"))).toMatchObject({
			id: "z1",
			code: "unknown_room",
		});
		zed.send({ type: "focus", room: ROOM_A });
		zed.send({ type: "read", room: ROOM_A, upTo: 1 });
		expect(await zed.take(ofType("refused"))).toMatchObject({
			code: "unknown_room",
		});
		// An upload of their own cannot be attached to a room they cannot read.
		const form = new FormData();
		form.set("file", new File([PNG], "mine.png", { type: "image/png" }));
		const upload = (await (
			await rest(app, "uploads", { method: "POST", body: form, who: "zed" })
		).json()) as { id: string };
		zed.send({
			type: "send",
			id: "z2",
			room: ROOM_A,
			text: "",
			uploads: [upload.id],
			mode: "note",
		});
		expect(await zed.take(ofType("refused"))).toMatchObject({
			id: "z2",
			code: "unknown_room",
		});
		expect(app.state.sends.some((sent) => sent.who === "zed")).toBe(false);
		zed.close();
		// The reader of the room is served the file; an owner who is not a reader of its room is not.
		expect((await rest(app, `files/${file}`, { who: "mel" })).status).toBe(200);
		app.state.grants.get(app.principals.ada)?.delete(ROOM_A_ID);
		web.rooms.accessChanged(app.principals.ada);
		await Bun.sleep(50);
		expect((await rest(app, `files/${file}`, { who: "ada" })).status).toBe(404);
		app.state.grants.get(app.principals.ada)?.set(ROOM_A_ID, READ_WRITE);
		web.rooms.accessChanged(app.principals.ada);
		await Bun.sleep(50);
		expect((await rest(app, `files/${file}`, { who: "ada" })).status).toBe(200);
	});

	test("a message's files zip for a reader of its room; someone the kind gives nothing gets the file's 404", async () => {
		const files = await Promise.all(
			["a.png", "b.png"].map((name) =>
				web.rooms.saveFile(ROOM_A, { name, type: "image/png", bytes: PNG }),
			),
		);
		const { id } = await web.rooms.post(
			ROOM_A,
			external("two pictures", { files, reference: "<zip@mail>" }),
		);
		const path = `files/zip?room=${encodeURIComponent(ROOM_A)}&message=${id}`;
		const served = await rest(app, path, { who: "mel" });
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toBe("application/zip");
		const zed = await rest(app, path, { who: "zed" });
		expect(zed.status).toBe(404);
		expect(await zed.json()).toEqual(
			await (await rest(app, `files/${files[0]}`, { who: "zed" })).json(),
		);
	});

	test("a post reaches the readers who follow the room and nobody else, as its author kind says", async () => {
		const mel = await Client.open(app, "mel");
		const kim = await Client.open(app, "kim");
		const zed = await Client.open(app, "zed");
		const adaB = await Client.open(app, "ada");
		for (const client of [mel, kim, zed])
			client.send({ type: "subscribe", room: ROOM_A });
		adaB.send({ type: "subscribe", room: ROOM_B });
		zed.take(ofType("refused"));
		await Bun.sleep(100);
		const { id } = await web.rooms.post(
			ROOM_A,
			external("Where is my order?", { reference: "<m1@mail>" }),
		);
		const seen = await mel.take(ofType("host_message"));
		expect(seen.message).toMatchObject({
			id,
			room: ROOM_A,
			author: "Pat",
			authorKind: "external",
			authorLabel: "Customer",
			text: "Where is my order?",
		});
		expect((await kim.take(ofType("host_message"))).message.id).toBe(id);
		expect(await zed.sees(ofType("host_message"))).toBe(false);
		// The follower of another room has nothing of this one.
		expect(await adaB.sees(ofType("host_message"))).toBe(false);
		// The same reference stores nothing and shows nothing again.
		mel.skip();
		expect(
			(
				await web.rooms.post(
					ROOM_A,
					external("Where is my order?", { reference: "<m1@mail>" }),
				)
			).id,
		).toBe(id);
		expect(await mel.sees(ofType("host_message"))).toBe(false);
		expect(await web.rooms.byReference(ROOM_A, "<m1@mail>")).toBe(id);
		// An edit and a removal reach the same readers.
		await web.rooms.edit(ROOM_A, id, "Where is my order #42?");
		expect((await mel.take(ofType("host_edited"))).message).toMatchObject({
			id,
			text: "Where is my order #42?",
			edited: true,
		});
		await web.rooms.remove(ROOM_A, id);
		expect(await mel.take(ofType("host_removed"))).toMatchObject({
			room: ROOM_A,
			id,
		});
		expect(await zed.sees(ofType("host_removed"))).toBe(false);
		for (const client of [mel, kim, zed, adaB]) client.close();
	});

	test("the room as it opens holds its header, its messages with their authors, the cards each viewer may press, and the others' reads", async () => {
		const customer = await web.rooms.post(
			ROOM_A,
			external("Please call me", { at: new Date(Date.now() - 60_000) }),
		);
		const reply = await web.rooms.post(ROOM_A, {
			author: { kind: "assistant", name: "Knight" },
			text: "I will ask them **now**",
		});
		await web.rooms.post(ROOM_A, {
			author: { kind: "notice", name: "System" },
			text: "Reply sent",
		});
		const card = await web.rooms.card(ROOM_A, {
			title: "Suggested reply",
			body: "Ask for the order number",
			state: "open",
			links: [{ label: "Order", url: "https://orders.example.test/42" }],
			buttons: [
				{ id: "reply", label: "Send it", style: "primary" },
				{ id: "ignore", label: "Ignore", confirm: "Sure?" },
			],
		});
		const view = (await (
			await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "ada" })
		).json()) as HostRoomView;
		expect(view).toMatchObject({
			room: ROOM_A,
			kind: "inbox",
			id: ROOM_A_ID,
			access: { send: ["note", "turn"], act: true },
			header: {
				title: `Thread ${ROOM_A_ID}`,
				fields: [{ label: "Status", value: "Open" }],
				banner: { tone: "warn" },
			},
		});
		expect(view.header.actions[0]?.id).toBe("assign");
		expect(view.wording).toEqual({
			note: { placeholder: "Write to the team…" },
			turn: { label: "@Atlas".padEnd(40, "x") },
		});
		const kinds = view.messages.map((m) => [m.authorKind, m.text]);
		expect(kinds).toContainEqual(["external", "Please call me"]);
		expect(kinds).toContainEqual(["assistant", "I will ask them **now**"]);
		expect(kinds).toContainEqual(["notice", "Reply sent"]);
		// Messages are in the order they were written, an import dated earlier included.
		expect(view.messages.find((m) => m.id === customer.id)).toBeDefined();
		expect(view.messages.find((m) => m.id === reply.id)?.kind).toBe("agent");
		// Each viewer's own buttons: the kind narrows Mel's to one, and a reader who may not act has none.
		const adaCard = view.cards.find((c) => c.id === card.id) as HostCardView;
		expect(adaCard.buttons?.map((b) => b.id)).toEqual(["reply", "ignore"]);
		const mel = (await (
			await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "mel" })
		).json()) as HostRoomView;
		expect(
			mel.cards.find((c) => c.id === card.id)?.buttons?.map((b) => b.id),
		).toEqual(["reply"]);
		const kim = (await (
			await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "kim" })
		).json()) as HostRoomView;
		expect(kim.access).toEqual({ send: ["note"], act: false });
		expect(kim.cards.find((c) => c.id === card.id)?.buttons).toBeUndefined();
		expect(kim.cards.find((c) => c.id === card.id)?.links).toEqual([
			{ label: "Order", url: "https://orders.example.test/42" },
		]);
		// A card that settled has nothing left to press.
		await web.rooms.updateCard(ROOM_A, card.id, {
			title: "Suggested reply",
			body: "Sent",
			state: "done",
			buttons: [{ id: "reply", label: "Send it" }],
		});
		const settled = (await (
			await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "ada" })
		).json()) as HostRoomView;
		expect(settled.cards.find((c) => c.id === card.id)).toMatchObject({
			state: "done",
			body: "Sent",
		});
		expect(
			settled.cards.find((c) => c.id === card.id)?.buttons,
		).toBeUndefined();
		// Older messages come by `before`.
		const older = (await (
			await rest(
				app,
				`host/inbox/${ROOM_A_ID}/messages?before=${reply.id}&limit=1`,
				{ who: "ada" },
			)
		).json()) as HostMessagesView;
		expect(older.messages.map((m) => m.id)).toEqual([customer.id]);
	});

	test("a card update reaches the readers each with their own buttons, in the order it was made", async () => {
		const mel = await Client.open(app, "mel");
		const ada = await Client.open(app, "ada");
		for (const client of [mel, ada])
			client.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		const card = await web.rooms.card(ROOM_A, {
			title: "Pick",
			body: "one",
			buttons: [
				{ id: "reply", label: "Reply" },
				{ id: "ignore", label: "Ignore" },
			],
		});
		await web.rooms.updateCard(ROOM_A, card.id, {
			title: "Pick",
			body: "two",
			buttons: [
				{ id: "reply", label: "Reply" },
				{ id: "ignore", label: "Ignore" },
			],
		});
		const first = await mel.take(ofType("host_card"));
		const second = await mel.take(ofType("host_card"));
		expect([first.card.body, second.card.body]).toEqual(["one", "two"]);
		expect(second.card.buttons?.map((b) => b.id)).toEqual(["reply"]);
		await ada.take(ofType("host_card"));
		expect(
			(await ada.take(ofType("host_card"))).card.buttons?.map((b) => b.id),
		).toEqual(["reply", "ignore"]);
		mel.close();
		ada.close();
	});
});
