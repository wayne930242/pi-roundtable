import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ActorFacts,
	IDENTITY,
	promptScope,
	type TurnRequest,
	type TurnResult,
} from "pi-roundtable";
import { describeDb, type TestHost, testHost } from "pi-roundtable/testing";
import type { PushDevicesView, RoomsView, ServerFrame } from "../api-types.ts";
import { APP_PROTOCOL } from "../app/protocol.ts";
import { MAX_DEVICES } from "../push/api.ts";
import { fakePushService, receiver, withPushFetch } from "../testing/push.ts";
import { admitAs, refuse, type Verdict } from "../verifier.ts";
import { webConsole } from "../web-plugin.ts";

const ORIGIN = "https://app.example.test";
const ADA_DISCORD = "100000000000000001";
const MEL_DISCORD = "200000000000000002";
/** A guild of this suite's own, so the agents other suites stored in the shared database are not on this team. */
const GUILD = "900000000000000741";
const ENTRY_CHANNEL = "900000000000000742";
const ADA: ActorFacts = {
	provider: "discord",
	subject: ADA_DISCORD,
	name: "Ada",
};
const MEL: ActorFacts = {
	provider: "discord",
	subject: MEL_DISCORD,
	name: "Mel",
};

/** The sockets' verifier: the header `x-actor` names who the proxy vouches for. */
function verifier(request: Request): Verdict {
	const who = request.headers.get("x-actor");
	if (who === "owner") {
		const expire = Number(request.headers.get("x-expire-ms"));
		return admitAs(ADA, expire > 0 ? new Date(Date.now() + expire) : undefined);
	}
	if (who === "member") return admitAs(MEL);
	return refuse("no proxy assertion");
}

/** What a scripted turn does; absent, the turn answers by echoing the text. */
type Script = (
	request: TurnRequest,
	signal: AbortSignal,
) => Promise<TurnResult>;

interface Booted {
	host: TestHost;
	socket: string;
	dataDir: string;
	seen: TurnRequest[];
	scripts: Map<string, Script>;
	stops: string[];
	stop(): Promise<void>;
}

/** Boots the host over the test database with the app's plugin and a runtime that follows scripts. */
async function boot(options: {
	fetch: typeof fetch;
	graceSeconds?: number;
	/** The push quiet hours; off unless a test asks, so no test depends on the hour it runs at. */
	quietHours?: { start: string; end: string };
}): Promise<Booted> {
	const dataDir = mkdtempSync(join(tmpdir(), "app-socket-"));
	const socket = join(dataDir, "public.sock");
	const assets = mkdtempSync(join(tmpdir(), "app-socket-page-"));
	writeFileSync(join(assets, "index.html"), "<html>app</html>");
	const seen: TurnRequest[] = [];
	const scripts = new Map<string, Script>();
	const running = new Map<string, AbortController>();
	const stops: string[] = [];
	const runtime = {
		runTurn: async (request: TurnRequest): Promise<TurnResult> => {
			seen.push(request);
			const controller = new AbortController();
			running.set(request.channel, controller);
			try {
				const script = [...scripts].find(([marker]) =>
					request.text.includes(marker),
				)?.[1];
				if (script) return await script(request, controller.signal);
				return { ok: true, text: `echo ${request.text}` };
			} finally {
				running.delete(request.channel);
			}
		},
		steer: async () => false,
		stop: (channel: string) => {
			stops.push(channel);
			const controller = running.get(channel as never);
			controller?.abort();
			return controller !== undefined;
		},
		startFresh: async () => undefined,
		deleteConversation: async () => undefined,
		pendingConfirmation: () => undefined,
		heldActions: async () => undefined,
		recentTranscript: async () => [],
	};
	const host = await testHost({
		config: {
			dataDir,
			discord: { token: "token", guild: GUILD, entryChannel: ENTRY_CHANNEL },
			http: { publicUrl: "https://bot.example.com", socketPath: socket },
			access: {
				owners: [
					{
						name: "Ada",
						principal: ADA_DISCORD,
						identities: [`discord:${ADA_DISCORD}`],
					},
				],
				members: { identities: [`discord:${MEL_DISCORD}`] },
			},
			agents: [
				{
					name: "guide",
					displayName: "Guide",
					prompt: "You guide.",
					avatarPrompt: "A guide",
					channelId: ENTRY_CHANNEL,
				},
				{
					name: "scout",
					displayName: "Scout",
					prompt: "You scout.",
					avatarPrompt: "A scout",
				},
			],
		},
		runtime,
		plugins: [
			webConsole(
				withPushFetch(
					{
						verifier,
						origin: ORIGIN,
						dataDir,
						assetDir: assets,
						cardGraceSeconds: options.graceSeconds ?? 120,
						panes: ["rooms", "schedules", "overview"],
						push: { quietHours: options.quietHours ?? false },
					},
					options.fetch,
				),
			),
		],
	});
	return {
		host,
		socket,
		dataDir,
		seen,
		scripts,
		stops,
		stop: () => host.stop(),
	};
}

/** One app WebSocket and the frames it received. */
class Client {
	readonly frames: ServerFrame[] = [];
	/** Frames before this index have been passed over by a `take`. */
	#cursor = 0;
	readonly #ws: WebSocket;
	closed: { code: number } | undefined;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.onmessage = (event) =>
			this.frames.push(JSON.parse(String(event.data)) as ServerFrame);
		ws.onclose = (event) => {
			this.closed = { code: event.code };
		};
	}

	/** Opens a socket, or undefined when the upgrade is refused. */
	static async open(
		boot: Booted,
		headers: Record<string, string>,
		origin: string = ORIGIN,
	): Promise<Client | undefined> {
		const ws = new WebSocket(`ws+unix://${boot.socket}:/console/api/socket`, {
			protocols: [APP_PROTOCOL],
			headers: { origin, ...headers },
		} as never);
		const opened = await new Promise<boolean>((resolve) => {
			ws.onopen = () => resolve(true);
			ws.onerror = () => resolve(false);
			ws.onclose = () => resolve(false);
		});
		return opened ? new Client(ws) : undefined;
	}

	send(frame: object): void {
		this.#ws.send(JSON.stringify(frame));
	}

	/** The first frame after the last one taken that `match` accepts; waits up to `ms`. */
	async take<T extends ServerFrame>(
		match: (frame: ServerFrame) => frame is T,
		ms?: number,
	): Promise<T>;
	async take(
		match: (frame: ServerFrame) => boolean,
		ms?: number,
	): Promise<ServerFrame>;
	async take(
		match: (frame: ServerFrame) => boolean,
		ms = 4000,
	): Promise<ServerFrame> {
		const deadline = Date.now() + ms;
		for (;;) {
			const at = this.frames.findIndex(
				(frame, index) => index >= this.#cursor && match(frame),
			);
			if (at >= 0) {
				this.#cursor = at + 1;
				return this.frames[at] as ServerFrame;
			}
			if (Date.now() > deadline)
				throw new Error(
					`no frame arrived; got ${this.frames.map((f) => f.type).join(", ")}`,
				);
			await Bun.sleep(10);
		}
	}

	/** Whether a frame matching shows up within `ms` (it is not taken). */
	async sees(
		match: (frame: ServerFrame) => boolean,
		ms = 300,
	): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (this.frames.some((f, index) => index >= this.#cursor && match(f)))
				return true;
			await Bun.sleep(10);
		}
		return false;
	}

	close(): void {
		this.#ws.close();
	}
}

const ofType =
	<K extends ServerFrame["type"]>(type: K) =>
	(frame: ServerFrame): frame is Extract<ServerFrame, { type: K }> =>
		frame.type === type;

const agentReply = (agent: string) => (frame: ServerFrame) =>
	frame.type === "message" && frame.message.agent === agent;

/** A request to the app's REST over the host's unix socket. */
function rest(
	boot: Booted,
	path: string,
	init: RequestInit & { who?: string; origin?: string | null } = {},
): Promise<Response> {
	const { who = "owner", origin = ORIGIN, ...rest } = init;
	return fetch(`http://localhost/console/api/${path}`, {
		...rest,
		headers: {
			"x-actor": who,
			...(origin ? { origin } : {}),
			...(rest.body ? { "content-type": "application/json" } : {}),
			...(rest.headers as Record<string, string> | undefined),
		},
		unix: boot.socket,
	} as never);
}

const SCOUT = "app:agent.scout";
const GUIDE = "app:agent.guide";
const FCM = "https://fcm.googleapis.com/fcm/send/";

describeDb("push over a real host", () => {
	let status = 201;
	const service = fakePushService(() => status);
	let app: Booted;
	beforeAll(async () => {
		app = await boot({ fetch: service.fetch, graceSeconds: 5 });
		await app.host.context.services.get(IDENTITY).resolve(MEL);
		// The database is shared with other suites and earlier runs; this suite's devices start from none.
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
		await app.host.context.database()`DELETE FROM web_push_muted_rooms`;
	}, 30_000);
	afterAll(async () => {
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
		await app.host.context.database()`DELETE FROM web_push_muted_rooms`;
		await app.stop();
	});

	const subscribe = async (endpoint: string, who = "owner") => {
		const device = await receiver();
		const answer = await rest(app, "push/subscriptions", {
			method: "POST",
			who,
			body: JSON.stringify(device.subscription(endpoint, "Test phone")),
		});
		return { device, answer };
	};
	const devices = async () =>
		(await (await rest(app, "push/subscriptions")).json()) as PushDevicesView;

	test("a subscription to a push service that is not allowed is refused", async () => {
		const device = await receiver();
		for (const endpoint of [
			"https://evil.example/x",
			"http://fcm.googleapis.com/x",
			"https://127.0.0.1/x",
		]) {
			const answer = await rest(app, "push/subscriptions", {
				method: "POST",
				body: JSON.stringify(device.subscription(endpoint)),
			});
			expect(answer.status).toBe(400);
		}
		expect((await devices()).devices).toEqual([]);
	});

	test("a subscription needs an owner, a real key, and the app's own origin", async () => {
		const device = await receiver();
		const good = JSON.stringify(device.subscription(`${FCM}x`));
		expect(
			(
				await rest(app, "push/subscriptions", {
					method: "POST",
					who: "member",
					body: good,
				})
			).status,
		).toBe(403);
		expect(
			(
				await rest(app, "push/subscriptions", {
					method: "POST",
					origin: "https://evil.example.test",
					body: good,
				})
			).status,
		).toBe(403);
		const broken = {
			...device.subscription(`${FCM}x`),
			keys: { p256dh: "AAAA", auth: "AAAA" },
		};
		expect(
			(
				await rest(app, "push/subscriptions", {
					method: "POST",
					body: JSON.stringify(broken),
				})
			).status,
		).toBe(400);
		expect((await rest(app, "push/key", { who: "member" })).status).toBe(403);
		const key = (await (await rest(app, "push/key")).json()) as { key: string };
		expect(Buffer.from(key.key, "base64url")).toHaveLength(65);
		expect((await devices()).devices).toEqual([]);
	});

	test("a card with no page in view sends exactly one sealed push, and none while a page is in view", async () => {
		const { device, answer } = await subscribe(`${FCM}phone`);
		expect(answer.status).toBe(200);
		expect((await devices()).devices).toHaveLength(1);
		app.scripts.set("hold-me", async (request) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			const result = await prompts?.confirm(
				"Send the secret note?",
				"details",
				undefined,
				"owner",
			);
			return { ok: true, text: `held ${result}` };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({ type: "hello", visible: true });
		tab.send({ type: "send", id: "v1", room: SCOUT, text: "hold-me one" });
		const first = await tab.take(ofType("prompt"));
		// A page is in view: the card is shown there, and nothing is pushed.
		await Bun.sleep(150);
		expect(service.posts).toHaveLength(0);
		tab.send({ type: "approval", prompt: first.prompt.id, approved: false });
		await tab.take(ofType("prompt_closed"));
		await tab.take(agentReply("scout"));
		// The page goes to the background.
		tab.send({ type: "visibility", visible: false });
		tab.send({ type: "send", id: "v2", room: SCOUT, text: "hold-me two" });
		const second = await tab.take(ofType("prompt"));
		await waitFor(() => service.posts.length === 1);
		await Bun.sleep(150);
		expect(service.posts).toHaveLength(1);
		const post = service.posts[0];
		if (!post) throw new Error("no push");
		expect(post.url).toBe(`${FCM}phone`);
		expect(post.headers.get("content-encoding")).toBe("aes128gcm");
		expect(post.headers.get("authorization")).toMatch(/^vapid t=.+, k=.+$/);
		// The note's text is in the card, not on the wire in the clear; the title is in the sealed payload.
		expect(Buffer.from(post.body).toString("latin1")).not.toContain("secret");
		expect(await device.open(post.body)).toMatchObject({
			kind: "card",
			title: "Card waiting",
			body: "Send the secret note?",
			room: SCOUT,
			url: `/console/#/room/${encodeURIComponent(SCOUT)}`,
		});
		tab.send({ type: "approval", prompt: second.prompt.id, approved: false });
		await tab.take(agentReply("scout"));
		tab.close();
	});

	test("a reply no page asked for is pushed, and a reply to a page's message is not", async () => {
		service.posts.length = 0;
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({ type: "hello", visible: false });
		tab.send({ type: "send", id: "r1", room: SCOUT, text: "answer me" });
		await tab.take(agentReply("scout"));
		await Bun.sleep(150);
		expect(service.posts).toHaveLength(0);
		// A later post to the room (a report, a schedule) comes with no message of a page behind it.
		await app.host.context.surfaces.sendReply(SCOUT, {
			chunks: ["the nightly report is ready"],
			author: { name: "Scout", agent: "scout" },
		});
		await waitFor(() => service.posts.length === 1);
		tab.close();
	});

	test("an owner mutes a room for every owner's devices: its posts wait, its cards still come", async () => {
		service.posts.length = 0;
		const put = (key: string, body: unknown, init: object = {}) =>
			rest(app, `rooms/${encodeURIComponent(key)}/mute`, {
				method: "PUT",
				body: JSON.stringify(body),
				...init,
			});
		const listed = async () =>
			((await (await rest(app, "rooms")).json()) as RoomsView).rooms.find(
				(room) => room.key === GUIDE,
			);
		// Refused: no such room, a room of another surface, a request from elsewhere, a member, a bad body.
		for (const key of [
			"app:agent.nobody",
			"app:group.nobody",
			"other:agent.guide",
			"app:agent_guide",
		])
			expect((await put(key, { muted: true })).status).toBe(404);
		expect((await put(GUIDE, { muted: true }, { origin: null })).status).toBe(
			403,
		);
		expect(
			(
				await put(
					GUIDE,
					{ muted: true },
					{ origin: "https://evil.example.test" },
				)
			).status,
		).toBe(403);
		expect((await put(GUIDE, { muted: true }, { who: "member" })).status).toBe(
			403,
		);
		expect((await put(GUIDE, { muted: "yes" })).status).toBe(400);
		expect((await put(GUIDE, {})).status).toBe(400);
		expect((await listed())?.muted).toBeUndefined();

		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({ type: "hello", visible: false });
		const muted = await put(GUIDE, { muted: true });
		expect(muted.status).toBe(200);
		expect(await muted.json()).toEqual({ muted: true });
		// Every open page is told to read the list again.
		await tab.take(ofType("changed"));
		expect((await listed())?.muted).toBe(true);
		// Muting twice is the same as once.
		expect((await put(GUIDE, { muted: true })).status).toBe(200);

		await app.host.context.surfaces.sendReply(GUIDE, {
			chunks: ["a report nobody needs tonight"],
			author: { name: "Guide", agent: "guide" },
		});
		await Bun.sleep(300);
		expect(service.posts).toHaveLength(0);
		app.scripts.set("hold-muted", async (request) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			await prompts?.confirm("Send it?", "details", undefined, "owner");
			return { ok: true, text: "done" };
		});
		tab.send({ type: "send", id: "m1", room: GUIDE, text: "hold-muted" });
		const card = await tab.take(ofType("prompt"));
		await waitFor(() => service.posts.length === 1);
		tab.send({ type: "approval", prompt: card.prompt.id, approved: false });
		await tab.take(agentReply("guide"));

		// Unmuted, the room's posts are pushed again.
		service.posts.length = 0;
		const unmuted = await put(GUIDE, { muted: false });
		expect(await unmuted.json()).toEqual({ muted: false });
		expect((await listed())?.muted).toBeUndefined();
		await Bun.sleep(300);
		await app.host.context.surfaces.sendReply(GUIDE, {
			chunks: ["a report worth hearing"],
			author: { name: "Guide", agent: "guide" },
		});
		await waitFor(() => service.posts.length === 1);
		tab.close();
	});

	test("a push service that says the device is gone drops the subscription", async () => {
		service.posts.length = 0;
		status = 410;
		app.scripts.set("hold-gone", async (request) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			await prompts?.confirm("Again?", "details", undefined, "owner");
			return { ok: true, text: "done" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({ type: "hello", visible: false });
		tab.send({ type: "send", id: "g1", room: SCOUT, text: "hold-gone" });
		const card = await tab.take(ofType("prompt"));
		await waitFor(async () => (await devices()).devices.length === 0);
		expect(service.posts).toHaveLength(1);
		tab.send({ type: "approval", prompt: card.prompt.id, approved: false });
		tab.close();
		status = 201;
	});

	test("the device cap holds when many are added at once, and a re-subscribe is not counted", async () => {
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
		const statuses = await Promise.all(
			Array.from({ length: 30 }, async (_, n) => {
				const device = await receiver();
				return (
					await rest(app, "push/subscriptions", {
						method: "POST",
						body: JSON.stringify(device.subscription(`${FCM}cap${n}`)),
					})
				).status;
			}),
		);
		expect(statuses.filter((s) => s === 200)).toHaveLength(MAX_DEVICES);
		expect(statuses.filter((s) => s === 400)).toHaveLength(10);
		expect((await devices()).devices).toHaveLength(MAX_DEVICES);
		const stored: { endpoint: string }[] = await app.host.context.database()`
			SELECT endpoint FROM web_push_subscriptions LIMIT 1`;
		const again = await receiver();
		expect(
			(
				await rest(app, "push/subscriptions", {
					method: "POST",
					body: JSON.stringify(again.subscription(stored[0]?.endpoint ?? "")),
				})
			).status,
		).toBe(200);
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
	});

	test("an endpoint that is another person's is refused, not taken over", async () => {
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
		const endpoint = `${FCM}shared`;
		await app.host.context.database()`
			INSERT INTO web_push_subscriptions (endpoint, principal_id, p256dh, auth)
			VALUES (${endpoint}, 'someone-else', 'x', 'y')`;
		const device = await receiver();
		const answer = await rest(app, "push/subscriptions", {
			method: "POST",
			body: JSON.stringify(device.subscription(endpoint)),
		});
		expect(answer.status).toBe(409);
		const rows: { principal_id: string; p256dh: string }[] =
			await app.host.context.database()`
			SELECT principal_id, p256dh FROM web_push_subscriptions WHERE endpoint = ${endpoint}`;
		expect(rows).toEqual([{ principal_id: "someone-else", p256dh: "x" }]);
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
	});

	test("an endpoint is removed by its normalized form, and one the policy refuses is refused", async () => {
		await subscribe(`${FCM}Norm`);
		const refused = await rest(app, "push/subscriptions", {
			method: "DELETE",
			body: JSON.stringify({ endpoint: "https://evil.example.com/x" }),
		});
		expect(refused.status).toBe(400);
		expect((await devices()).devices).toHaveLength(1);
		const gone = await rest(app, "push/subscriptions", {
			method: "DELETE",
			body: JSON.stringify({
				endpoint: "https://FCM.googleapis.com/fcm/send/Norm",
			}),
		});
		expect(gone.status).toBe(200);
		expect((await devices()).devices).toEqual([]);
	});

	test("an owner lists and removes their own devices, and no one else's", async () => {
		const { answer } = await subscribe(`${FCM}tablet`);
		const { id } = (await answer.json()) as { id: string };
		const listed = await devices();
		expect(listed.devices).toMatchObject([{ id, label: "Test phone" }]);
		expect(JSON.stringify(listed)).not.toContain("fcm.googleapis.com");
		expect(
			(
				await rest(app, `push/subscriptions/${"0".repeat(64)}`, {
					method: "DELETE",
				})
			).status,
		).toBe(404);
		expect(
			(
				await rest(app, `push/subscriptions/${id}`, {
					method: "DELETE",
					who: "member",
				})
			).status,
		).toBe(403);
		expect(
			(await rest(app, `push/subscriptions/${id}`, { method: "DELETE" }))
				.status,
		).toBe(200);
		expect((await devices()).devices).toEqual([]);
		// Unsubscribing a device by its endpoint, as the page does for itself.
		await subscribe(`${FCM}laptop`);
		const gone = await rest(app, "push/subscriptions", {
			method: "DELETE",
			body: JSON.stringify({ endpoint: `${FCM}laptop` }),
		});
		expect(gone.status).toBe(200);
		expect((await devices()).devices).toEqual([]);
	});
});

/** `HH:MM` of a moment on the UTC clock, which is the test host's time zone. */
const utcClock = (ms: number): string =>
	new Date(ms).toISOString().slice(11, 16);

describeDb("push in the quiet hours over a real host", () => {
	const service = fakePushService(() => 201);
	let app: Booted;
	beforeAll(async () => {
		const now = Date.now();
		// A window of four hours around now, so the suite does not depend on the hour it runs at.
		app = await boot({
			fetch: service.fetch,
			graceSeconds: 5,
			quietHours: {
				start: utcClock(now - 2 * 3_600_000),
				end: utcClock(now + 2 * 3_600_000),
			},
		});
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
	}, 30_000);
	afterAll(async () => {
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
		await app.stop();
	});

	test("an agent's post is not pushed, a waiting card is, and the page is told the window", async () => {
		const device = await receiver();
		const added = await rest(app, "push/subscriptions", {
			method: "POST",
			body: JSON.stringify(device.subscription(`${FCM}quiet`, "Quiet phone")),
		});
		expect(added.status).toBe(200);
		const session = (await (await rest(app, "session")).json()) as {
			quietHours?: { start: string; end: string; timeZone: string };
		};
		expect(session.quietHours).toMatchObject({ timeZone: "UTC" });
		await app.host.context.surfaces.sendReply(SCOUT, {
			chunks: ["the nightly report is ready"],
			author: { name: "Scout", agent: "scout" },
		});
		await Bun.sleep(300);
		expect(service.posts).toHaveLength(0);
		app.scripts.set("hold-quiet", async (request) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			await prompts?.confirm("Send it?", "details", undefined, "owner");
			return { ok: true, text: "done" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({ type: "hello", visible: false });
		tab.send({ type: "send", id: "q1", room: SCOUT, text: "hold-quiet" });
		const card = await tab.take(ofType("prompt"));
		await waitFor(() => service.posts.length === 1);
		const post = service.posts[0];
		if (!post) throw new Error("no push");
		expect(await device.open(post.body)).toMatchObject({
			kind: "card",
			title: "Card waiting",
			room: SCOUT,
		});
		tab.send({ type: "approval", prompt: card.prompt.id, approved: false });
		tab.close();
	});
});

async function waitFor(done: () => boolean | Promise<boolean>, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!(await done())) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await Bun.sleep(20);
	}
}
