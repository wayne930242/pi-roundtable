import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ActorFacts,
	AGENTS,
	type ApprovedBy,
	IDENTITY,
	MODES,
	type PromptWait,
	promptScope,
	SCHEDULES,
	type TurnRequest,
	type TurnResult,
} from "pi-roundtable";
import { describeDb, type TestHost, testHost } from "pi-roundtable/testing";
import type {
	MessagesView,
	RoomsView,
	SchedulesView,
	ServerFrame,
} from "../api-types.ts";
import { admitAs, refuse, type Verdict } from "../verifier.ts";
import { webConsole } from "../web-plugin.ts";
import { APP_PROTOCOL } from "./protocol.ts";

const ORIGIN = "https://app.example.test";
const ADA_DISCORD = "100000000000000001";
const MEL_DISCORD = "200000000000000002";
/** A guild of this suite's own, so the agents other suites stored in the shared database are not on this team. */
const GUILD = "900000000000000731";
const ENTRY_CHANNEL = "900000000000000732";
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

const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

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
	auth: "verifier" | "none";
	dataDir?: string;
	graceSeconds?: number;
}): Promise<Booted> {
	const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "app-socket-"));
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
				...(options.auth === "none"
					? { auth: { mode: "none" as const } }
					: { verifier }),
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

const GUIDE = "app:agent.guide";
const SCOUT = "app:agent.scout";

describeDb("the owner app over a real host", () => {
	let app: Booted;
	beforeAll(async () => {
		app = await boot({ auth: "verifier", graceSeconds: 0.4 });
		await app.host.context.services.get(IDENTITY).resolve(MEL);
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});

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
			message: { kind: "owner", author: "Ada", text: "hello team" },
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
		expect(rooms.rooms.map((r) => [r.key, r.home])).toEqual([
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

	test("a card reaches every owner socket and an approval runs the call", async () => {
		const outcomes: unknown[] = [];
		app.scripts.set("hold-me", async (request, signal) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			let by: ApprovedBy | undefined;
			let prompt: string | undefined;
			const result = await prompts?.confirm(
				"Send it?",
				"Send the note",
				signal,
				"owner",
				undefined,
				{ action: "send a note", tool: "note_send", input: { to: "team" } },
				{
					approvedBy: (who) => {
						by = who;
					},
					approvedPrompt: (id) => {
						prompt = id;
					},
				},
			);
			outcomes.push({ result, by, prompt });
			return { ok: true, text: `held ${result}` };
		});
		const one = await Client.open(app, { "x-actor": "owner" });
		const two = await Client.open(app, { "x-actor": "owner" });
		if (!one || !two) throw new Error("the owner was refused");
		one.send({ type: "send", id: "h1", room: SCOUT, text: "hold-me" });
		const shown = await one.take(ofType("prompt"));
		const same = await two.take(ofType("prompt"));
		expect(same.prompt.id).toBe(shown.prompt.id);
		expect(shown).toMatchObject({
			room: SCOUT,
			prompt: {
				kind: "approval",
				title: "Send it?",
				purpose: "action",
				approval: { tool: "note_send" },
			},
		});
		// The second socket answers; both are told it closed.
		two.send({ type: "approval", prompt: shown.prompt.id, approved: true });
		expect(await one.take(ofType("prompt_closed"))).toMatchObject({
			prompt: shown.prompt.id,
			outcome: "approved",
		});
		await two.take(ofType("prompt_closed"));
		await one.take(agentReply("scout"));
		expect(outcomes).toEqual([
			{
				result: "approved",
				by: {
					principalId: ADA_DISCORD,
					speakerId: `discord:${ADA_DISCORD}`,
					name: "Ada",
					owner: true,
				},
				prompt: shown.prompt.id,
			},
		]);
		// A socket that connects later is shown the cards still open.
		one.close();
		two.close();
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

	test("cancelling a question tells the tool it was declined", async () => {
		const answers: unknown[] = [];
		app.scripts.set("ask-me", async (request, signal) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			const answer = await prompts?.ask(
				"Which?",
				{
					question: "Which colour?",
					options: [{ label: "red" }, { label: "blue" }],
					multi: false,
					allowOther: false,
				},
				signal,
			);
			answers.push(answer);
			return { ok: true, text: "asked" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "a1", room: SCOUT, text: "ask-me" });
		const card = await tab.take(ofType("prompt"));
		expect(card.prompt.kind).toBe("ask");
		// An answer the question does not allow is refused and the card stays open.
		tab.send({
			type: "answer",
			prompt: card.prompt.id,
			answer: { choices: ["green"] },
		});
		expect((await tab.take(ofType("refused"))).code).toBe("bad_frame");
		tab.send({ type: "cancel", prompt: card.prompt.id });
		expect(await tab.take(ofType("prompt_closed"))).toMatchObject({
			outcome: "declined",
		});
		await tab.take(agentReply("scout"));
		expect(answers).toEqual(["declined"]);
		tab.close();
	});

	test("after the grace the card stays open and a late approval starts a turn in the room", async () => {
		const waits: unknown[] = [];
		const results: unknown[] = [];
		app.scripts.set("late-card", async (request, signal) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			const wait: PromptWait = {
				late: (answer) => {
					waits.push(answer);
					return "carry on with the approved plan";
				},
			};
			const result = await prompts?.confirm(
				"Deploy?",
				"Deploy now",
				signal,
				"owner",
				wait,
				undefined,
				{ purpose: "action" },
			);
			results.push(result);
			return { ok: true, text: `late ${result}` };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "l1", room: GUIDE, text: "late-card" });
		const card = await tab.take(ofType("prompt"));
		expect(card.prompt).not.toHaveProperty("late");
		// The turn stops waiting and the card is shown again as late.
		const again = await tab.take(ofType("prompt"));
		expect(again.prompt).toMatchObject({ id: card.prompt.id, late: true });
		await tab.take(agentReply("guide"));
		expect(results).toEqual(["pending"]);
		// A fresh socket is shown the open card too.
		const fresh = await Client.open(app, { "x-actor": "owner" });
		if (!fresh) throw new Error("the owner was refused");
		const resent = await fresh.take(ofType("prompt"));
		expect(resent.prompt).toMatchObject({ id: card.prompt.id, late: true });
		fresh.close();
		tab.send({ type: "approval", prompt: card.prompt.id, approved: true });
		await tab.take(ofType("prompt_closed"));
		expect(waits).toMatchObject([
			{ kind: "approval", approved: true, by: "Ada" },
		]);
		// The text `late` returned is the owner's message, in the room, and runs a turn.
		const message = await tab.take(
			(frame): frame is Extract<ServerFrame, { type: "message" }> =>
				frame.type === "message" && frame.message.kind === "owner",
		);
		expect(message.message.text).toBe("carry on with the approved plan");
		await tab.take(
			(frame) =>
				frame.type === "message" &&
				frame.message.text === "echo carry on with the approved plan",
		);
		tab.close();
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

	test("yolo approvals are shown in the room", async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		const modes = app.host.context.services.get(MODES);
		modes.autoApproved({
			channel: SCOUT,
			tool: "shell",
			action: "write notes.txt",
			classes: ["shell.write"],
			principalId: ADA_DISCORD,
			at: new Date(),
		});
		const line = await tab.take(
			(frame) => frame.type === "message" && frame.message.kind === "system",
		);
		if (line.type !== "message") throw new Error("expected a message");
		expect(line.message.text).toContain("write notes.txt");
		expect(await tab.take(ofType("auto_approved"))).toEqual({
			type: "auto_approved",
			room: SCOUT,
			tool: "shell",
			action: "write notes.txt",
		});
		tab.close();
	});

	test("progress streams to the sockets that focus the room", async () => {
		app.scripts.set("show-progress", async (request) => {
			request.progress?.({ type: "text", delta: "thinking about it" });
			request.progress?.({ type: "tool_start", id: "t1", tool: "web_search" });
			return { ok: true, text: "done" };
		});
		const watching = await Client.open(app, { "x-actor": "owner" });
		const elsewhere = await Client.open(app, { "x-actor": "owner" });
		if (!watching || !elsewhere) throw new Error("the owner was refused");
		watching.send({ type: "hello", visible: true, focus: SCOUT });
		elsewhere.send({ type: "hello", visible: true, focus: GUIDE });
		await Bun.sleep(100);
		watching.send({
			type: "send",
			id: "p1",
			room: SCOUT,
			text: "show-progress",
		});
		expect(await watching.take(ofType("progress"))).toEqual({
			type: "progress",
			room: SCOUT,
			event: { type: "text", delta: "thinking about it" },
		});
		await watching.take(agentReply("scout"));
		await elsewhere.take(agentReply("scout"));
		expect(elsewhere.frames.some((f) => f.type === "progress")).toBe(false);
		watching.close();
		elsewhere.close();
	});

	test("an upload goes with a message and the agent reads it through the surface", async () => {
		const form = new FormData();
		form.set("file", new File([PNG], "pixel.png", { type: "image/png" }));
		const uploaded = await fetch("http://localhost/console/api/uploads", {
			method: "POST",
			body: form,
			headers: { "x-actor": "owner", origin: ORIGIN },
			unix: app.socket,
		} as never);
		expect(uploaded.status).toBe(200);
		const file = (await uploaded.json()) as { id: string; name: string };
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		// Someone else's id, an unknown one, or a file named twice is refused.
		tab.send({
			type: "send",
			id: "u0",
			room: SCOUT,
			text: "x",
			uploads: [crypto.randomUUID()],
		});
		expect((await tab.take(ofType("refused"))).code).toBe("unknown_upload");
		tab.send({
			type: "send",
			id: "u1",
			room: SCOUT,
			text: "look at this",
			uploads: [file.id],
		});
		const accepted = await tab.take(ofType("accepted"));
		expect(accepted.message.files).toMatchObject([
			{ id: file.id, name: "pixel.png" },
		]);
		await tab.take(agentReply("scout"));
		const turn = app.seen.find((r) => r.text.includes("look at this"));
		expect(turn?.attachments?.files.map((f) => f.name)).toEqual(["pixel.png"]);
		// The stored file is served as itself, an image inline, and never as a page.
		const served = await rest(app, `files/${file.id}`);
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toBe("image/png");
		expect(served.headers.get("content-security-policy")).toBe("sandbox");
		expect(served.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
		// Used once; a second message cannot name it.
		tab.send({
			type: "send",
			id: "u2",
			room: SCOUT,
			text: "again",
			uploads: [file.id],
		});
		expect((await tab.take(ofType("refused"))).code).toBe("unknown_upload");
		// A file that is not what its type says is not kept.
		const fake = new FormData();
		fake.set("file", new File(["not a png"], "x.png", { type: "image/png" }));
		const refused = await fetch("http://localhost/console/api/uploads", {
			method: "POST",
			body: fake,
			headers: { "x-actor": "owner", origin: ORIGIN },
			unix: app.socket,
		} as never);
		expect(refused.status).toBe(415);
		tab.close();
	});

	test("a reply's files are kept and served as downloads", async () => {
		app.scripts.set("make-file", async () => ({
			ok: true,
			text: "here you go",
			files: [
				{
					name: "page.html",
					data: new TextEncoder().encode("<script>1</script>"),
				},
			],
		}));
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "f1", room: SCOUT, text: "make-file" });
		const reply = await tab.take(agentReply("scout"));
		if (reply.type !== "message") throw new Error("expected a message");
		const [file] = reply.message.files;
		expect(file).toMatchObject({ name: "page.html" });
		const served = await rest(app, `files/${file?.id}`);
		expect(served.headers.get("content-disposition")).toContain("attachment");
		expect(served.headers.get("content-type")).toBe("application/octet-stream");
		expect(served.headers.get("content-security-policy")).toBe("sandbox");
		expect((await rest(app, "files/not-an-id")).status).toBe(404);
		tab.close();
	});

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
		const avatar = rooms.rooms[0]?.avatar;
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

	test("a picture cannot be redrawn on a host with no image provider", async () => {
		const redraw = await rest(app, "agents/scout/avatar", {
			method: "POST",
			body: JSON.stringify({ mode: "redraw" }),
		});
		expect(redraw.status).toBe(400);
		const bad = await rest(app, "agents/scout/avatar", {
			method: "POST",
			body: JSON.stringify({ mode: "scribble" }),
		});
		expect(bad.status).toBe(400);
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
		expect(older.more).toBe(false);
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
