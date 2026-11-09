import { expect, test } from "bun:test";
import type { ChannelKey } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import type { RoomMessage, ServerFrame } from "../api-types.ts";
import {
	AGENT_ROOM,
	app,
	Client,
	external,
	GUIDE,
	hostAppSuite,
	ofType,
	post,
	READ_WRITE,
	ROOM_A,
	ROOM_A_ID,
	RUN,
	rest,
	web,
} from "../testing/host-app-host.ts";
import type { HostListView, HostRoomView } from "./views.ts";

describeDb("the host rooms over a real host: reading", () => {
	hostAppSuite();

	test("reading: the cursor advances with `read`, others see it, a non-reader gets neither frame nor marks, and the list counts what is unread", async () => {
		const ada = await Client.open(app, "ada");
		const mel = await Client.open(app, "mel");
		const zed = await Client.open(app, "zed");
		for (const client of [ada, mel])
			client.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		const first = await web.rooms.post(ROOM_A, external("one for the readers"));
		const second = await web.rooms.post(
			ROOM_A,
			external("two for the readers"),
		);
		const unreadBefore = (await (
			await rest(app, "host/inbox", { who: "ada" })
		).json()) as HostListView;
		const before =
			unreadBefore.rooms.find((room) => room.key === ROOM_A)?.unread ?? 0;
		expect(before).toBeGreaterThanOrEqual(2);
		ada.skip();
		mel.skip();
		mel.send({ type: "read", room: ROOM_A, upTo: first.id });
		const seen = await ada.take(ofType("read"));
		expect(seen).toMatchObject({
			room: ROOM_A,
			principal: app.principals.mel,
			name: "Mel",
			upTo: first.id,
		});
		// The page shows the reader from the frame alone.
		expect(Date.parse((seen as { at: string }).at)).toBeGreaterThan(0);
		// Mel's own other devices hear it too; a person who cannot read the room hears nothing.
		expect((await mel.take(ofType("read"))).principal).toBe(app.principals.mel);
		expect(await zed.sees(ofType("read"))).toBe(false);
		// Going back does nothing.
		mel.skip();
		mel.send({ type: "read", room: ROOM_A, upTo: first.id - 1 });
		expect(await ada.sees(ofType("read"), 300)).toBe(false);
		// The next read moves it on, no further than the newest message.
		mel.send({ type: "read", room: ROOM_A, upTo: second.id + 1000 });
		expect((await ada.take(ofType("read"))).upTo).toBeGreaterThanOrEqual(
			second.id,
		);
		const afterMel = (await (
			await rest(app, "host/inbox", { who: "mel" })
		).json()) as HostListView;
		expect(
			afterMel.rooms.find((room) => room.key === ROOM_A)?.unread,
		).toBeUndefined();
		const adaList = (await (
			await rest(app, "host/inbox", { who: "ada" })
		).json()) as HostListView;
		expect(adaList.rooms.find((room) => room.key === ROOM_A)?.unread).toBe(
			before,
		);
		// The room as Ada opens it carries Mel's mark and her own cursor, not her own mark.
		ada.send({ type: "read", room: ROOM_A, upTo: first.id });
		await ada.take(ofType("read"));
		const view = (await (
			await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "ada" })
		).json()) as HostRoomView;
		expect(view.reads.map((mark) => mark.principal)).toContain(
			app.principals.mel,
		);
		expect(view.reads.map((mark) => mark.principal)).not.toContain(
			app.principals.ada,
		);
		expect(
			view.reads.find((mark) => mark.principal === app.principals.mel)?.name,
		).toBe("Mel");
		expect(view.cursor).toBe(first.id);
		// A person who cannot read the room is told nothing of who has.
		expect(
			(await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "zed" })).status,
		).toBe(404);
		zed.send({ type: "read", room: ROOM_A, upTo: first.id });
		expect(await zed.take(ofType("refused"))).toMatchObject({
			code: "unknown_room",
		});
		for (const client of [ada, mel, zed]) client.close();
	});

	test("agent rooms keep a cursor among the owners too: reading moves it, and an owner's room list and messages carry the count and the marks", async () => {
		const ada = await Client.open(app, "ada");
		const rooms = (await (await rest(app, "rooms", { who: "ada" })).json()) as {
			rooms: { key: string; unread?: number }[];
		};
		const guide = rooms.rooms.find((room) => room.key === AGENT_ROOM);
		expect(guide).toBeDefined();
		// A room a person never read starts at what it holds: the history is not unread.
		expect(guide?.unread).toBeUndefined();
		const sent = ada;
		sent.send({
			type: "send",
			id: "g1",
			room: AGENT_ROOM,
			text: "hello guide",
		});
		const answer = await sent.take(
			(frame): frame is Extract<ServerFrame, { type: "message" }> =>
				frame.type === "message" && frame.message.kind === "agent",
			8000,
		);
		const withUnread = (await (
			await rest(app, "rooms", { who: "ada" })
		).json()) as {
			rooms: { key: string; unread?: number }[];
		};
		expect(
			withUnread.rooms.find((room) => room.key === AGENT_ROOM)?.unread,
		).toBeGreaterThanOrEqual(1);
		sent.send({
			type: "read",
			room: AGENT_ROOM,
			upTo: answer.message.id,
		});
		await sent.take(ofType("read"));
		const read = (await (await rest(app, "rooms", { who: "ada" })).json()) as {
			rooms: { key: string; unread?: number }[];
		};
		expect(
			read.rooms.find((room) => room.key === AGENT_ROOM)?.unread,
		).toBeUndefined();
		const messages = (await (
			await rest(app, `rooms/app%3Aagent.${GUIDE}/messages?limit=5`, {
				who: "ada",
			})
		).json()) as {
			messages: RoomMessage[];
			cursor?: number;
			reads?: unknown[];
		};
		expect(messages.cursor).toBe(answer.message.id);
		// Marks of other owners of this shared database may be there; the viewer's own never is.
		expect(
			messages.reads?.some(
				(mark) =>
					(mark as { principal: string }).principal === app.principals.ada,
			),
		).toBe(false);
		// A member has no agent rooms to read.
		const mel = await Client.open(app, "mel");
		mel.send({ type: "read", room: AGENT_ROOM, upTo: 1 });
		expect(await mel.take(ofType("refused"))).toMatchObject({
			code: "unknown_room",
		});
		mel.close();
		ada.close();
	});

	test("marking everything read: the owner's named rooms they may read move to their newest message, the others are passed over, the other readers and pages hear of it, and the undo puts back what was not read on since", async () => {
		const [roomD, roomE, roomF] = ["d", "e", "f"].map(
			(name) => `${name}${RUN}room`,
		);
		const { ada: adaId, mel: melId } = app.principals;
		app.state.grants.get(adaId)?.set(roomD as string, READ_WRITE);
		app.state.grants.get(adaId)?.set(roomE as string, READ_WRITE);
		app.state.grants.get(melId)?.set(roomD as string, READ_WRITE);
		app.state.grants.set(melId, app.state.grants.get(melId) ?? new Map());
		app.state.grants.get(melId)?.set(roomF as string, READ_WRITE);
		try {
			await markingEverythingRead(roomD, roomE, roomF);
		} finally {
			// The grants were this test's: the other tests count the rooms a person has.
			for (const id of [roomD, roomE, roomF] as string[]) {
				app.state.grants.get(adaId)?.delete(id);
				app.state.grants.get(melId)?.delete(id);
			}
		}
	});

	async function markingEverythingRead(
		roomD: string | undefined,
		roomE: string | undefined,
		roomF: string | undefined,
	): Promise<void> {
		const keyOf = (id: string | undefined) => `app:inbox.${id}` as ChannelKey;
		const { ada: adaId } = app.principals;
		for (const id of [roomD, roomE, roomF])
			await web.rooms.post(keyOf(id), external("something to read"));
		await web.rooms.post(keyOf(roomD), external("and more"));
		const phone = await Client.open(app, "ada");
		const desk = await Client.open(app, "ada");
		const mel = await Client.open(app, "mel");
		desk.send({ type: "subscribe", room: keyOf(roomD) });
		mel.send({ type: "subscribe", room: keyOf(roomD) });
		await Bun.sleep(100);
		// An agent room joins them: a reply Ada has not read.
		desk.send({
			type: "send",
			id: "ra1",
			room: AGENT_ROOM,
			text: "hello again",
		});
		await desk.take(
			(frame): frame is Extract<ServerFrame, { type: "message" }> =>
				frame.type === "message" && frame.message.kind === "agent",
			8000,
		);
		for (const client of [phone, desk, mel]) client.skip();
		const listOf = async () =>
			(await (
				await rest(app, "host/inbox", { who: "ada" })
			).json()) as HostListView;
		const unreadOf = async (id: string | undefined) =>
			(await listOf()).rooms.find((room) => room.key === keyOf(id))?.unread;
		expect(await unreadOf(roomD)).toBe(2);
		expect(await unreadOf(roomE)).toBe(1);

		const named = [
			keyOf(roomD),
			keyOf(roomE),
			// Mel's room, not Ada's; a room of a kind that is none; another surface's room.
			keyOf(roomF),
			"app:inbox.nobodyhere1",
			"app:nothing.abcdefgh",
			"elsewhere:agent.guide",
			AGENT_ROOM,
		];
		const marked = await post(app, "rooms/read-all", { rooms: named }, "ada");
		expect(marked.status).toBe(200);
		const { moved } = (await marked.json()) as {
			moved: { room: string; from: number; to: number }[];
		};
		expect(moved.map((one) => one.room).sort()).toEqual(
			[keyOf(roomD), keyOf(roomE), AGENT_ROOM].sort(),
		);
		for (const one of moved) expect(one.to).toBeGreaterThan(one.from);
		expect(await unreadOf(roomD)).toBeUndefined();
		expect(await unreadOf(roomE)).toBeUndefined();
		const guide = (await (await rest(app, "rooms", { who: "ada" })).json()) as {
			rooms: { key: string; unread?: number }[];
		};
		expect(
			guide.rooms.find((room) => room.key === AGENT_ROOM)?.unread,
		).toBeUndefined();
		// Ada's page that follows nothing hears of each room; the one that follows Room D hears too; Mel sees Ada's mark in the room they share.
		for (const client of [phone, desk]) {
			const heard = new Set<string>();
			while (heard.size < 3) {
				const frame = await client.take(ofType("read"));
				if (frame.principal === adaId) heard.add(frame.room);
			}
			expect(heard.has(keyOf(roomD))).toBe(true);
			expect(heard.has(keyOf(roomE))).toBe(true);
		}
		expect(await mel.take(ofType("read"))).toMatchObject({
			room: keyOf(roomD),
			principal: adaId,
			name: "Ada",
		});
		// Mel's own room was not Ada's to read: Mel still has it to read.
		const melList = (await (
			await rest(app, "host/inbox", { who: "mel" })
		).json()) as HostListView;
		expect(
			melList.rooms.find((room) => room.key === keyOf(roomF))?.unread,
		).toBe(1);
		expect(
			melList.rooms.find((room) => room.key === keyOf(roomD))?.unread,
		).toBe(2);
		// Nothing is left to move the second time, and no page is told.
		const again = (await (
			await post(app, "rooms/read-all", { rooms: named }, "ada")
		).json()) as { moved: unknown[] };
		expect(again.moved).toEqual([]);

		// Ada reads on in Room E before the undo: that room stays read, the others come back.
		const later = await web.rooms.post(
			keyOf(roomE),
			external("after the marking"),
		);
		phone.send({ type: "subscribe", room: keyOf(roomE) });
		await Bun.sleep(100);
		phone.send({ type: "read", room: keyOf(roomE), upTo: later.id });
		await phone.take(
			(frame) => frame.type === "read" && frame.room === keyOf(roomE),
		);
		phone.skip();
		desk.skip();
		const undone = await post(app, "rooms/read-all", { restore: moved }, "ada");
		expect(undone.status).toBe(200);
		const { restored } = (await undone.json()) as { restored: string[] };
		expect(restored.sort()).toEqual([keyOf(roomD), AGENT_ROOM].sort());
		expect(await unreadOf(roomD)).toBe(2);
		expect(await unreadOf(roomE)).toBeUndefined();
		// Ada's pages are told to look at the list of the kind again.
		expect(await phone.take(ofType("list_changed"))).toMatchObject({
			kind: "inbox",
		});
		expect(
			await post(app, "rooms/read-all", { restore: moved }, "ada").then(
				(response) => response.json(),
			),
		).toEqual({ restored: [] });

		// Without names, every room of the owner's list: the agent rooms, never a host room.
		const whole = (await (
			await post(app, "rooms/read-all", {}, "ada")
		).json()) as { moved: { room: string }[] };
		const wholeRooms = whole.moved.map((one) => one.room);
		expect(wholeRooms).toContain(AGENT_ROOM);
		expect(wholeRooms.every((room) => room.startsWith("app:agent."))).toBe(
			true,
		);

		// A body that is no list of keys or of moves is refused; a member, who has no rooms list, finds no such route.
		for (const body of [
			{ rooms: "x" },
			{ rooms: [1] },
			{ rooms: Array(501).fill(AGENT_ROOM) },
			{ restore: [{ room: AGENT_ROOM, from: -1, to: 2 }] },
			{ restore: [{ room: AGENT_ROOM, from: 1 }] },
			{ restore: "x" },
		])
			expect((await post(app, "rooms/read-all", body, "ada")).status).toBe(400);
		expect(
			(await post(app, "rooms/read-all", { rooms: [keyOf(roomD)] }, "mel"))
				.status,
		).toBe(404);
		expect(await unreadOf(roomD)).toBe(2);
		for (const client of [phone, desk, mel]) client.close();
	}
});
