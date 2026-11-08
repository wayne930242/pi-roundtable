import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { AGENTS, IDENTITY, MODES } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import type { MessagesView, RoomsView } from "../api-types.ts";
import { until } from "../testing/app-fixture.ts";
import {
	ADA_DISCORD,
	activity,
	agentReply,
	type Booted,
	boot,
	Client,
	ENTRY_CHANNEL,
	GUIDE,
	MEL,
	ORIGIN,
	ofType,
	rest,
	SCOUT,
} from "../testing/app-host.ts";
import { APP_PROTOCOL } from "./protocol.ts";

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

	test("a message to a room is answered there, as the owner, by the agent", async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		const ready = await tab.take(ofType("ready"));
		expect(ready.principal).toBe(ADA_DISCORD);
		tab.send({ type: "send", id: "m1", room: GUIDE, text: "hello team" });
		const accepted = await tab.take(ofType("accepted"));
		expect(accepted).toMatchObject({
			id: "m1",
			room: GUIDE,
			message: {
				kind: "owner",
				author: "Ada",
				principalId: ADA_DISCORD,
				text: "hello team",
			},
		});
		const reply = await tab.take(agentReply("guide"));
		if (reply.type !== "message") throw new Error("expected a message");
		expect(reply.message).toMatchObject({
			kind: "agent",
			agent: "guide",
			author: "Guide",
			text: "echo hello team",
		});
		const turn = app.seen.find((r) => r.text.includes("hello team"));
		expect(turn?.channel).toBe(GUIDE);
		expect(turn?.agent?.session).toBe(GUIDE);
		expect(turn?.speaker).toMatchObject({
			tier: "owner",
			principalId: ADA_DISCORD,
		});
		const messages = (await (
			await rest(app, `rooms/${encodeURIComponent(GUIDE)}/messages`)
		).json()) as MessagesView;
		// The log is the database's, so earlier runs' messages come before these.
		expect(messages.messages.slice(-2).map((m) => m.kind)).toEqual([
			"owner",
			"agent",
		]);
		const rooms = (await (await rest(app, "rooms")).json()) as RoomsView;
		// Threads of the other suites stay in the shared database; they are not what this asks.
		expect(
			rooms.rooms
				.filter((r) => r.kind !== "thread")
				.map((r) => [r.key, r.home]),
		).toEqual([
			[GUIDE, true],
			[SCOUT, false],
		]);
		tab.close();
	});

	test("only the app's own rooms take a message", async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		const before = app.seen.length;
		for (const [index, room] of [
			`discord:${ENTRY_CHANNEL}`,
			"app:agent.nobody",
			"other:agent.guide",
			"app:agent_guide",
			"app:group.nobody",
			"app:thread.5b6a6d0e-0000-4000-8000-000000000000",
			"not a key",
		].entries()) {
			tab.send({ type: "send", id: `r${index}`, room, text: "hi" });
			const refused = await tab.take(ofType("refused"));
			expect(refused).toEqual({
				type: "refused",
				id: `r${index}`,
				code: "unknown_room",
			});
		}
		expect(app.seen.length).toBe(before);
		tab.close();
	});

	test("with one reader a room has no notes: a note frame is refused and the room list is as before", async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		const before = app.seen.length;
		tab.send({
			type: "send",
			id: "n1",
			room: GUIDE,
			text: "single-reader-note",
			mode: "note",
		});
		expect(await tab.take(ofType("refused"))).toEqual({
			type: "refused",
			id: "n1",
			code: "bad_frame",
		});
		expect(app.seen.length).toBe(before);
		const messages = (await (
			await rest(app, `rooms/${encodeURIComponent(GUIDE)}/messages`)
		).json()) as MessagesView;
		expect(messages.messages.some((m) => m.text === "single-reader-note")).toBe(
			false,
		);
		// Nothing in the room list or the history says notes exist.
		const rooms = await (await rest(app, "rooms")).text();
		expect(rooms).not.toContain('"notes"');
		expect(JSON.stringify(messages)).not.toContain("single-reader-note");
		tab.close();
	});

	test("a visitor who is no owner is refused, on the socket and the API", async () => {
		expect(await Client.open(app, { "x-actor": "member" })).toBeUndefined();
		expect(await Client.open(app, {})).toBeUndefined();
		expect((await rest(app, "rooms", { who: "member" })).status).toBe(403);
		expect((await rest(app, "rooms", { who: "stranger" })).status).toBe(403);
		expect(
			await Client.open(
				app,
				{ "x-actor": "owner" },
				"https://evil.example.test",
			),
		).toBeUndefined();
	});

	test("stop ends the running turn", async () => {
		app.scripts.set("keep-going", async (_request, signal) => {
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return { ok: false, error: new Error("stopped"), stopped: true };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "s1", room: SCOUT, text: "keep-going" });
		await tab.take(
			(frame) =>
				frame.type === "activity" && frame.room === SCOUT && frame.stoppable,
		);
		tab.send({ type: "stop", room: SCOUT });
		await tab.take(
			(frame) =>
				frame.type === "activity" && frame.room === SCOUT && !frame.stoppable,
		);
		expect(app.stops).toContain(SCOUT);
		tab.send({ type: "stop", room: "discord:900000000000000002" });
		expect((await tab.take(ofType("refused"))).code).toBe("unknown_room");
		tab.close();
	});

	test("a mode is set on the app's rooms only, by an owner who comes from the app", async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		const put = (key: string, body: object, init = {}) =>
			rest(app, `rooms/${encodeURIComponent(key)}/mode`, {
				method: "PUT",
				body: JSON.stringify(body),
				...init,
			});
		for (const key of [
			"app:agent.nobody",
			"app:group.nobody",
			`discord:${ENTRY_CHANNEL}`,
			"other:agent.guide",
			"app:agent_guide",
		])
			expect((await put(key, { yolo: true })).status).toBe(404);
		expect((await put(GUIDE, { yolo: true }, { origin: null })).status).toBe(
			403,
		);
		expect(
			(
				await put(
					GUIDE,
					{ yolo: true },
					{ origin: "https://evil.example.test" },
				)
			).status,
		).toBe(403);
		expect((await put(GUIDE, { yolo: true }, { who: "member" })).status).toBe(
			403,
		);
		expect((await put(GUIDE, { yolo: "yes" })).status).toBe(400);
		expect((await put(GUIDE, {})).status).toBe(400);
		const modes = app.host.context.services.get(MODES);
		expect(modes.peek(GUIDE).longRunning).toBe(false);
		const changed = await put(GUIDE, { longRunning: true });
		expect(changed.status).toBe(200);
		expect(await changed.json()).toEqual({
			mode: { yolo: false, longRunning: true },
		});
		expect(await tab.take(ofType("mode"))).toEqual({
			type: "mode",
			room: GUIDE,
			yolo: false,
			longRunning: true,
		});
		expect(modes.peek(GUIDE).longRunning).toBe(true);
		const rooms = (await (await rest(app, "rooms")).json()) as RoomsView;
		expect(rooms.rooms.find((r) => r.key === GUIDE)?.mode).toEqual({
			yolo: false,
			longRunning: true,
		});
		await put(GUIDE, { longRunning: false });
		tab.close();
	});

	test("a JSON body that streams past 64 KiB without a length is refused, not held whole", async () => {
		const chunk = new TextEncoder().encode(" ".repeat(16 * 1024));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 6; i++) controller.enqueue(chunk);
				controller.enqueue(new TextEncoder().encode('{"yolo":true}'));
				controller.close();
			},
		});
		const response = await fetch(
			`http://localhost/console/api/rooms/${encodeURIComponent(GUIDE)}/mode`,
			{
				method: "PUT",
				body,
				duplex: "half",
				headers: {
					"x-actor": "owner",
					origin: ORIGIN,
					"content-type": "application/json",
				},
				unix: app.socket,
			} as never,
		);
		expect(response.status).toBe(413);
		expect(app.host.context.services.get(MODES).peek(GUIDE).yolo).toBe(false);
	});

	test("the page learns who it is, where the app is, and how to reach an agent's picture", async () => {
		const session = (await (await rest(app, "session")).json()) as {
			principal: { id: string; name: string };
			surface: string;
		};
		expect(session).toMatchObject({
			principal: { id: ADA_DISCORD },
			surface: "app",
			auth: "verifier",
		});
		const config = (await (await rest(app, "config")).json()) as {
			panes: string[];
			app?: { surface: string; protocol: string };
		};
		expect(config.panes).toEqual(["rooms", "schedules", "overview"]);
		expect(config.app).toEqual({ surface: "app", protocol: APP_PROTOCOL });
		const rooms = (await (await rest(app, "rooms")).json()) as RoomsView;
		// An agent dressed by an earlier test or run keeps its picture's hash, whose file lies in a data
		// directory that may be gone; drawing the look again puts the file in this one.
		const { directory, avatars } = app.host.context.services.get(AGENTS);
		const look = directory.agent("guide")?.character;
		if (look) await avatars.render(look);
		const avatar = rooms.rooms.find((r) => r.key === GUIDE)?.avatar;
		expect(avatar).toMatch(/^\/console\/avatars\/[0-9a-f]+\.png$/);
		const picture = await fetch(`http://localhost${avatar}`, {
			headers: { "x-actor": "owner" },
			unix: app.socket,
		} as never);
		expect(picture.status).toBe(200);
		expect(picture.headers.get("content-type")).toBe("image/png");
		const refused = await fetch(`http://localhost${avatar}`, {
			headers: { "x-actor": "member" },
			unix: app.socket,
		} as never);
		expect(refused.status).toBe(403);
	});

	test("the avatar route is gone: a picture is no longer redrawn over REST", async () => {
		const redraw = await rest(app, "agents/scout/avatar", {
			method: "POST",
			body: JSON.stringify({ mode: "redraw" }),
		});
		expect(redraw.status).toBe(404);
	});

	test("a socket closes with 4401 when its credential lapses", async () => {
		const tab = await Client.open(app, {
			"x-actor": "owner",
			"x-expire-ms": "400",
		});
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		const deadline = Date.now() + 3000;
		while (!tab.closed && Date.now() < deadline) await Bun.sleep(20);
		expect(tab.closed?.code).toBe(4401);
	});

	test("history survives a restart of the host", async () => {
		const { dataDir } = app;
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({ type: "send", id: "k1", room: GUIDE, text: "kept across it" });
		await tab.take(agentReply("guide"));
		tab.close();
		const before = (await (
			await rest(app, `rooms/${encodeURIComponent(GUIDE)}/messages`)
		).json()) as MessagesView;
		expect(before.messages.length).toBeGreaterThan(1);
		await app.stop();
		app = await boot({ auth: "verifier", dataDir, graceSeconds: 0.4 });
		const after = (await (
			await rest(app, `rooms/${encodeURIComponent(GUIDE)}/messages`)
		).json()) as MessagesView;
		expect(after.messages.map((m) => m.id)).toEqual(
			before.messages.map((m) => m.id),
		);
		// A page before an id holds the older ones.
		const older = (await (
			await rest(
				app,
				`rooms/${encodeURIComponent(GUIDE)}/messages?before=${after.messages[1]?.id}&limit=1`,
			)
		).json()) as MessagesView;
		expect(older.messages).toHaveLength(1);
		expect(older.messages[0]?.id).toBe(after.messages[0]?.id);
		// `more` says whether anything is older than that page; the shared test database keeps rooms from earlier runs.
		const beyond = (await (
			await rest(
				app,
				`rooms/${encodeURIComponent(GUIDE)}/messages?before=${after.messages[0]?.id}&limit=1`,
			)
		).json()) as MessagesView;
		expect(older.more).toBe(beyond.messages.length > 0);
		// The mode it was left in survives too.
		expect(app.host.context.services.get(MODES).peek(GUIDE).longRunning).toBe(
			false,
		);
	});
});

describeDb("the app on a host with no authentication of its own", () => {
	test("a message written through `none` resolves to the primary owner", async () => {
		const none = await boot({ auth: "none" });
		try {
			const tab = await Client.open(none, {});
			if (!tab) throw new Error("the listener's owner was refused");
			tab.send({ type: "send", id: "n1", room: GUIDE, text: "from the web" });
			await tab.take(agentReply("guide"));
			const turn = none.seen.find((r) => r.text.includes("from the web"));
			expect(turn?.speaker).toMatchObject({
				tier: "owner",
				principalId: ADA_DISCORD,
			});
			tab.close();
		} finally {
			await none.stop();
		}
	}, 30_000);
});

describeDb("a group round of the app over a team without Discord", () => {
	let local: Booted;
	beforeAll(async () => {
		local = await boot({ auth: "verifier", local: true });
	}, 30_000);
	afterAll(async () => {
		await local.stop();
	});
	afterEach(() => local.reset());

	test("a group round names the member speaking", async () => {
		const { directory, team } = local.host.context.services.get(AGENTS);
		// The team starts in the background and seeds its agents as it goes.
		await until(async () =>
			directory.agent("scout")?.status === "active" ? true : undefined,
		);
		if (!directory.group("duo"))
			// The group tool's entry is the host's own; the public type leaves it out.
			await (
				team as unknown as {
					createGroup(input: {
						name: string;
						displayName: string;
						members: string[];
						host: string;
					}): Promise<string>;
				}
			).createGroup({
				name: "duo",
				displayName: "Duo",
				members: ["guide", "scout"],
				host: "guide",
			});
		local.scripts.set("round-table", async (request) => {
			request.progress?.({ type: "text", delta: "thinking" });
			await Bun.sleep(30);
			return { ok: true, text: `${request.agent?.name} speaks` };
		});
		const tab = await Client.open(local, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({
			type: "send",
			id: "g1",
			room: "app:group.duo",
			text: "round-table",
		});
		const named = await tab.take(
			(frame) =>
				frame.type === "activity" &&
				frame.room === "app:group.duo" &&
				frame.agent !== undefined,
		);
		expect(["guide", "scout"]).toContain(
			(named as { agent?: string }).agent as string,
		);
		await tab.take(activity("app:group.duo", { typing: false }));
		tab.close();
	});
});
