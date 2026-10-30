import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ActorFacts,
	CHANNEL_CONTEXT,
	type ChannelKey,
	definePlugin,
	IDENTITY,
	type InboundMessage,
	promptScope,
	type Speaker,
	type TurnRequest,
	type TurnResult,
} from "pi-roundtable";
import { describeDb, type TestHost, testHost } from "pi-roundtable/testing";
import type { HostCardView, RoomMessage, ServerFrame } from "../api-types.ts";
import { APP_PROTOCOL } from "../app/protocol.ts";
import { admitAs, refuse, type Verdict } from "../verifier.ts";
import {
	type ActionResult,
	type HostRoomKind,
	type RoomAccess,
	type Viewer,
	WEB_APP,
	type WebApp,
} from "../web-app.ts";
import { webConsole } from "../web-plugin.ts";
import type {
	HostActionResult,
	HostListView,
	HostMessagesView,
	HostPageView,
	HostRoomView,
} from "./views.ts";

const ORIGIN = "https://app.example.test";
const FACTS = {
	ada: { provider: "discord", subject: "100000000000000011", name: "Ada" },
	mel: {
		provider: "discord",
		subject: "200000000000000012",
		name: "Mel",
		roles: ["web:role:pm"],
	},
	kim: { provider: "discord", subject: "300000000000000013", name: "Kim" },
	zed: { provider: "discord", subject: "400000000000000014", name: "Zed" },
} satisfies Record<string, ActorFacts>;
type Who = keyof typeof FACTS;

/** The sockets' verifier: the header `x-actor` names who the proxy vouches for. */
function verifier(request: Request): Verdict {
	const who = request.headers.get("x-actor") as Who | null;
	return who && FACTS[who] ? admitAs(FACTS[who]) : refuse("no proxy assertion");
}

/** Room ids of this run, so the rooms the shared database keeps from earlier runs are not these. */
const RUN = Math.random().toString(36).slice(2, 8);
const ROOM_A_ID = `a${RUN}room`;
const ROOM_B_ID = `b${RUN}room`;
/** The agent of this run: its room, and every person's cursor in it, starts clean in the shared database. */
const GUIDE = `guide${RUN}`;
const AGENT_ROOM = `app:agent.${GUIDE}` as ChannelKey;
const ROOM_A = `app:inbox.${ROOM_A_ID}` as ChannelKey;
const ROOM_B = `app:inbox.${ROOM_B_ID}` as ChannelKey;

const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
]);

/** What the fixture "support inbox" host remembers of what the app asked it. */
interface Inbox {
	/** Who reads which room, and what they may do there. */
	grants: Map<string, Map<string, RoomAccess>>;
	admitted: InboundMessage[];
	sends: { who: string; id: string; mode: string; text: string }[];
	acts: {
		who: string;
		id: string;
		action: string;
		card?: string;
		input: object;
	}[];
	pageActs: { who: string; action: string; input: object }[];
	/** What the claim does with a turn it was given. */
	script:
		| ((message: InboundMessage, speaker: Speaker | undefined) => Promise<void>)
		| undefined;
	/** Refuses the next send. */
	refuse: string | undefined;
	/** When set, `access` answers only for viewers who carry this role. */
	needRole: string | undefined;
	web: WebApp | undefined;
}

const READ_WRITE: RoomAccess = {
	read: true,
	send: ["note", "turn"],
	act: true,
};

function inbox(): Inbox {
	return {
		grants: new Map(),
		admitted: [],
		sends: [],
		acts: [],
		pageActs: [],
		script: undefined,
		refuse: undefined,
		needRole: undefined,
		web: undefined,
	};
}

function inboxPlugin(state: Inbox) {
	return definePlugin({
		name: "inbox-host",
		requires: [WEB_APP, IDENTITY],
		setup: (context) => {
			const web = context.services.get(WEB_APP);
			state.web = web;
			const principals = new Map<string, string>();
			const nameOf = (viewer: Viewer) => viewer.name.toLowerCase();
			const kind: HostRoomKind = {
				kind: "inbox",
				label: "Inbox",
				icon: "chat",
				list: async (viewer) => {
					const mine = state.grants.get(viewer.principalId);
					if (!mine) return undefined;
					return {
						rooms: [...mine.keys()].map((id) => ({
							id,
							title: `Thread ${id}`,
							subtitle: "Support",
							picture: { initials: "TH", color: "#336699" },
							unread: 99,
						})),
					};
				},
				access: async (viewer, id) =>
					state.needRole && !viewer.roles.includes(state.needRole)
						? undefined
						: state.grants.get(viewer.principalId)?.get(id),
				header: async (_viewer, id) => ({
					title: `Thread ${id}`,
					fields: [{ label: "Status", value: "Open" }],
					actions: [
						{
							id: "assign",
							label: "Assign",
							form: {
								title: "Assign",
								submit: "Assign",
								fields: [
									{
										name: "owner",
										label: "Owner",
										type: "select",
										required: true,
										options: [
											{ value: "ada", label: "Ada" },
											{ value: "mel", label: "Mel" },
										],
									},
								],
							},
						},
					],
					banner: { tone: "warn", text: "Nobody owns this thread" },
				}),
				send: async (viewer, id, message) => {
					state.sends.push({
						who: nameOf(viewer),
						id,
						mode: message.mode,
						text: message.text,
					});
					if (state.refuse) return { refused: state.refuse };
					return "accepted";
				},
				act: async (viewer, id, action, input): Promise<ActionResult> => {
					state.acts.push({
						who: nameOf(viewer),
						id,
						action: action.action,
						...(action.card ? { card: action.card } : {}),
						input,
					});
					return {
						ok: true,
						notice: "Done",
						open: { room: ROOM_B, message: 7 },
					};
				},
				buttons: (viewer, _id, card) =>
					nameOf(viewer) === "mel"
						? (card.buttons ?? [])
								.filter((button) => button.id === "reply")
								.map((b) => b.id)
						: (card.buttons ?? []).map((button) => button.id),
			};
			web.registerRoomKind(kind);
			web.registerPage({
				id: "mailboxes",
				label: "Mailboxes",
				icon: "megaphone",
				place: "main",
				visible: (viewer) => viewer.tier === "owner",
				view: async (_viewer, query) => ({
					title: "Mailboxes",
					sections: [
						{ kind: "markdown", text: `filter: ${query.q ?? ""}` },
						{
							kind: "form",
							action: "connect",
							form: {
								title: "Connect",
								submit: "Connect",
								fields: [
									{
										name: "address",
										label: "Address",
										type: "text",
										required: true,
									},
								],
							},
						},
					],
				}),
				act: async (viewer, action, input) => {
					state.pageActs.push({ who: nameOf(viewer), action, input });
					return { ok: true, notice: "Connected" };
				},
			});
			void principals;
			return {
				channels: [
					{
						name: "inbox",
						priority: 10,
						owns: (channel: ChannelKey) => channel.startsWith("app:inbox."),
						admit: (message: InboundMessage) => {
							state.admitted.push(message);
							return {
								kind: "turn" as const,
								run: async () => state.script?.(message, message.speaker),
								failure: "an inbox turn failed",
							};
						},
						startFresh: async () => "inbox",
					},
				],
			};
		},
	});
}

interface Booted {
	host: TestHost;
	socket: string;
	dataDir: string;
	state: Inbox;
	principals: Record<Who, string>;
	stop(): Promise<void>;
}

async function boot(): Promise<Booted> {
	const dataDir = mkdtempSync(join(tmpdir(), "host-app-"));
	const socket = join(dataDir, "public.sock");
	const assets = mkdtempSync(join(tmpdir(), "host-app-page-"));
	writeFileSync(join(assets, "index.html"), "<html>app</html>");
	const state = inbox();
	const runtime = {
		runTurn: async (request: TurnRequest): Promise<TurnResult> => ({
			ok: true,
			text: `echo ${request.text}`,
		}),
		steer: async () => false,
		stop: () => false,
		startFresh: async () => undefined,
		deleteConversation: async () => undefined,
		pendingConfirmation: () => undefined,
		heldActions: async () => undefined,
		recentTranscript: async () => [],
	};
	const host = await testHost({
		discord: false as const,
		config: {
			dataDir,
			http: { publicUrl: "https://bot.example.com", socketPath: socket },
			access: {
				owners: [
					{
						name: "Ada",
						principal: FACTS.ada.subject,
						identities: [`discord:${FACTS.ada.subject}`],
					},
				],
				members: {
					identities: [FACTS.mel, FACTS.kim, FACTS.zed].map(
						(facts) => `discord:${facts.subject}`,
					),
				},
			},
			agents: [
				{
					name: GUIDE,
					displayName: "Guide",
					prompt: "You guide.",
					avatarPrompt: "A guide",
				},
			],
		},
		runtime,
		plugins: [
			webConsole({
				verifier,
				admission: "access",
				origin: ORIGIN,
				dataDir,
				assetDir: assets,
				cardGraceSeconds: 120,
				panes: ["rooms"],
			}),
			inboxPlugin(state),
		],
	});
	const identity = host.context.services.get(IDENTITY);
	const principals = {} as Record<Who, string>;
	for (const who of Object.keys(FACTS) as Who[]) {
		const speaker = await identity.resolve(FACTS[who] as ActorFacts);
		if (!speaker) throw new Error(`${who} resolves to no one`);
		principals[who] = speaker.principalId;
	}
	return {
		host,
		socket,
		dataDir,
		state,
		principals,
		stop: () => host.stop(),
	};
}

/** One app WebSocket and the frames it received. */
class Client {
	readonly frames: ServerFrame[] = [];
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

	static async open(boot: Booted, who: Who): Promise<Client> {
		const ws = new WebSocket(`ws+unix://${boot.socket}:/console/api/socket`, {
			protocols: [APP_PROTOCOL],
			headers: { origin: ORIGIN, "x-actor": who },
		} as never);
		const opened = await new Promise<boolean>((resolve) => {
			ws.onopen = () => resolve(true);
			ws.onerror = () => resolve(false);
			ws.onclose = () => resolve(false);
		});
		if (!opened) throw new Error(`${who} was refused`);
		const client = new Client(ws);
		await client.take((frame) => frame.type === "ready");
		return client;
	}

	send(frame: object): void {
		this.#ws.send(JSON.stringify(frame));
	}

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

	/** Whether a matching frame shows up within `ms` (it is not taken). */
	async sees(
		match: (frame: ServerFrame) => boolean,
		ms = 250,
	): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (this.frames.some((f, index) => index >= this.#cursor && match(f)))
				return true;
			await Bun.sleep(10);
		}
		return false;
	}

	/** Passes over everything received so far. */
	skip(): void {
		this.#cursor = this.frames.length;
	}

	close(): void {
		this.#ws.close();
	}
}

const ofType =
	<K extends ServerFrame["type"]>(type: K) =>
	(frame: ServerFrame): frame is Extract<ServerFrame, { type: K }> =>
		frame.type === type;

function rest(
	boot: Booted,
	path: string,
	init: RequestInit & { who?: Who } = {},
): Promise<Response> {
	const { who = "ada", ...more } = init;
	return fetch(`http://localhost/console/api/${path}`, {
		...more,
		headers: {
			"x-actor": who,
			origin: ORIGIN,
			...(typeof more.body === "string"
				? { "content-type": "application/json" }
				: {}),
			...(more.headers as Record<string, string> | undefined),
		},
		unix: boot.socket,
	} as never);
}

const post = (boot: Booted, path: string, body: object, who: Who) =>
	rest(boot, path, { method: "POST", body: JSON.stringify(body), who });

describeDb("the host rooms over a real host", () => {
	let app: Booted;
	let web: WebApp;
	beforeAll(async () => {
		app = await boot();
		web = app.state.web as WebApp;
		const { principals, state } = app;
		state.grants.set(
			principals.ada,
			new Map([
				[ROOM_A_ID, READ_WRITE],
				[ROOM_B_ID, READ_WRITE],
			]),
		);
		state.grants.set(principals.mel, new Map([[ROOM_A_ID, READ_WRITE]]));
		state.grants.set(
			principals.kim,
			new Map([[ROOM_A_ID, { read: true, send: ["note"], act: false }]]),
		);
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});

	const external = (text: string, over: object = {}) => ({
		author: { kind: "external" as const, label: "Customer", name: "Pat" },
		text,
		...over,
	});

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
			author: { kind: "assistant", name: "Assistant" },
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

	test("a button is pressed only if the card offers it to that viewer, its form is checked first, and the host's answer comes back", async () => {
		const card = await web.rooms.card(ROOM_A, {
			title: "Act",
			body: "b",
			buttons: [
				{ id: "reply", label: "Reply" },
				{
					id: "escalate",
					label: "Escalate",
					form: {
						title: "Escalate",
						submit: "Go",
						fields: [
							{
								name: "who",
								label: "Who",
								type: "select",
								required: true,
								options: [{ value: "ada", label: "Ada" }],
							},
							{ name: "why", label: "Why", type: "text", max: 5 },
						],
					},
				},
			],
		});
		app.state.acts.length = 0;
		// Mel is offered "reply" only.
		const refused = await post(
			app,
			`host/inbox/${ROOM_A_ID}/act`,
			{ action: "escalate", card: card.id },
			"mel",
		);
		expect(refused.status).toBe(403);
		// Kim reads but may not act.
		expect(
			(
				await post(
					app,
					`host/inbox/${ROOM_A_ID}/act`,
					{ action: "reply", card: card.id },
					"kim",
				)
			).status,
		).toBe(403);
		expect(
			(
				await post(
					app,
					`host/inbox/${ROOM_A_ID}/act`,
					{ action: "reply", card: "no-such-card" },
					"mel",
				)
			).status,
		).toBe(404);
		expect(app.state.acts).toEqual([]);
		const ok = (await (
			await post(
				app,
				`host/inbox/${ROOM_A_ID}/act`,
				{ action: "reply", card: card.id },
				"mel",
			)
		).json()) as HostActionResult;
		expect(ok).toEqual({
			ok: true,
			notice: "Done",
			open: { room: ROOM_B, message: 7 },
		});
		expect(app.state.acts).toEqual([
			{ who: "mel", id: ROOM_A_ID, action: "reply", card: card.id, input: {} },
		]);
		// A form: a missing required field and a value outside the options never reach the host.
		const missing = (await (
			await post(
				app,
				`host/inbox/${ROOM_A_ID}/act`,
				{ action: "escalate", card: card.id, input: {} },
				"ada",
			)
		).json()) as HostActionResult;
		expect(missing).toMatchObject({ ok: false, field: "who" });
		const outside = (await (
			await post(
				app,
				`host/inbox/${ROOM_A_ID}/act`,
				{ action: "escalate", card: card.id, input: { who: "zed" } },
				"ada",
			)
		).json()) as HostActionResult;
		expect(outside).toMatchObject({ ok: false, field: "who" });
		const long = (await (
			await post(
				app,
				`host/inbox/${ROOM_A_ID}/act`,
				{
					action: "escalate",
					card: card.id,
					input: { who: "ada", why: "too long a reason" },
				},
				"ada",
			)
		).json()) as HostActionResult;
		expect(long).toMatchObject({ ok: false, field: "why" });
		expect(app.state.acts).toHaveLength(1);
		const done = (await (
			await post(
				app,
				`host/inbox/${ROOM_A_ID}/act`,
				{ action: "escalate", card: card.id, input: { who: "ada", why: "ok" } },
				"ada",
			)
		).json()) as HostActionResult;
		expect(done.ok).toBe(true);
		expect(app.state.acts.at(-1)).toMatchObject({
			action: "escalate",
			input: { who: "ada", why: "ok" },
		});
		// A header action runs without a card; one the header does not list does not run.
		expect(
			(
				await post(
					app,
					`host/inbox/${ROOM_A_ID}/act`,
					{ action: "assign", input: { owner: "mel" } },
					"ada",
				)
			).status,
		).toBe(200);
		expect(
			(
				await post(
					app,
					`host/inbox/${ROOM_A_ID}/act`,
					{ action: "delete-everything" },
					"ada",
				)
			).status,
		).toBe(403);
		// The same press over the socket answers by refusing only when it is not taken.
		const socket = await Client.open(app, "ada");
		socket.send({
			type: "act",
			id: "act-1",
			room: ROOM_A,
			action: "delete-everything",
		});
		expect(await socket.take(ofType("refused"))).toMatchObject({
			id: "act-1",
			code: "forbidden",
		});
		socket.close();
	});

	test("a note is stored and shown and reaches no claim; a turn also reaches the claim with who sent it, as facts the router never lowers a tier from", async () => {
		const mel = await Client.open(app, "mel");
		const kim = await Client.open(app, "kim");
		for (const client of [mel, kim])
			client.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		app.state.admitted.length = 0;
		app.state.sends.length = 0;
		mel.send({
			type: "send",
			id: "n1",
			room: ROOM_A,
			text: "internal note",
			mode: "note",
		});
		const accepted = await mel.take(ofType("accepted"));
		expect(accepted.message).toMatchObject({
			room: ROOM_A,
			text: "internal note",
			authorKind: "member",
			principalId: app.principals.mel,
		});
		expect((await kim.take(ofType("host_message"))).message.text).toBe(
			"internal note",
		);
		expect(app.state.admitted).toEqual([]);
		expect(app.state.sends).toEqual([
			{ who: "mel", id: ROOM_A_ID, mode: "note", text: "internal note" },
		]);
		mel.send({
			type: "send",
			id: "t1",
			room: ROOM_A,
			text: "ask the assistant",
		});
		await mel.take(
			(frame): frame is Extract<ServerFrame, { type: "accepted" }> =>
				frame.type === "accepted",
		);
		await Bun.sleep(100);
		expect(app.state.admitted).toHaveLength(1);
		const turn = app.state.admitted[0] as InboundMessage;
		expect(turn).toMatchObject({
			channel: ROOM_A,
			text: "ask the assistant",
			speaker: { principalId: app.principals.mel, tier: "member" },
			actor: { surface: "app", partial: true, subject: FACTS.mel.subject },
		});
		// Kim may only send notes here.
		kim.send({
			type: "send",
			id: "k1",
			room: ROOM_A,
			text: "i want to ask",
			mode: "turn",
		});
		expect(await kim.take(ofType("refused"))).toMatchObject({
			id: "k1",
			code: "forbidden",
		});
		kim.send({ type: "send", id: "k2", room: ROOM_A, text: "   " });
		expect(await kim.take(ofType("refused"))).toMatchObject({
			id: "k2",
			code: "forbidden",
		});
		// The kind may refuse a message; nothing is stored then.
		app.state.refuse = "closed";
		mel.send({
			type: "send",
			id: "r1",
			room: ROOM_A,
			text: "will be refused",
			mode: "note",
		});
		expect(await mel.take(ofType("refused"))).toMatchObject({
			id: "r1",
			code: "not_accepted",
		});
		app.state.refuse = undefined;
		const stored = (await (
			await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "ada" })
		).json()) as HostRoomView;
		expect(stored.messages.some((m) => m.text === "will be refused")).toBe(
			false,
		);
		mel.close();
		kim.close();
	});

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

	test("cutting off a reader: after accessChanged the next frame is not delivered, and the room is gone for them", async () => {
		const kim = await Client.open(app, "kim");
		kim.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		await web.rooms.post(ROOM_A, external("before the cut"));
		expect((await kim.take(ofType("host_message"))).message.text).toBe(
			"before the cut",
		);
		app.state.grants.get(app.principals.kim)?.delete(ROOM_A_ID);
		web.rooms.accessChanged(app.principals.kim);
		// Their page is told to look again, which finds the room gone.
		expect(await kim.take(ofType("room_changed"))).toMatchObject({
			room: ROOM_A,
		});
		kim.skip();
		await web.rooms.post(ROOM_A, external("after the cut"));
		expect(await kim.sees(ofType("host_message"), 300)).toBe(false);
		expect(
			(await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "kim" })).status,
		).toBe(404);
		app.state.grants
			.get(app.principals.kim)
			?.set(ROOM_A_ID, { read: true, send: ["note"], act: false });
		web.rooms.accessChanged(app.principals.kim);
		kim.close();
	});

	test("a room's header or list is refreshed when the host says it changed, to those who still read it", async () => {
		const mel = await Client.open(app, "mel");
		mel.send({ type: "subscribe", room: ROOM_A });
		// Mel's list was asked, so the list's changes are told to them.
		await rest(app, "host/inbox", { who: "mel" });
		await Bun.sleep(100);
		mel.skip();
		web.rooms.changed(ROOM_A);
		expect((await mel.take(ofType("room_changed"))).room).toBe(ROOM_A);
		expect(mel.frames.find(ofType("list_changed"))?.kind).toBe("inbox");
		// A person whose list is undefined is not told of it.
		const zed = await Client.open(app, "zed");
		await rest(app, "host/inbox", { who: "zed" });
		zed.skip();
		web.rooms.changed(ROOM_A);
		expect(await zed.sees(ofType("list_changed"), 300)).toBe(false);
		mel.close();
		zed.close();
	});

	test("a link to a room, or to one of its messages, is the same-origin address the page routes", async () => {
		expect(web.rooms.link(ROOM_A)).toBe(
			`/console/#/room/${encodeURIComponent(ROOM_A)}`,
		);
		expect(web.rooms.link(ROOM_A, 42)).toBe(
			`/console/#/room/${encodeURIComponent(ROOM_A)}?message=42`,
		);
		expect(() => web.rooms.link("app:nothing.abcdefgh" as ChannelKey)).toThrow(
			"registered kind",
		);
	});

	test("pages: the listed ones, the view with its query, the action, and a refresh to those the page is visible to", async () => {
		const ada = (await (await rest(app, "config", { who: "ada" })).json()) as {
			pages?: { id: string; icon?: string }[];
		};
		expect(ada.pages?.map((page) => page.id)).toEqual(["mailboxes"]);
		// The icon the page named reaches the shell, which draws it in the navigation.
		expect(ada.pages?.[0]?.icon).toBe("megaphone");
		const view = (await (
			await rest(app, "pages/mailboxes?q=hello", { who: "ada" })
		).json()) as HostPageView;
		expect(view.title).toBe("Mailboxes");
		expect(view.sections[0]).toEqual({
			kind: "markdown",
			text: "filter: hello",
		});
		expect((await rest(app, "pages/mailboxes", { who: "mel" })).status).toBe(
			404,
		);
		expect((await rest(app, "pages/nothing", { who: "ada" })).status).toBe(404);
		const result = (await (
			await post(
				app,
				"pages/mailboxes/act",
				{ action: "connect", input: { address: "a@b.test" } },
				"ada",
			)
		).json()) as HostActionResult;
		expect(result).toEqual({ ok: true, notice: "Connected" });
		expect(app.state.pageActs.at(-1)).toEqual({
			who: "ada",
			action: "connect",
			input: { address: "a@b.test" },
		});
		expect(
			(
				await post(
					app,
					"pages/mailboxes/act",
					{ action: "connect", input: {} },
					"mel",
				)
			).status,
		).toBe(404);
		const adaSocket = await Client.open(app, "ada");
		const melSocket = await Client.open(app, "mel");
		await Bun.sleep(50);
		web.pages.changed("mailboxes");
		expect(await adaSocket.take(ofType("page_changed"))).toEqual({
			type: "page_changed",
			page: "mailboxes",
		});
		expect(await melSocket.sees(ofType("page_changed"), 400)).toBe(false);
		adaSocket.close();
		melSocket.close();
	});

	test("a page's picture is a saved PNG, JPEG or WebP, shown only to those the page is visible to", async () => {
		const id = await web.pages.saveAsset("mailboxes", {
			name: "chart.png",
			type: "image/png",
			bytes: PNG,
		});
		const seen = await rest(app, `files/${id}`, { who: "ada" });
		expect(seen.status).toBe(200);
		expect(seen.headers.get("content-type")).toBe("image/png");
		// The page is the owners'; a member is not shown what hangs on it.
		expect((await rest(app, `files/${id}`, { who: "mel" })).status).toBe(404);
		// Only an image the bytes prove: GIF, a text and a type that lies are refused.
		const gif = Uint8Array.from([
			0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0,
		]);
		for (const bytes of [
			gif,
			new TextEncoder().encode("<svg onload=alert(1)>"),
		])
			await expect(
				web.pages.saveAsset("mailboxes", {
					name: "x.png",
					type: "image/png",
					bytes,
				}),
			).rejects.toThrow(/PNG, JPEG or WebP/);
		await expect(
			web.pages.saveAsset("no-such-page", {
				name: "x.png",
				type: "image/png",
				bytes: PNG,
			}),
		).rejects.toThrow(/no page/);
	});

	test("a press on a card that is not one of the room's, or a room that is not a host's, is not taken over the socket either", async () => {
		const ada = await Client.open(app, "ada");
		ada.send({
			type: "act",
			id: "x1",
			room: AGENT_ROOM,
			action: "assign",
		});
		expect(await ada.take(ofType("refused"))).toMatchObject({
			id: "x1",
			code: "unknown_room",
		});
		ada.send({ type: "act", id: "x2", page: "nothing", action: "go" });
		expect(await ada.take(ofType("refused"))).toMatchObject({ id: "x2" });
		ada.send({ type: "subscribe", room: AGENT_ROOM });
		expect(await ada.take(ofType("refused"))).toMatchObject({
			code: "unknown_room",
		});
		ada.close();
	});

	test("answering a card in a room whose access reads roles keeps the reader in the room", async () => {
		const mel = await Client.open(app, "mel");
		mel.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		let reply: unknown;
		app.state.script = async (message, speaker) => {
			if (!speaker) return;
			const prompts = app.host.context.surfaces.prompts(
				message.channel,
				promptScope(speaker, "shared"),
			);
			reply = await prompts?.ask("Which one?", {
				question: "Which mailbox?",
				options: [{ label: "support" }, { label: "sales" }],
				multi: false,
				allowOther: false,
			});
		};
		mel.send({ type: "send", id: "roles1", room: ROOM_A, text: "which" });
		const question = await mel.take(ofType("prompt"));
		// With no followed room nothing refreshes the memo, so the answer asks the kind afresh.
		mel.send({ type: "unsubscribe", room: ROOM_A });
		app.state.needRole = "web:role:pm";
		try {
			await Bun.sleep(11_000);
			mel.send({
				type: "answer",
				prompt: question.prompt.id,
				answer: { choices: ["support"] },
			});
			await Bun.sleep(300);
			expect(await mel.sees(ofType("refused"), 100)).toBe(false);
			expect(reply).toBeDefined();
		} finally {
			app.state.needRole = undefined;
		}
	}, 30_000);

	test("a question or an approval in a host room is its speaker's, the named approvers' and the owners' to answer, and a reader sees it only by following the room", async () => {
		const mel = await Client.open(app, "mel");
		const ada = await Client.open(app, "ada");
		for (const client of [mel, ada])
			client.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		let decision: string | undefined;
		let reply: unknown;
		app.state.script = async (message, speaker) => {
			if (!speaker) return;
			const prompts = app.host.context.surfaces.prompts(
				message.channel,
				promptScope(speaker, "shared"),
			);
			if (message.text.startsWith("approve")) {
				// Mel asks; Ada (an owner) alone is named, at the member tier.
				const approval = await prompts?.confirm(
					"Send it?",
					"Send the draft to the customer",
					undefined,
					"member",
					undefined,
					undefined,
					{ approvers: [app.principals.ada] },
				);
				decision = approval ?? "none";
			} else {
				reply = await prompts?.ask("Which one?", {
					question: "Which mailbox?",
					options: [{ label: "support" }, { label: "sales" }],
					multi: false,
					allowOther: false,
				});
			}
		};
		mel.send({
			type: "send",
			id: "ask1",
			room: ROOM_A,
			text: "approve this draft",
		});
		const card = await mel.take(ofType("prompt"));
		expect(card.room).toBe(ROOM_A);
		// A reader who follows the room later still gets the open card; one who cannot read it gets nothing.
		const kim = await Client.open(app, "kim");
		const zed = await Client.open(app, "zed");
		expect(await kim.sees(ofType("prompt"), 200)).toBe(false);
		kim.send({ type: "subscribe", room: ROOM_A });
		expect((await kim.take(ofType("prompt"))).prompt.id).toBe(card.prompt.id);
		zed.send({ type: "subscribe", room: ROOM_A });
		expect(await zed.sees(ofType("prompt"), 300)).toBe(false);
		// Neither Kim (a reader) nor Mel (the speaker, not named) may approve or decline it.
		kim.send({ type: "approval", prompt: card.prompt.id, approved: true });
		expect(await kim.take(ofType("refused"))).toMatchObject({
			prompt: card.prompt.id,
		});
		mel.send({ type: "approval", prompt: card.prompt.id, approved: true });
		expect(await mel.take(ofType("refused"))).toMatchObject({
			prompt: card.prompt.id,
		});
		mel.send({ type: "approval", prompt: card.prompt.id, approved: false });
		expect(await mel.take(ofType("refused"))).toMatchObject({
			prompt: card.prompt.id,
		});
		expect(decision).toBeUndefined();
		ada.send({ type: "approval", prompt: card.prompt.id, approved: true });
		await ada.take((frame) => frame.type === "prompt_closed");
		await Bun.sleep(50);
		expect(decision).toBe("approved");
		// A question is its speaker's: Mel answers it; Kim cannot.
		mel.skip();
		kim.skip();
		mel.send({ type: "send", id: "ask2", room: ROOM_A, text: "which mailbox" });
		const question = await mel.take(ofType("prompt"));
		kim.send({
			type: "answer",
			prompt: question.prompt.id,
			answer: { choices: ["sales"] },
		});
		expect(await kim.take(ofType("refused"))).toMatchObject({
			prompt: question.prompt.id,
		});
		mel.send({
			type: "answer",
			prompt: question.prompt.id,
			answer: { choices: ["support"] },
		});
		await mel.take((frame) => frame.type === "prompt_closed");
		await Bun.sleep(50);
		expect(reply).toBeDefined();
		app.state.script = undefined;
		for (const client of [mel, ada, kim, zed]) client.close();
	});

	test("what was said in a host room since the assistant last posted is the channel context of a turn, an outsider's words marked external", async () => {
		const room = `app:inbox.c${RUN}ctx01` as ChannelKey;
		app.state.grants.get(app.principals.ada)?.set(`c${RUN}ctx01`, READ_WRITE);
		await web.rooms.post(room, external("old question"));
		await web.rooms.post(room, {
			author: { kind: "assistant", name: "Assistant" },
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
});
