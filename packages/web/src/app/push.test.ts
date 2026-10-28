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
import type { PushDevicesView, ServerFrame } from "../api-types.ts";
import { APP_PROTOCOL } from "../app/protocol.ts";
import { fakePushService, receiver } from "../testing/push.ts";
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
			webConsole({
				verifier,
				push: { fetch: options.fetch },
				origin: ORIGIN,
				dataDir,
				assetDir: assets,
				cardGraceSeconds: options.graceSeconds ?? 120,
				panes: ["rooms", "schedules", "overview"],
			}),
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
	}, 30_000);
	afterAll(async () => {
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
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

async function waitFor(done: () => boolean | Promise<boolean>, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!(await done())) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await Bun.sleep(20);
	}
}
