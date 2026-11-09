import { expect, test } from "bun:test";
import {
	CHANNEL_CONTEXT,
	type ChannelKey,
	type InboundMessage,
} from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import type { ServerFrame } from "../api-types.ts";
import {
	AGENT_ROOM,
	app,
	Client,
	external,
	hostAppSuite,
	ofType,
	READ_WRITE,
	ROOM_A,
	ROOM_B,
	RUN,
	rest,
	type Who,
	web,
} from "../testing/host-app-host.ts";
import type { HostListView } from "./views.ts";

describeDb("the host rooms over a real host: members and context", () => {
	hostAppSuite();

	test("a member's round table seats only the rooms their kind lists, and its frames, running turns and writes follow the room's own access", async () => {
		const { state } = app;
		// The table is served to the member, and the owners' agent rooms and presence stay closed to them.
		const config = (await (
			await rest(app, "config", { who: "mel" })
		).json()) as { panes: string[]; tier: string };
		expect(config).toMatchObject({ tier: "member", panes: ["rooms", "table"] });
		expect((await rest(app, "rooms", { who: "mel" })).status).toBe(404);
		expect(
			(await rest(app, `rooms/${AGENT_ROOM}`, { who: "mel" })).status,
		).toBe(404);
		// The seats: Mel's list is the room the kind grants, Kim's the same room, Zed has none.
		const seats = async (who: Who) =>
			(await rest(app, "host/inbox", { who })).status === 404
				? []
				: (
						(await (
							await rest(app, "host/inbox", { who })
						).json()) as HostListView
					).rooms.map((room) => room.key);
		expect(await seats("mel")).toEqual([ROOM_A]);
		expect(await seats("kim")).toEqual([ROOM_A]);
		expect(await seats("zed")).toEqual([]);
		// Mel follows the rooms the table seats; the other room and the agent room are refused.
		const mel = await Client.open(app, "mel");
		mel.send({ type: "subscribe", room: ROOM_B });
		expect(await mel.take(ofType("refused"))).toMatchObject({
			code: "unknown_room",
		});
		mel.send({ type: "subscribe", room: AGENT_ROOM });
		expect(await mel.take(ofType("refused"))).toMatchObject({
			code: "unknown_room",
		});
		// Nor can they write or stop where they may not: the agent room and the room that is not theirs.
		mel.send({ type: "send", id: "a1", room: AGENT_ROOM, text: "hi" });
		expect(await mel.take(ofType("refused"))).toMatchObject({
			id: "a1",
			code: "forbidden",
		});
		mel.send({
			type: "send",
			id: "b1",
			room: ROOM_B,
			text: "hi",
			mode: "note",
		});
		expect(await mel.take(ofType("refused"))).toMatchObject({
			id: "b1",
			code: "unknown_room",
		});
		mel.send({ type: "stop", room: AGENT_ROOM });
		expect(await mel.take(ofType("refused"))).toMatchObject({
			code: "forbidden",
		});
		mel.send({ type: "stop", room: ROOM_B });
		expect(await mel.take(ofType("refused"))).toMatchObject({
			code: "unknown_room",
		});
		// A turn Ada starts in Room A runs while the others follow: its activity reaches the readers who follow
		// it, also those who follow it only after it began, and no one else.
		let release: () => void = () => undefined;
		state.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		state.script = async (message, speaker) => {
			if (!speaker) return;
			await state.turns?.run({
				channel: message.channel,
				kind: "inbox",
				text: message.text,
				speaker,
				reply: async () => undefined,
			});
		};
		const ada = await Client.open(app, "ada");
		ada.send({ type: "subscribe", room: ROOM_A });
		ada.send({ type: "subscribe", room: ROOM_B });
		const kim = await Client.open(app, "kim");
		const zed = await Client.open(app, "zed");
		const busy = (room: string, typing: boolean) => (frame: ServerFrame) =>
			frame.type === "activity" &&
			frame.room === room &&
			frame.typing === typing;
		mel.send({ type: "subscribe", room: ROOM_A });
		ada.send({ type: "send", id: "t1", room: ROOM_A, text: "work on it" });
		await ada.take(ofType("accepted"));
		await mel.take(busy(ROOM_A, true));
		kim.send({ type: "subscribe", room: ROOM_A });
		zed.send({ type: "subscribe", room: ROOM_A });
		expect(await kim.take(busy(ROOM_A, true))).toMatchObject({ typing: true });
		expect(await zed.take(ofType("refused"))).toMatchObject({
			code: "unknown_room",
		});
		expect(await zed.sees((frame) => frame.type === "activity", 300)).toBe(
			false,
		);
		// What happens in the room Mel does not read never reaches them, and the presence table is the owners'.
		await web.rooms.post(ROOM_B, external("only for Ada"));
		await ada.take(ofType("host_message"));
		expect(
			await mel.sees(
				(frame) =>
					("room" in frame && frame.room === ROOM_B) ||
					frame.type === "presence",
				300,
			),
		).toBe(false);
		release();
		state.hold = undefined;
		await mel.take(busy(ROOM_A, false));
		expect(await zed.sees((frame) => frame.type === "activity", 200)).toBe(
			false,
		);
		state.script = undefined;
		for (const client of [mel, ada, kim, zed]) client.close();
	});

	test("what was said in a host room since the assistant last posted is the channel context of a turn, an outsider's words marked external", async () => {
		const room = `app:inbox.c${RUN}ctx01` as ChannelKey;
		app.state.grants.get(app.principals.ada)?.set(`c${RUN}ctx01`, READ_WRITE);
		await web.rooms.post(room, external("old question"));
		await web.rooms.post(room, {
			author: { kind: "assistant", name: "Knight" },
			text: "old answer",
		});
		await web.rooms.post(room, external("customer says A"));
		await web.rooms.post(room, {
			author: { kind: "notice", name: "System" },
			text: "a status line",
		});
		await web.rooms.post(room, {
			author: { kind: "member", name: "Mel", principalId: app.principals.mel },
			text: "colleague adds B",
		});
		const addressed = await web.rooms.post(room, {
			author: { kind: "member", name: "Ada" },
			text: "now answer",
		});
		const context = await app.host.context.services.get(CHANNEL_CONTEXT).read({
			channel: room,
			messageId: `app-${addressed.id}`,
			authorId: "x",
			authorName: "Ada",
			authorIsBot: false,
			isDirect: false,
			mentionsBot: false,
			repliesToBot: false,
			text: "now answer",
			attachments: [],
		} as InboundMessage);
		expect(context?.messages.map((m) => m.text)).toEqual([
			"customer says A",
			"colleague adds B",
		]);
		expect(context?.messages[0]?.external).toBe(true);
		expect(context?.messages[1]?.external).toBeUndefined();
		expect(context?.text).toContain('role="external"');
		expect(context?.text).not.toContain("a status line");
		expect(context?.text).not.toContain("old question");
		// Handed over once: the next turn gets only what is newer.
		const again = await app.host.context.services.get(CHANNEL_CONTEXT).read({
			channel: room,
			messageId: `app-${addressed.id}`,
			authorId: "x",
			authorName: "Ada",
			authorIsBot: false,
			isDirect: false,
			mentionsBot: false,
			repliesToBot: false,
			text: "now answer",
			attachments: [],
		} as InboundMessage);
		expect(again).toBeUndefined();
		// An agent room is one person's: no channel context.
		const agent = await app.host.context.services.get(CHANNEL_CONTEXT).read({
			channel: AGENT_ROOM as ChannelKey,
			messageId: "app-1",
			authorId: "x",
			authorName: "Ada",
			authorIsBot: false,
			isDirect: false,
			mentionsBot: false,
			repliesToBot: false,
			text: "hi",
			attachments: [],
		} as InboundMessage);
		expect(agent).toBeUndefined();
	});

	test("rooms.context reads a room's recent messages without an addressing message and marks nothing handed over", async () => {
		const room = `app:inbox.c${RUN}ctx02` as ChannelKey;
		app.state.grants.get(app.principals.ada)?.set(`c${RUN}ctx02`, READ_WRITE);
		await web.rooms.post(room, external("old question"));
		await web.rooms.post(room, {
			author: { kind: "assistant", name: "Knight" },
			text: "old answer",
		});
		await web.rooms.post(room, external("customer says A"));
		await web.rooms.post(room, {
			author: { kind: "notice", name: "System" },
			text: "a status line",
		});
		await web.rooms.post(room, external("customer says B"));
		await web.rooms.post(room, external("customer says C"));
		const first = await web.rooms.context(room, { limit: 2 });
		expect(first?.messages.map((m) => m.text)).toEqual([
			"customer says B",
			"customer says C",
		]);
		expect(first?.messages[0]?.external).toBe(true);
		expect(first?.text).toContain('role="external"');
		// A retry gets the same, and so does the turn's own read after it.
		const again = await web.rooms.context(room, { limit: 2 });
		expect(again?.text).toBe(first?.text);
		const all = await web.rooms.context(room);
		expect(all?.messages.map((m) => m.text)).toEqual([
			"customer says A",
			"customer says B",
			"customer says C",
		]);
		const read = await app.host.context.services.get(CHANNEL_CONTEXT).read({
			channel: room,
			messageId: "app-999999",
			authorId: "x",
			authorName: "Ada",
			authorIsBot: false,
			isDirect: false,
			mentionsBot: false,
			repliesToBot: false,
			text: "now answer",
			attachments: [],
		} as InboundMessage);
		expect(read?.messages).toHaveLength(3);
		// A room with nothing since the assistant spoke gives none; so does a room of no kind, by throwing.
		await web.rooms.post(room, {
			author: { kind: "assistant", name: "Knight" },
			text: "answered",
		});
		expect(await web.rooms.context(room)).toBeUndefined();
		await expect(
			web.rooms.context("app:nokind.x" as ChannelKey),
		).rejects.toThrow("not a room");
		await expect(web.rooms.context(room, { limit: 0 })).rejects.toThrow(
			RangeError,
		);
	});
});
