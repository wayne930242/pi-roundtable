import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { AGENTS, IDENTITY, SCHEDULES, THREADS } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import type { MessagesView, RoomsView, SchedulesView } from "../api-types.ts";
import {
	ADA_DISCORD,
	agentReply,
	type Booted,
	boot,
	Client,
	ENTRY_CHANNEL,
	GUIDE,
	MEL,
	ofType,
	rest,
	SCOUT,
} from "../testing/app-host.ts";

describeDb("the owner app over a real host", () => {
	let app: Booted;

	beforeAll(async () => {
		app = await boot({ auth: "verifier", graceSeconds: 0.4 });
		await app.host.context.services.get(IDENTITY).resolve(MEL);
	}, 30_000);

	afterAll(async () => {
		await app.stop();
	});

	afterEach(() => app.reset());

	test("schedules are listed by room and cancelled", async () => {
		const schedules = app.host.context.services.get(SCHEDULES);
		const made = await schedules.create({
			channel: GUIDE,
			target: "personal",
			title: "Morning brief",
			prompt: "Brief me",
			recurrence: {
				kind: "every",
				everyDays: 1,
				time: "08:00",
				startDate: "2026-10-01",
			},
			nextRun: new Date(Date.now() + 3_600_000),
			createdById: ADA_DISCORD,
			createdByName: "Ada",
			createdTier: "owner",
		});
		const listed = (await (
			await rest(app, "schedules")
		).json()) as SchedulesView;
		expect(listed.schedules.find((s) => s.id === made.id)).toMatchObject({
			room: GUIDE,
			label: "Guide",
			title: "Morning brief",
		});
		expect(
			(
				await rest(app, `schedules/${made.id}`, {
					method: "DELETE",
					origin: null,
				})
			).status,
		).toBe(403);
		expect(
			(await rest(app, `schedules/${made.id}`, { method: "DELETE" })).status,
		).toBe(200);
		expect(
			(await rest(app, `schedules/${made.id}`, { method: "DELETE" })).status,
		).toBe(404);
	});

	test("an agent's profile is read and changed", async () => {
		const profile = (await (await rest(app, "agents/scout")).json()) as {
			displayName: string;
			prompt: string;
		};
		expect(profile).toMatchObject({
			displayName: "Scout",
			prompt: "You scout.",
		});
		const patched = await rest(app, "agents/scout", {
			method: "PATCH",
			body: JSON.stringify({ displayName: "Scout II" }),
		});
		expect(patched.status).toBe(200);
		expect(
			((await patched.json()) as { displayName: string }).displayName,
		).toBe("Scout II");
		const rooms = (await (await rest(app, "rooms")).json()) as RoomsView;
		expect(rooms.rooms.find((r) => r.key === SCOUT)?.displayName).toBe(
			"Scout II",
		);
		expect(
			(
				await rest(app, "agents/scout", {
					method: "PATCH",
					body: JSON.stringify({ model: "no/such-model" }),
				})
			).status,
		).toBe(400);
		expect((await rest(app, "agents/nobody")).status).toBe(404);
		await app.host.context.services
			.get(AGENTS)
			.team.update("scout", { displayName: "Scout" });
		const models = (await (await rest(app, "models")).json()) as {
			models: string[];
		};
		expect(Array.isArray(models.models)).toBe(true);
	});

	test("start over marks the room and refuses what is not a room", async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		const post = (key: string, init = {}) =>
			rest(app, `rooms/${encodeURIComponent(key)}/start-over`, {
				method: "POST",
				...init,
			});
		expect((await post(`discord:${ENTRY_CHANNEL}`)).status).toBe(404);
		expect((await post(SCOUT, { origin: null })).status).toBe(403);
		expect((await post(SCOUT, { who: "member" })).status).toBe(403);
		expect((await post(SCOUT)).status).toBe(200);
		const divider = await tab.take(
			(frame) => frame.type === "message" && frame.message.kind === "system",
		);
		expect(divider).toMatchObject({
			room: SCOUT,
			message: { text: "Conversation started over" },
		});
		tab.close();
	});

	test("after a start over the room's history starts at it, and the archived conversation keeps what came before", async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		// The database is shared by runs, so this run's words are its own.
		const run = crypto.randomUUID().slice(0, 8);
		const before = `before-restart-${run}`;
		const after = `after-restart-${run}`;
		const get = async (query = "") =>
			(await (
				await rest(app, `rooms/${encodeURIComponent(GUIDE)}/messages?${query}`)
			).json()) as MessagesView;
		const unreadOf = async () =>
			((await (await rest(app, "rooms")).json()) as RoomsView).rooms.find(
				(room) => room.key === GUIDE,
			);
		await unreadOf();
		tab.send({ type: "send", id: "so1", room: GUIDE, text: before });
		await tab.take(agentReply("guide"));
		expect((await unreadOf())?.unread ?? 0).toBeGreaterThan(0);
		expect(
			(
				await rest(app, `rooms/${encodeURIComponent(GUIDE)}/start-over`, {
					method: "POST",
				})
			).status,
		).toBe(200);
		const divider = await tab.take(
			(frame) =>
				frame.type === "message" &&
				frame.room === GUIDE &&
				frame.message.kind === "system",
		);
		if (divider.type !== "message") throw new Error("no divider");
		const line = divider.message.id;
		// A reload shows only the start line; nothing above it is offered or reachable.
		const fresh = await get("limit=50");
		expect(fresh.messages.map((m) => m.id)).toEqual([line]);
		expect(fresh.more).toBe(false);
		const above = await get(`before=${line}&limit=50`);
		expect(above.messages).toEqual([]);
		expect(above.more).toBe(false);
		// Nothing of the archived conversation counts as unread, nor stands in the list as unread.
		const listed = await unreadOf();
		expect(listed?.unread ?? 0).toBe(0);
		expect(listed?.last?.id).toBe(line);
		// What follows the start line is the new conversation.
		tab.send({ type: "send", id: "so2", room: GUIDE, text: after });
		await tab.take(agentReply("guide"));
		const next = await get("limit=50");
		expect(next.messages[0]?.id).toBe(line);
		expect(next.messages.map((m) => m.text)).toContain(after);
		expect(next.messages.map((m) => m.text)).not.toContain(before);
		// The archived conversation holds what came before, back to the start line before it.
		const archived = await get(`archive=${line}&limit=50`);
		const texts = archived.messages.map((m) => m.text);
		expect(texts).toContain(before);
		expect(texts).not.toContain(after);
		expect(archived.messages.every((m) => m.id < line)).toBe(true);
		expect(
			archived.messages.some((m) => m.text === "Conversation started over"),
		).toBe(false);
		// Only a start line of the room names an archived conversation.
		const reply = next.messages.at(-1)?.id;
		for (const query of [`archive=${reply}`, "archive=1"])
			expect(
				(
					await rest(
						app,
						`rooms/${encodeURIComponent(GUIDE)}/messages?${query}`,
					)
				).status,
			).toBe(404);
		expect(
			(await rest(app, `rooms/${encodeURIComponent(GUIDE)}/messages?archive=x`))
				.status,
		).toBe(400);
		tab.close();
	});
});

describeDb("the room list's layout over a real host", () => {
	let app: Booted;
	const clear = async () => {
		const database = app.host.context.database();
		await database`DELETE FROM web_room_folder_rooms`;
		await database`DELETE FROM web_room_pins`;
		await database`DELETE FROM web_room_folders`;
	};
	beforeAll(async () => {
		app = await boot({ auth: "verifier" });
		await app.host.context.services.get(IDENTITY).resolve(MEL);
		await clear();
	}, 30_000);
	afterEach(async () => {
		await app.reset();
		await clear();
	});
	afterAll(async () => {
		await clear();
		await app.stop();
	});

	const write = (path: string, method: string, body?: unknown, over = {}) =>
		rest(app, path, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			...over,
		});

	test("the room list carries the layout, and a write on one page reaches another as a change", async () => {
		const first = (await (await rest(app, "rooms")).json()) as RoomsView;
		expect([first.pins, first.folders]).toEqual([[], []]);
		const other = await Client.open(app, { "x-actor": "owner" });
		if (!other) throw new Error("the owner was refused");
		await other.take(ofType("ready"));

		const made = await write("folders", "POST", { name: "Work" });
		expect(made.status).toBe(201);
		const folder = ((await made.json()) as RoomsView).folders[0];
		expect(folder).toMatchObject({ name: "Work", rooms: [] });
		const id = folder?.id as string;
		await other.take(ofType("changed"));

		const into = await write(
			`rooms/${encodeURIComponent(SCOUT)}/folder`,
			"PUT",
			{
				folder: id,
			},
		);
		expect(into.status).toBe(200);
		const pinned = await write(
			`rooms/${encodeURIComponent(GUIDE)}/pin`,
			"PUT",
			{
				pinned: true,
			},
		);
		// Home stays at the top.
		expect(pinned.status).toBe(400);
		const listed = (await (await rest(app, "rooms")).json()) as RoomsView;
		expect(listed.folders).toEqual([{ id, name: "Work", rooms: [SCOUT] }]);
		expect(listed.pins).toEqual([]);

		const muted = await write(`folders/${id}/mute`, "PUT", {
			muted: true,
		});
		expect(await muted.json()).toEqual({ muted: true, rooms: [SCOUT] });
		const after = (await (await rest(app, "rooms")).json()) as RoomsView;
		expect(after.rooms.find((room) => room.key === SCOUT)?.muted).toBe(true);
		await write(`folders/${id}/mute`, "PUT", { muted: false });
		other.close();
	});

	test("a member and a page of another origin are refused, and nothing changes", async () => {
		const before = (await (await rest(app, "rooms")).json()) as RoomsView;
		const asMember = await write(
			"folders",
			"POST",
			{ name: "Mel" },
			{ who: "member" },
		);
		expect(asMember.status).toBe(403);
		const crossOrigin = await write(
			"folders",
			"POST",
			{ name: "Evil" },
			{ origin: "https://evil.example.test" },
		);
		expect(crossOrigin.status).toBe(403);
		expect(
			((await (await rest(app, "rooms")).json()) as RoomsView).folders,
		).toEqual(before.folders);
	});

	test("a folder is renamed, moved and deleted over the real routes, a thread is not placed, and a refused edit changes nothing", async () => {
		const made = async (name: string) => {
			const answer = await write("folders", "POST", { name });
			expect(answer.status).toBe(201);
			const folders = ((await answer.json()) as RoomsView).folders;
			return folders[folders.length - 1]?.id as string;
		};
		const one = await made("One");
		const two = await made("Two");
		const named = (view: RoomsView) => view.folders.map((one) => one.name);
		const listed = async () =>
			(await (await rest(app, "rooms")).json()) as RoomsView;

		const renamed = await write(`folders/${one}`, "PATCH", { name: "First" });
		expect(renamed.status).toBe(200);
		expect(named((await renamed.json()) as RoomsView)).toContain("First");
		// Before the other folder: Two leads.
		const moved = await write(`folders/${two}`, "PATCH", { before: one });
		expect(moved.status).toBe(200);
		const order = named(await listed());
		expect(order.indexOf("Two")).toBeLessThan(order.indexOf("First"));

		// A name another folder has is refused, and nothing is stored.
		const before = await listed();
		const clash = await write(`folders/${one}`, "PATCH", { name: "two" });
		expect(clash.status).toBe(409);
		expect((await listed()).folders).toEqual(before.folders);

		// A thread stays under its room: it can be neither pinned nor filed.
		const threads = app.host.context.services.get(THREADS);
		const thread = await threads.open(GUIDE, "Layout thread");
		if (!thread) throw new Error("the thread was not opened");
		for (const [action, body] of [
			["pin", { pinned: true }],
			["folder", { folder: one }],
		] as const) {
			const refused = await write(
				`rooms/${encodeURIComponent(thread.channel)}/${action}`,
				"PUT",
				body,
			);
			expect(refused.status).toBe(400);
		}
		await thread.close();

		// A room in a folder leaves with it: it is unplaced, not deleted.
		await write(`rooms/${encodeURIComponent(SCOUT)}/folder`, "PUT", {
			folder: one,
		});
		const deleted = await write(`folders/${one}`, "DELETE");
		expect(deleted.status).toBe(200);
		const after = await listed();
		expect(after.folders.some((folder) => folder.id === one)).toBe(false);
		expect(after.folders.flatMap((folder) => folder.rooms)).not.toContain(
			SCOUT,
		);
		expect((await write(`folders/${one}`, "DELETE")).status).toBe(404);
		await write(`folders/${two}`, "DELETE");
	});

	test("a room of another surface, and a deleted agent's key, are not placed", async () => {
		const other = await write(
			`rooms/${encodeURIComponent("discord:123")}/pin`,
			"PUT",
			{
				pinned: true,
			},
		);
		expect(other.status).toBe(404);
		const gone = await write(
			`rooms/${encodeURIComponent("app:agent.nobody")}/pin`,
			"PUT",
			{ pinned: true },
		);
		expect(gone.status).toBe(404);
	});
});
