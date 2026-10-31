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
	type PromptScope,
	type PromptWait,
	promptScope,
	SCHEDULES,
	THREADS,
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
// Not e-host's Sam: a suite that ran first may have linked that id to a principal of its own in the shared database.
const BOB_DISCORD = "300000000000000031";
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
	if (who === "owner2") return admitAs(BOB);
	return refuse("no proxy assertion");
}

const BOB: ActorFacts = {
	provider: "discord",
	subject: BOB_DISCORD,
	name: "Bob",
};

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
	uploadMaxBytes?: number;
	/** A team without Discord channels, whose agents live in the app's rooms. */
	local?: boolean;
	/** A second owner, so the agent rooms have two readers. */
	secondOwner?: boolean;
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
		...(options.local ? { discord: false as const } : {}),
		config: {
			dataDir,
			...(options.local
				? {}
				: {
						discord: {
							token: "token",
							guild: GUILD,
							entryChannel: ENTRY_CHANNEL,
						},
					}),
			http: { publicUrl: "https://bot.example.com", socketPath: socket },
			access: {
				owners: [
					{
						name: "Ada",
						principal: ADA_DISCORD,
						identities: [`discord:${ADA_DISCORD}`],
					},
					...(options.secondOwner
						? [
								{
									name: "Bob",
									principal: BOB_DISCORD,
									identities: [`discord:${BOB_DISCORD}`],
								},
							]
						: []),
				],
				members: { identities: [`discord:${MEL_DISCORD}`] },
			},
			agents: [
				{
					name: "guide",
					displayName: "Guide",
					prompt: "You guide.",
					avatarPrompt: "A guide",
					...(options.local ? {} : { channelId: ENTRY_CHANNEL }),
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
				...(options.uploadMaxBytes
					? { uploadMaxBytes: options.uploadMaxBytes }
					: {}),
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

/** Matches the `activity` frame of a room that has these fields. */
const activity = (room: string, over: object) => (frame: ServerFrame) =>
	frame.type === "activity" &&
	frame.room === room &&
	Object.entries(over).every(
		([key, value]) => (frame as Record<string, unknown>)[key] === value,
	);

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

	test("answered cards stay in the room's history after a reload, with who answered and what", async () => {
		const seenAnswers: unknown[] = [];
		app.scripts.set("keep-cards", async (request, signal) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			const approved = await prompts?.confirm(
				"Keep it?",
				"Keep the card",
				signal,
				"owner",
				undefined,
				{ action: "keep", tool: "note_send", input: { to: "team" } },
			);
			const answer = await prompts?.ask(
				"Which?",
				{
					question: "Which colour?",
					options: [{ label: "red" }, { label: "blue" }],
					multi: false,
					allowOther: true,
				},
				signal,
			);
			seenAnswers.push(approved, answer);
			return { ok: true, text: "cards kept" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "k1", room: SCOUT, text: "keep-cards" });
		const approval = await tab.take(ofType("prompt"));
		tab.send({
			type: "approval",
			prompt: approval.prompt.id,
			approved: true,
		});
		const approvalClosed = await tab.take(ofType("prompt_closed"));
		// The closing frame says who and when, as a page that was not watching will read it.
		expect(approvalClosed).toMatchObject({
			outcome: "approved",
			by: "Ada",
		});
		expect(Date.parse(approvalClosed.closedAt ?? "")).toBeGreaterThan(0);
		const question = await tab.take(ofType("prompt"));
		tab.send({
			type: "answer",
			prompt: question.prompt.id,
			answer: { choices: ["red"], text: "a dark one" },
		});
		await tab.take(ofType("prompt_closed"));
		await tab.take(agentReply("scout"));
		tab.close();

		// A new socket is shown nothing open, but the history holds both cards.
		const fresh = await Client.open(app, { "x-actor": "owner" });
		if (!fresh) throw new Error("the owner was refused");
		await fresh.take(ofType("ready"));
		expect(await fresh.sees(ofType("prompt"))).toBe(false);
		fresh.close();
		const page = (await (
			await rest(app, `rooms/${encodeURIComponent(SCOUT)}/messages`)
		).json()) as MessagesView;
		const mine = page.cards.filter((card) =>
			[approval.prompt.id, question.prompt.id].includes(card.frame.id),
		);
		expect(mine.map((card) => card.frame.id)).toEqual([
			approval.prompt.id,
			question.prompt.id,
		]);
		expect(mine[0]).toMatchObject({
			room: SCOUT,
			outcome: "approved",
			by: "Ada",
			frame: {
				kind: "approval",
				title: "Keep it?",
				approval: { tool: "note_send" },
			},
		});
		expect(mine[1]).toMatchObject({
			outcome: "answered",
			by: "Ada",
			answer: { kind: "ask", answer: { choices: ["red"], text: "a dark one" } },
			frame: { kind: "ask", question: "Which colour?" },
		});
		expect(Date.parse(mine[1]?.closedAt ?? "")).toBeGreaterThanOrEqual(
			Date.parse(mine[1]?.frame.at ?? ""),
		);
		// They stand where they opened: after the owner's message, before the agent's reply.
		// The database is shared by runs, so the newest of each is this run's.
		const owner = page.messages.findLast((m) => m.text === "keep-cards");
		const reply = page.messages.findLast((m) => m.text === "cards kept");
		expect(Date.parse(mine[0]?.frame.at ?? "")).toBeGreaterThanOrEqual(
			Date.parse(owner?.at ?? ""),
		);
		expect(Date.parse(mine[1]?.frame.at ?? "")).toBeLessThanOrEqual(
			Date.parse(reply?.at ?? ""),
		);
		// Another room's history holds neither.
		const guide = (await (
			await rest(app, `rooms/${encodeURIComponent(GUIDE)}/messages`)
		).json()) as MessagesView;
		expect(guide.cards.map((card) => card.frame.id)).not.toContain(
			approval.prompt.id,
		);
		// The history is the owner's; a member reads none of it.
		expect(
			(
				await rest(app, `rooms/${encodeURIComponent(SCOUT)}/messages`, {
					who: "member",
				})
			).status,
		).toBe(403);
		expect(seenAnswers).toEqual([
			"approved",
			{ choices: ["red"], text: "a dark one" },
		]);
	});

	test("a page of history holds the cards from its first message on, and the older page the rest", async () => {
		app.scripts.set("page-cards", async (request, signal) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			await prompts?.confirm("Page it?", "Page the card", signal);
			return { ok: true, text: "page done" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "pg1", room: GUIDE, text: "page-cards" });
		const card = await tab.take(ofType("prompt"));
		tab.send({ type: "approval", prompt: card.prompt.id, approved: false });
		await tab.take(ofType("prompt_closed"));
		await tab.take(agentReply("guide"));
		tab.close();
		const get = async (query: string) =>
			(await (
				await rest(app, `rooms/${encodeURIComponent(GUIDE)}/messages?${query}`)
			).json()) as MessagesView;
		const all = await get("limit=100");
		const reply = all.messages.at(-1);
		expect(reply?.text).toBe("page done");
		const start = all.messages.findLast((m) => m.text === "page-cards");
		// The latest page of one message: the agent's reply, after the card.
		const latest = await get("limit=1");
		expect(latest.more).toBe(true);
		expect(latest.cards.map((c) => c.frame.id)).not.toContain(card.prompt.id);
		// The page before the reply, which reaches back to the owner's message, holds the card.
		const older = await get(`limit=100&before=${reply?.id}`);
		// The host keeps every earlier run's messages, so this page may have older ones; it reaches back to the owner's own.
		expect(older.messages.some((m) => m.id === start?.id)).toBe(true);
		const found = older.cards.find((c) => c.frame.id === card.prompt.id);
		expect(found).toMatchObject({ outcome: "declined", by: "Ada" });
		// Page by page, every card is on exactly one page.
		const once: string[] = [];
		let before: number | undefined;
		for (;;) {
			const page = await get(`limit=1${before ? `&before=${before}` : ""}`);
			once.push(...page.cards.map((c) => c.frame.id));
			before = page.messages[0]?.id;
			// Down to this run's own first message; the database holds the earlier runs' too.
			if (!page.more || (before ?? 0) <= (start?.id ?? 0)) break;
		}
		expect(once.filter((id) => id === card.prompt.id)).toHaveLength(1);
		expect(new Set(once).size).toBe(once.length);
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

	test("an ordinary file of any kind goes with a message, and the agent turn gets it saved as it was", async () => {
		const upload = async (file: File) => {
			const form = new FormData();
			form.set("file", file);
			return fetch("http://localhost/console/api/uploads", {
				method: "POST",
				body: form,
				headers: { "x-actor": "owner", origin: ORIGIN },
				unix: app.socket,
			} as never);
		};
		const notes = "# Notes\n\n- one\n- \u4e8c\n";
		const text = await upload(new File([notes], "notes.md", { type: "" }));
		expect(text.status).toBe(200);
		const textView = (await text.json()) as { id: string; type: string };
		expect(textView.type).toBe("text/markdown");
		const zipBytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0xff, 0, 1]);
		const zip = await upload(
			new File([zipBytes], "bundle.zip", { type: "application/zip" }),
		);
		expect(zip.status).toBe(200);
		const zipView = (await zip.json()) as { id: string; type: string };
		expect(zipView.type).toBe("application/octet-stream");
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({
			type: "send",
			id: "t1",
			room: SCOUT,
			text: "read the notes",
			uploads: [textView.id, zipView.id],
		});
		await tab.take(ofType("accepted"));
		await tab.take(agentReply("scout"));
		const turn = app.seen.find((r) => r.text.includes("read the notes"));
		const files = turn?.attachments?.files ?? [];
		expect(files.map((f) => f.name)).toEqual(["notes.md", "bundle.zip"]);
		// The agent can open what the owner sent, byte for byte.
		expect(await Bun.file(files[0]?.path ?? "").text()).toBe(notes);
		expect(
			new Uint8Array(await Bun.file(files[1]?.path ?? "").arrayBuffer()),
		).toEqual(zipBytes);
		// Served back as downloads, never as pages.
		const served = await rest(app, `files/${textView.id}`);
		expect(served.headers.get("content-type")).toBe("application/octet-stream");
		expect(served.headers.get("content-disposition")).toContain("attachment");
		expect(await served.text()).toBe(notes);
		tab.close();
	});

	test("a file over the old limit of 10 MiB goes through, as a stream", async () => {
		const big = new Uint8Array(12 * 1024 * 1024).map((_, i) => (i * 13) % 253);
		big[0] = 0;
		const form = new FormData();
		form.set(
			"file",
			new File([big], "big.bin", { type: "application/octet-stream" }),
		);
		const uploaded = await fetch("http://localhost/console/api/uploads", {
			method: "POST",
			body: form,
			headers: { "x-actor": "owner", origin: ORIGIN },
			unix: app.socket,
		} as never);
		expect(uploaded.status).toBe(200);
		const view = (await uploaded.json()) as { id: string; size: number };
		expect(view.size).toBe(big.byteLength);
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		const ready = await tab.take(ofType("ready"));
		expect(ready.uploads.maxBytes).toBe(100 * 1024 * 1024);
		expect(ready.uploads).not.toHaveProperty("types");
		tab.send({
			type: "send",
			id: "b1",
			room: SCOUT,
			text: "big file",
			uploads: [view.id],
		});
		await tab.take(ofType("accepted"));
		const served = await rest(app, `files/${view.id}`);
		expect(served.headers.get("content-length")).toBe(String(big.byteLength));
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(big);
		tab.close();
	});

	test("a 30 MiB upload reaches the agent's turn as a file of its own, which its tools can open", async () => {
		const big = new Uint8Array(30 * 1024 * 1024).map((_, i) => (i * 7) % 251);
		big[0] = 0;
		const form = new FormData();
		form.set(
			"file",
			new File([big], "data.bin", { type: "application/octet-stream" }),
		);
		const uploaded = await fetch("http://localhost/console/api/uploads", {
			method: "POST",
			body: form,
			headers: { "x-actor": "owner", origin: ORIGIN },
			unix: app.socket,
		} as never);
		expect(uploaded.status).toBe(200);
		const view = (await uploaded.json()) as { id: string };
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({
			type: "send",
			id: "huge",
			room: SCOUT,
			text: "open the thirty",
			uploads: [view.id],
		});
		await tab.take(ofType("accepted"));
		await tab.take(agentReply("scout"));
		const turn = app.seen.find((r) => r.text.includes("open the thirty"));
		const files = turn?.attachments?.files ?? [];
		expect(files.map((f) => [f.name, f.size])).toEqual([
			["data.bin", big.byteLength],
		]);
		// Over 25 MiB the turn's text says it is kept for tools; the tool opens the very bytes.
		expect(turn?.text).not.toContain("larger than");
		expect(
			new Uint8Array(await Bun.file(files[0]?.path ?? "").arrayBuffer()),
		).toEqual(big);
		tab.close();
	});

	test("RV-F003: a waiting upload is deleted over REST by its owner, and a message cannot name it afterwards", async () => {
		const form = new FormData();
		form.set("file", new File(["scrap"], "scrap.txt", { type: "text/plain" }));
		const uploaded = await fetch("http://localhost/console/api/uploads", {
			method: "POST",
			body: form,
			headers: { "x-actor": "owner", origin: ORIGIN },
			unix: app.socket,
		} as never);
		const { id } = (await uploaded.json()) as { id: string };
		// Without the console's Origin, and for a member, nothing is deleted.
		expect(
			(await rest(app, `uploads/${id}`, { method: "DELETE", origin: null }))
				.status,
		).toBe(403);
		expect(
			(await rest(app, `uploads/${id}`, { method: "DELETE", who: "member" }))
				.status,
		).toBe(403);
		expect(
			(await rest(app, `uploads/${crypto.randomUUID()}`, { method: "DELETE" }))
				.status,
		).toBe(404);
		expect(
			(await rest(app, `uploads/${id}`, { method: "DELETE" })).status,
		).toBe(200);
		expect(
			(await rest(app, `uploads/${id}`, { method: "DELETE" })).status,
		).toBe(404);
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "d1", room: SCOUT, text: "x", uploads: [id] });
		expect((await tab.take(ofType("refused"))).code).toBe("unknown_upload");
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

describeDb("the owner app with a small upload limit", () => {
	let small: Booted;
	beforeAll(async () => {
		small = await boot({ auth: "verifier", uploadMaxBytes: 1024 * 1024 });
	});
	afterAll(async () => {
		await small.stop();
	});

	test("a file over the limit is refused with 413 and the page is told the limit", async () => {
		const send = (bytes: number) => {
			const data = new Uint8Array(bytes).fill(9);
			data[0] = 0;
			const form = new FormData();
			form.set("file", new File([data], "x.bin", { type: "application/zip" }));
			return fetch("http://localhost/console/api/uploads", {
				method: "POST",
				body: form,
				headers: { "x-actor": "owner", origin: ORIGIN },
				unix: small.socket,
			} as never);
		};
		const over = await send(2 * 1024 * 1024);
		expect(over.status).toBe(413);
		expect(((await over.json()) as { error: string }).error).toContain(
			"too large",
		);
		expect((await send(1024 * 1024)).status).toBe(200);
		const tab = await Client.open(small, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		expect((await tab.take(ofType("ready"))).uploads.maxBytes).toBe(
			1024 * 1024,
		);
		tab.close();
	});
});

const OWNER_SCOPE: PromptScope = {
	principalId: ADA_DISCORD,
	speakerId: `discord:${ADA_DISCORD}`,
	tier: "owner",
	escalate: "owners",
};

const isThreadKey = (key: string) => /^app:thread\.[0-9a-f-]{36}$/.test(key);

/** The messages of a room as the REST serves them. */
async function messagesOf(booted: Booted, room: string) {
	return (
		(await (
			await rest(booted, `rooms/${encodeURIComponent(room)}/messages`)
		).json()) as MessagesView
	).messages;
}

/** The room list as the REST serves it. */
async function roomList(booted: Booted) {
	return ((await (await rest(booted, "rooms")).json()) as RoomsView).rooms;
}

/** Waits until `check` returns a value, polling for up to `ms`. */
async function until<T>(
	check: () => Promise<T | undefined>,
	ms = 4000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = await check();
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error("the condition never held");
		await Bun.sleep(20);
	}
}

describeDb("dispatch threads of the app over a real host", () => {
	let app: Booted;
	beforeAll(async () => {
		app = await boot({ auth: "verifier", graceSeconds: 0.4 });
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});

	test("message_agent from a web room opens its exchange in a thread there, under each agent's name", async () => {
		app.scripts.set("ask-the-scout", async (request) => {
			// The team's `message_agent` entry is the host's own; the public type leaves it out.
			const team = app.host.context.services.get(AGENTS).team as unknown as {
				message(
					caller: { name: string; session: string; home: string },
					to: string,
					text: string,
				): string;
			};
			if (request.agent?.name === "guide")
				team.message(
					{ name: "guide", session: GUIDE, home: GUIDE },
					"scout",
					"check the disk",
				);
			return { ok: true, text: "asked" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "t1", room: GUIDE, text: "ask-the-scout" });
		// The start line lands in the sender's room, then is edited to link the thread.
		const start = await tab.take(
			(f): f is Extract<ServerFrame, { type: "message" }> =>
				f.type === "message" &&
				f.room === GUIDE &&
				f.message.kind === "system" &&
				f.message.text.startsWith("🧵"),
		);
		const linked = await tab.take(ofType("edited"));
		expect(linked.message.id).toBe(start.message.id);
		expect(linked.room).toBe(GUIDE);
		const key = /\]\((app:thread\.[0-9a-f-]{36})\)/.exec(
			linked.message.text,
		)?.[1];
		if (!key)
			throw new Error(`the start line links no thread: ${linked.message.text}`);
		await tab.take(ofType("changed"));
		// The request and the answer are in the thread, under each agent's name.
		const rows = await until(async () => {
			const found = await messagesOf(app, key);
			return found.length >= 2 ? found : undefined;
		});
		expect(rows.map((m) => [m.kind, m.agent, m.author])).toEqual([
			["agent", "guide", "Guide"],
			["agent", "scout", "Scout"],
		]);
		expect(rows[0]?.text).toContain("check the disk");
		expect(rows[1]?.text).toContain("check the disk");
		// Once the exchange ends the thread is closed, nested under its parent, and still readable.
		const closed = await until(async () =>
			(await roomList(app)).find((r) => r.key === key && r.closed),
		);
		expect(closed).toMatchObject({
			kind: "thread",
			parent: GUIDE,
			readOnly: true,
		});
		tab.close();
	});

	test("a thread takes no message from the page, has no modes, and cannot itself host a thread", async () => {
		const threads = app.host.context.services.get(THREADS);
		const thread = await threads.open(GUIDE, "Read only");
		if (!thread) throw new Error("the thread was not opened");
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "ro", room: thread.channel, text: "hi" });
		expect(await tab.take(ofType("refused"))).toMatchObject({
			id: "ro",
			code: "read_only",
		});
		const mode = await rest(
			app,
			`rooms/${encodeURIComponent(thread.channel)}/mode`,
			{ method: "PUT", body: JSON.stringify({ yolo: true }) },
		);
		expect(mode.status).toBe(404);
		expect(await threads.open(thread.channel, "Nested")).toBeUndefined();
		expect(await threads.open("app:agent.nobody", "Nowhere")).toBeUndefined();
		await thread.close();
		tab.close();
	});

	test("a card of a coding job in a thread reaches the owner there and is answered there", async () => {
		const threads = app.host.context.services.get(THREADS);
		const thread = await threads.open(GUIDE, "Coding #7", "📋 Task: tidy");
		if (!thread) throw new Error("the thread was not opened");
		expect(isThreadKey(thread.channel)).toBe(true);
		expect(thread.mention).toContain(thread.channel);
		const one = await Client.open(app, { "x-actor": "owner" });
		const two = await Client.open(app, { "x-actor": "owner" });
		if (!one || !two) throw new Error("the owner was refused");
		await one.take(ofType("ready"));
		const prompts = app.host.context.surfaces.prompts(
			thread.channel,
			OWNER_SCOPE,
		);
		const answer = prompts?.confirm(
			"Push it?",
			"Push the branch",
			undefined,
			"owner",
			undefined,
			{ action: "git push", tool: "bash", input: { command: "git push" } },
		);
		const shown = await one.take(ofType("prompt"));
		expect(shown.room).toBe(thread.channel);
		expect((await two.take(ofType("prompt"))).prompt.id).toBe(shown.prompt.id);
		// The card is answered from the thread's room, which is read only for messages.
		two.send({ type: "approval", prompt: shown.prompt.id, approved: true });
		expect(await one.take(ofType("prompt_closed"))).toMatchObject({
			prompt: shown.prompt.id,
			outcome: "approved",
		});
		expect(await answer).toBe("approved");
		// The task intro and the report are in the thread, then it closes.
		await thread.close("✅ Done");
		const rows = await messagesOf(app, thread.channel);
		expect(rows.map((m) => m.text)).toEqual(["📋 Task: tidy", "✅ Done"]);
		expect(
			(await roomList(app)).find((r) => r.key === thread.channel),
		).toMatchObject({ closed: true, parent: GUIDE });
		one.close();
		two.close();
	});
});

describeDb("dispatch threads left open by a host that stopped", () => {
	test("the next start closes them with a restart notice, and the thread stays readable", async () => {
		const first = await boot({ auth: "verifier" });
		const { dataDir } = first;
		const thread = await first.host.context.services
			.get(THREADS)
			.open(GUIDE, "Left open", "📋 Task: long job");
		if (!thread) throw new Error("the thread was not opened");
		expect(
			(await roomList(first)).find((r) => r.key === thread.channel)?.closed,
		).toBeUndefined();
		await first.stop();
		const second = await boot({ auth: "verifier", dataDir });
		try {
			const closed = await until(async () =>
				(await roomList(second)).find(
					(r) => r.key === thread.channel && r.closed,
				),
			);
			expect(closed.parent).toBe(GUIDE);
			const rows = await messagesOf(second, thread.channel);
			expect(rows.map((m) => m.kind)).toEqual(["agent", "system"]);
			expect(rows[1]?.text).toContain("restarted before this job finished");
			expect(rows[1]?.text.startsWith("-#")).toBe(false);
		} finally {
			await second.stop();
		}
	}, 30_000);
});

describeDb("characters and presence over a real host", () => {
	let app: Booted;
	beforeAll(async () => {
		app = await boot({ auth: "verifier", graceSeconds: 0.4 });
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});

	const open = async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		return tab;
	};
	const put = (who: string, body: unknown, origin: string | null = ORIGIN) =>
		rest(app, "agents/guide/character", {
			method: "PUT",
			who,
			origin,
			body: JSON.stringify(body),
		});

	test("the room list gives an agent room its character", async () => {
		const rooms = await roomList(app);
		const room = rooms.find((r) => r.key === GUIDE);
		expect(room?.character?.class).toBeString();
		expect(room?.character?.v).toBe(1);
		const profile = (await (await rest(app, "agents/guide")).json()) as {
			character: { class: string };
		};
		expect(profile.character.class).toBe(room?.character?.class as string);
	});

	test("PUT character dresses the agent, shows a changed frame, and refuses what it must", async () => {
		const tab = await open();
		const ok = await put("owner", { character: { palette: "teal" } });
		expect(ok.status).toBe(200);
		const profile = (await ok.json()) as {
			character: { palette?: string; colors: { primary: string } };
		};
		expect(profile.character.palette).toBe("teal");
		await tab.take(ofType("changed"));
		const room = (await roomList(app)).find((r) => r.key === GUIDE);
		expect(room?.character?.palette).toBe("teal");
		const bad = await put("owner", { character: { hat: "no-such-hat" } });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ field: "hat" });
		expect((await put("owner", { character: [] })).status).toBe(400);
		expect((await put("owner", { palette: "teal" })).status).toBe(400);
		expect(
			(await put("owner", { character: {} }, "https://evil.test")).status,
		).toBe(403);
		expect((await put("owner", { character: {} }, null)).status).toBe(403);
		// The verifier's refusal is a 403, as for every route of the app.
		expect(
			(await put("nobody", { character: { palette: "rose" } })).status,
		).toBe(403);
		expect(
			(await put("member", { character: { palette: "rose" } })).status,
		).toBe(403);
		const big = await put("owner", {
			character: { palette: "rose" },
			pad: "x".repeat(5000),
		});
		expect(big.status).toBe(413);
		expect(
			(
				await rest(app, "agents/nobody/character", {
					method: "PUT",
					body: JSON.stringify({ character: { palette: "rose" } }),
				})
			).status,
		).toBe(404);
		const still = (await (await rest(app, "agents/guide")).json()) as {
			character: { palette?: string };
		};
		expect(still.character.palette).toBe("teal");
		tab.close();
	});

	test("a turn that calls a tool is working, then thinking, and ends done", async () => {
		app.scripts.set("use-a-tool", async (request) => {
			request.progress?.({ type: "tool_start", id: "u1", tool: "bash" });
			await Bun.sleep(30);
			request.progress?.({
				type: "tool_end",
				id: "u1",
				tool: "bash",
				ok: true,
			});
			await Bun.sleep(30);
			return { ok: true, text: "used it" };
		});
		const tab = await open();
		tab.send({ type: "send", id: "w1", room: SCOUT, text: "use-a-tool" });
		const first = await tab.take(activity(SCOUT, { typing: true }));
		expect(first).toMatchObject({ phase: "thinking" });
		await tab.take(activity(SCOUT, { typing: true, phase: "working" }));
		await tab.take(activity(SCOUT, { typing: true, phase: "thinking" }));
		const last = await tab.take(activity(SCOUT, { typing: false }));
		expect(last).toMatchObject({ outcome: "done" });
		expect(last).not.toHaveProperty("phase");
		tab.close();
	});

	test("a turn that throws ends failed", async () => {
		app.scripts.set("fall-over", async () => {
			throw new Error("the model fell over");
		});
		const tab = await open();
		tab.send({ type: "send", id: "f1", room: SCOUT, text: "fall-over" });
		const last = await tab.take(activity(SCOUT, { typing: false }));
		expect(last).toMatchObject({ outcome: "failed" });
		const rows = await messagesOf(app, SCOUT);
		expect(rows.at(-1)?.text).toContain("did not go through");
		tab.close();
	});

	test("presence follows an agent working in a Discord channel", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		app.scripts.set("discord-work", async () => {
			await held;
			return { ok: true, text: "done over there" };
		});
		const tab = await open();
		const table = (frame: ServerFrame) =>
			frame.type === "presence" ? frame.agents : undefined;
		const first = await tab.take(ofType("presence"));
		expect(first.agents.guide?.busy).toBe(false);
		const handled = app.host.conversations.handle({
			channel: `discord:${ENTRY_CHANNEL}`,
			messageId: "d1",
			actor: ADA,
			authorId: ADA_DISCORD,
			authorName: "Ada",
			authorIsBot: false,
			space: GUILD,
			isDirect: false,
			mentionsBot: true,
			repliesToBot: false,
			text: "discord-work",
			attachments: [],
		});
		await tab.take((frame) => table(frame)?.guide?.busy === true, 6000);
		release();
		await handled;
		await tab.take((frame) => table(frame)?.guide?.busy === false, 6000);
		tab.close();
	});
});

describeDb("a group round of the app over a team without Discord", () => {
	let local: Booted;
	beforeAll(async () => {
		local = await boot({ auth: "verifier", local: true });
	}, 30_000);
	afterAll(async () => {
		await local.stop();
	});

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

describeDb("internal notes in rooms two owners read", () => {
	let two: Booted;
	beforeAll(async () => {
		two = await boot({ auth: "verifier", secondOwner: true });
	}, 30_000);
	afterAll(async () => {
		await two.stop();
	});

	test("the room list says which rooms take notes, threads not among them", async () => {
		const threads = two.host.context.services.get(THREADS);
		const thread = await threads.open(GUIDE, "Notes thread");
		if (!thread) throw new Error("the thread was not opened");
		const rooms = (await (await rest(two, "rooms")).json()) as RoomsView;
		const shown = rooms.rooms.filter((room) => room.kind !== "thread");
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.every((room) => room.notes === true)).toBe(true);
		const found = rooms.rooms.find((room) => room.key === thread.channel);
		expect(found).toBeDefined();
		expect(found).not.toHaveProperty("notes");
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({
			type: "send",
			id: "t1",
			room: thread.channel,
			text: "a note in a thread",
			mode: "note",
		});
		expect((await tab.take(ofType("refused"))).code).toBe("read_only");
		tab.close();
		await thread.close();
	});

	test("a note is shown to the other owner and kept, and the agent hears nothing of it", async () => {
		const ada = await Client.open(two, { "x-actor": "owner" });
		const bob = await Client.open(two, { "x-actor": "owner2" });
		if (!ada || !bob) throw new Error("an owner was refused");
		await ada.take(ofType("ready"));
		await bob.take(ofType("ready"));
		const before = two.seen.length;
		ada.send({
			type: "send",
			id: "n1",
			room: GUIDE,
			text: "note-for-bob-7731",
			mode: "note",
		});
		const accepted = await ada.take(ofType("accepted"));
		expect(accepted).toMatchObject({
			id: "n1",
			room: GUIDE,
			message: {
				kind: "owner",
				author: "Ada",
				principalId: ADA_DISCORD,
				text: "note-for-bob-7731",
				note: true,
			},
		});
		const shown = await bob.take(
			(frame): frame is Extract<ServerFrame, { type: "message" }> =>
				frame.type === "message" && frame.message.text === "note-for-bob-7731",
		);
		expect(shown.message).toMatchObject({
			id: accepted.message.id,
			kind: "owner",
			author: "Ada",
			note: true,
		});
		// No turn: nothing reached the runtime, nothing is typing, and nobody answers.
		expect(
			await bob.sees((frame) => frame.type === "activity" && frame.typing),
		).toBe(false);
		expect(two.seen.length).toBe(before);
		// The history of both owners holds it, marked.
		for (const who of ["owner", "owner2"]) {
			const history = (await (
				await rest(two, `rooms/${encodeURIComponent(GUIDE)}/messages`, { who })
			).json()) as MessagesView;
			expect(
				history.messages.find((m) => m.id === accepted.message.id),
			).toMatchObject({
				text: "note-for-bob-7731",
				note: true,
				author: "Ada",
			});
		}
		// A turn asked after it carries nothing of the note, and the turn's own message is no note.
		bob.send({
			type: "send",
			id: "q1",
			room: GUIDE,
			text: "ask-after-the-note",
		});
		const asked = await bob.take(ofType("accepted"));
		expect(asked.message).not.toHaveProperty("note");
		await bob.take(agentReply("guide"));
		const turn = two.seen.find((r) => r.text.includes("ask-after-the-note"));
		expect(turn).toBeDefined();
		expect(JSON.stringify(turn)).not.toContain("note-for-bob-7731");
		// The newest message of the room is the agent's reply; the note is below it, still marked.
		const noteOnly = (await (
			await rest(two, `rooms/${encodeURIComponent(GUIDE)}/messages`)
		).json()) as MessagesView;
		expect(
			noteOnly.messages.filter((m) => m.note).map((m) => m.text),
		).toContain("note-for-bob-7731");
		expect(
			noteOnly.messages.filter((m) => !m.note && m.kind === "agent").at(-1)
				?.text,
		).toBe("echo ask-after-the-note");
		ada.close();
		bob.close();
	});

	test("each owner's message carries its author's principal, live and in the history, so a page tells whose it is", async () => {
		const ada = await Client.open(two, { "x-actor": "owner" });
		const bob = await Client.open(two, { "x-actor": "owner2" });
		if (!ada || !bob) throw new Error("an owner was refused");
		await ada.take(ofType("ready"));
		await bob.take(ofType("ready"));
		// The log is the database's, so the texts are this run's own.
		const tag = `-${crypto.randomUUID().slice(0, 8)}`;
		ada.send({ type: "send", id: "w1", room: GUIDE, text: `from-ada${tag}` });
		const fromAda = await ada.take(ofType("accepted"));
		expect(fromAda.message).toMatchObject({
			kind: "owner",
			author: "Ada",
			principalId: ADA_DISCORD,
		});
		const shownToBob = await bob.take(
			(frame): frame is Extract<ServerFrame, { type: "message" }> =>
				frame.type === "message" && frame.message.text === `from-ada${tag}`,
		);
		expect(shownToBob.message).toMatchObject({
			kind: "owner",
			author: "Ada",
			principalId: ADA_DISCORD,
		});
		await ada.take(agentReply("guide"));
		bob.send({ type: "send", id: "w2", room: GUIDE, text: `from-bob${tag}` });
		const fromBob = await bob.take(ofType("accepted"));
		expect(fromBob.message).toMatchObject({
			kind: "owner",
			author: "Bob",
			principalId: BOB_DISCORD,
		});
		await bob.take(agentReply("guide"));
		for (const who of ["owner", "owner2"]) {
			const history = (await (
				await rest(two, `rooms/${encodeURIComponent(GUIDE)}/messages`, { who })
			).json()) as MessagesView;
			const owners = history.messages.filter(
				(m) => m.kind === "owner" && m.text.endsWith(tag),
			);
			expect(owners.map((m) => [m.author, m.principalId])).toEqual([
				["Ada", ADA_DISCORD],
				["Bob", BOB_DISCORD],
			]);
		}
		ada.close();
		bob.close();
	});

	test("the server never reads a message's text for @AI: a note frame whose text starts with it stays a note and the agent hears nothing", async () => {
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		const before = two.seen.length;
		for (const [id, text] of [
			["a1", "@AI mention-note-6612"],
			["a2", "forwarded: hey @AI, mention-note-6613"],
		] as const) {
			tab.send({ type: "send", id, room: SCOUT, text, mode: "note" });
			const kept = await tab.take(ofType("accepted"));
			expect(kept.message).toMatchObject({ text, note: true });
		}
		expect(
			await tab.sees((frame) => frame.type === "activity" && frame.typing),
		).toBe(false);
		expect(two.seen.length).toBe(before);
		tab.close();
	});

	test("a turn without a mode is still a turn, and a note needs words or files", async () => {
		const tab = await Client.open(two, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({ type: "send", id: "p1", room: SCOUT, text: "plain-turn-5521" });
		await tab.take(agentReply("scout"));
		expect(two.seen.some((r) => r.text === "plain-turn-5521")).toBe(true);
		tab.send({
			type: "send",
			id: "e1",
			room: SCOUT,
			text: "   ",
			mode: "note",
		});
		expect(await tab.take(ofType("refused"))).toMatchObject({
			id: "e1",
			code: "empty",
		});
		tab.send({
			type: "send",
			id: "u1",
			room: SCOUT,
			text: "with a file that is not theirs",
			uploads: ["nope"],
			mode: "note",
		});
		expect((await tab.take(ofType("refused"))).code).toBe("unknown_upload");
		tab.close();
	});
});
