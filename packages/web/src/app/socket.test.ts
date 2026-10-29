import { expect, test } from "bun:test";
import type { ActorFacts, InboundMessage, RouteSocket } from "pi-roundtable";
import { partial, silentLogger } from "pi-roundtable/testing";
import type { ServerFrame } from "../api-types.ts";
import type { OwnerDesk } from "./desk.ts";
import type { Rooms } from "./rooms.ts";
import { SocketRoute, type SocketRouteOptions } from "./socket.ts";
import { type AppSocket, Sockets } from "./sockets.ts";
import type { AppSurface } from "./surface.ts";
import type { Uploads } from "./uploads.ts";

const ROOM = "app:agent.guide";
const ACTOR: ActorFacts = {
	provider: "token",
	subject: "web-console",
	name: "Web console",
};

interface Harness {
	route: ReturnType<SocketRoute["route"]>;
	sockets: Sockets;
	tiers: Map<string, string | undefined>;
	delivered: InboundMessage[];
	/** Opens a socket for a principal; `closed` records the code it was closed with. */
	open(
		principal: string,
		facts?: Partial<AppSocket>,
	): Promise<{
		socket: RouteSocket<AppSocket>;
		sent: ServerFrame[];
		closed: { code?: number | undefined; open: boolean };
	}>;
}

function harness(
	options: Partial<SocketRouteOptions> = {},
	started = true,
): Harness {
	const sockets = new Sockets(silentLogger());
	const tiers = new Map<string, string | undefined>([["ada", "owner"]]);
	const delivered: InboundMessage[] = [];
	const route = new SocketRoute({
		path: "/console/api/socket",
		origin: "https://app.example.test",
		authenticator: {
			authenticate: async () => ({ refusal: "n/a", status: 401 }),
			// The harness keys a socket's person by its session: the principal it was opened for.
			recheck: async (held) => {
				const id = held.session ?? "";
				const tier = tiers.get(id);
				if (!tier) return { refusal: "gone", status: 403 as const };
				return {
					visitor: {
						principal: { id, displayName: id, disabled: false },
						tier: tier as never,
						speakerId: id,
						roles: [],
					},
				};
			},
		},
		sockets,
		surface: partial<AppSurface>({
			started,
			publish: async (row) => ({
				id: 1,
				room: row.room,
				kind: row.kind,
				author: row.author,
				text: row.text,
				files: [],
				at: new Date().toISOString(),
			}),
			deliver: (message) => {
				delivered.push(message);
			},
		}),
		desk: partial<OwnerDesk>({ openFrames: () => [], roomOf: () => undefined }),
		rooms: partial<Rooms>({
			resolve: async (key) =>
				key === ROOM
					? {
							key: ROOM as never,
							kind: "agent",
							name: "guide",
							displayName: "Guide",
							readOnly: false,
						}
					: undefined,
		}),
		uploads: partial<Uploads>({
			maxBytes: 100 * 1024 * 1024,
			claim: () => [],
			use: () => undefined,
			refOf: () => ({}) as never,
		}),
		registry: {
			frameHandler: () => undefined,
			isHostRoom: () => false,
			access: { read: async () => false, readNow: () => false },
		},
		gate: { required: async () => [], onChanged: () => () => undefined },
		audienceOf: () => ({ owners: true }),
		conversations: { stop: () => true },
		logger: silentLogger(),
		...options,
	});
	const wired = route.route();
	return {
		route: wired,
		sockets,
		tiers,
		delivered,
		open: async (principal, facts = {}) => {
			const sent: ServerFrame[] = [];
			const closed: { code?: number | undefined; open: boolean } = {
				open: true,
			};
			const socket: RouteSocket<AppSocket> = {
				data: {
					principal: { id: principal, name: principal },
					actor: ACTOR,
					expiresAt: undefined,
					tier: "owner",
					speakerId: principal,
					roles: [],
					gated: false,
					session: principal,
					visible: true,
					focus: undefined,
					subscriptions: new Set<string>(),
					...facts,
				},
				send: (message) => {
					sent.push(JSON.parse(String(message)) as ServerFrame);
					return "sent" as never;
				},
				close: (code) => {
					closed.code = code;
					closed.open = false;
					wired.close?.(socket, code ?? 1000, "");
				},
			};
			wired.open?.(socket);
			// The socket is admitted again and told `ready` before it receives anything else.
			await wait(10);
			return { socket, sent, closed };
		},
	};
}

const wait = (ms: number) => Bun.sleep(ms);

test("RV-F001: in password mode a socket lives at most the cap, then closes 4401", async () => {
	const h = harness({ maxLifeMs: 60 });
	const farOff = new Date(Date.now() + 30 * 86_400_000);
	const { closed } = await h.open("ada", { expiresAt: farOff });
	await wait(20);
	expect(closed.open).toBe(true);
	await wait(120);
	expect(closed.code).toBe(4401);
});

test("RV-F001: the credential's own expiry still wins when it is sooner than the cap", async () => {
	const h = harness({ maxLifeMs: 10_000 });
	const { closed } = await h.open("ada", {
		expiresAt: new Date(Date.now() + 50),
	});
	await wait(150);
	expect(closed.code).toBe(4401);
});

test("RV-F001: without a cap a socket with no expiry stays open", async () => {
	const h = harness({});
	const { closed } = await h.open("ada");
	await wait(80);
	expect(closed.open).toBe(true);
});

test("RV-F002: a person who is no longer admitted is dropped on the next check and gets no more frames", async () => {
	const h = harness({ recheckMs: 30 });
	const { sent, closed } = await h.open("ada");
	h.sockets.deliver({ type: "changed" }, { owners: true });
	expect(sent.some((f) => f.type === "changed")).toBe(true);
	h.tiers.set("ada", undefined);
	await wait(120);
	expect(closed.code).toBe(4403);
	const before = sent.length;
	h.sockets.deliver({ type: "changed" }, { owners: true });
	expect(sent.length).toBe(before);
});

test("RV-F002: a frame from a demoted owner closes the socket, even one that only moves focus", async () => {
	const h = harness({ recheckMs: 60_000 });
	const { socket, sent, closed } = await h.open("ada");
	h.tiers.set("ada", undefined);
	await h.route.message(socket, JSON.stringify({ type: "focus", room: ROOM }));
	expect(closed.code).toBe(4403);
	// The socket is out of the set, so the focus it named reaches nothing.
	const before = sent.length;
	h.sockets.deliver({ type: "changed" }, { owners: true, focus: ROOM });
	expect(sent.length).toBe(before);
});

test("RV-F003: a visitor admitted with no actor is refused when they send, and nothing is delivered", async () => {
	const h = harness({});
	const { socket, sent } = await h.open("ada", { actor: undefined });
	await h.route.message(
		socket,
		JSON.stringify({ type: "send", id: "m1", room: ROOM, text: "hello" }),
	);
	expect(sent.find((f) => f.type === "refused")).toEqual({
		type: "refused",
		id: "m1",
		code: "forbidden",
	});
	expect(h.delivered).toEqual([]);
});

test("RV-F003: a visitor with an actor sends as that actor", async () => {
	const h = harness({});
	const { socket, sent } = await h.open("ada");
	await h.route.message(
		socket,
		JSON.stringify({ type: "send", id: "m2", room: ROOM, text: "hello" }),
	);
	expect(sent.some((f) => f.type === "accepted")).toBe(true);
	expect(h.delivered[0]?.actor).toEqual(ACTOR);
});

test("RV-F001: state frames apply in the order they arrive, however long each owner lookup takes", async () => {
	let lookups = 0;
	const h = harness({
		authenticator: {
			authenticate: async () => ({ refusal: "n/a", status: 401 }),
			// The first lookup is slow, the later ones are not.
			recheck: async () => {
				lookups += 1;
				if (lookups === 2) await wait(40);
				return {
					visitor: {
						principal: { id: "ada", displayName: "ada", disabled: false },
						tier: "owner" as const,
						speakerId: "ada",
						roles: [],
					},
				};
			},
		},
	});
	const { socket } = await h.open("ada", { visible: false, focus: undefined });
	const first = h.route.message(
		socket,
		JSON.stringify({ type: "hello", visible: true, focus: ROOM }),
	);
	const second = h.route.message(
		socket,
		JSON.stringify({ type: "visibility", visible: false }),
	);
	const third = h.route.message(socket, JSON.stringify({ type: "focus" }));
	await Promise.all([first, second, third]);
	expect(socket.data.visible).toBe(false);
	expect(socket.data.focus).toBeUndefined();
});

test("RV-F007: a late card answered by a socket with no actor is refused and the card stays open", async () => {
	const answered: string[] = [];
	const h = harness({
		desk: partial<OwnerDesk>({
			openFrames: () => [],
			roomOf: () => undefined,
			isLate: (prompt: string) => prompt === "late-1",
			approve: (_who, prompt) => {
				answered.push(prompt);
				return undefined;
			},
		}),
	});
	const { socket, sent } = await h.open("ada", { actor: undefined });
	await h.route.message(
		socket,
		JSON.stringify({ type: "approval", prompt: "late-1", approved: true }),
	);
	expect(answered).toEqual([]);
	// The refusal names the card, so its page can enable the buttons again.
	expect(sent.find((f) => f.type === "refused")).toEqual({
		type: "refused",
		code: "forbidden",
		prompt: "late-1",
	});
	// A card still being waited on needs no actor to be answered.
	await h.route.message(
		socket,
		JSON.stringify({ type: "approval", prompt: "live-1", approved: true }),
	);
	expect(answered).toEqual(["live-1"]);
});

const CARD = {
	room: ROOM as never,
	frame: {
		type: "prompt" as const,
		room: ROOM,
		prompt: {
			id: "card-1",
			kind: "approval" as const,
			title: "Run it?",
			message: "Run the tool",
			purpose: "action" as const,
			at: "2026-10-29T10:00:00.000Z",
		},
	},
};

/** The frames of the agent rooms, as the surface, the desk and the presence table address them. */
function agentRoomFrames(h: Harness) {
	const { sockets } = h;
	const owners = { owners: true as const };
	sockets.deliver(
		{
			type: "message",
			room: ROOM,
			message: {
				id: 1,
				room: ROOM,
				kind: "agent",
				author: "guide",
				text: "secret reply",
				files: [],
				at: "2026-10-29T10:00:00.000Z",
			},
		} as never,
		owners,
	);
	sockets.deliver(CARD.frame as never, owners);
	sockets.deliver(
		{ type: "presence", agents: { guide: { busy: true } } },
		owners,
	);
	sockets.deliver({ type: "changed" }, owners);
	sockets.deliver(
		{ type: "progress", room: ROOM, text: "thinking", tools: [] } as never,
		{ owners: true, focus: ROOM },
	);
}

test("a member socket gets nothing from the agent rooms while the owner works in them", async () => {
	const h = harness();
	h.tiers.set("mel", "member");
	const member = await h.open("mel", { tier: "member" });
	const owner = await h.open("ada");
	// A member who focuses an agent room is not shown its progress.
	member.socket.data.focus = ROOM;
	owner.socket.data.focus = ROOM;
	agentRoomFrames(h);
	expect(member.sent.map((f) => f.type)).toEqual(["ready"]);
	// The owner's own socket still gets all of it.
	expect(owner.sent.map((f) => f.type)).toEqual([
		"ready",
		"message",
		"prompt",
		"presence",
		"changed",
		"progress",
	]);
});

test("a member who connects while an owner's card is open and presence exists gets neither", async () => {
	const h = harness({
		desk: partial<OwnerDesk>({
			openFrames: () => [CARD],
			roomOf: () => undefined,
		}),
		presence: {
			frame: async () => ({
				type: "presence",
				agents: { guide: { busy: true } },
			}),
		} as never,
	});
	h.tiers.set("mel", "member");
	const member = await h.open("mel", { tier: "member" });
	expect(member.sent.map((f) => f.type)).toEqual(["ready"]);
	const owner = await h.open("ada");
	expect(owner.sent.map((f) => f.type).sort()).toEqual([
		"presence",
		"prompt",
		"ready",
	]);
});

test("a member's send, stop and approval for an agent room are refused, and nothing reaches the surface", async () => {
	let answered = 0;
	const h = harness({
		desk: partial<OwnerDesk>({
			openFrames: () => [],
			roomOf: (prompt) => (prompt === "card-1" ? (ROOM as never) : undefined),
			approve: () => {
				answered += 1;
				return undefined;
			},
		}),
	});
	h.tiers.set("mel", "member");
	const member = await h.open("mel", { tier: "member" });
	for (const frame of [
		{ type: "send", id: "m1", room: ROOM, text: "hello" },
		{ type: "stop", room: ROOM },
		{ type: "approval", prompt: "card-1", approved: true },
	])
		h.route.message?.(member.socket, JSON.stringify(frame));
	await wait(30);
	expect(h.delivered).toEqual([]);
	expect(answered).toBe(0);
	expect(
		member.sent
			.filter((f) => f.type === "refused")
			.map((f) => (f as { code: string }).code),
	).toContain("forbidden");
});

test("a person promoted to owner while connected starts getting the owners' frames from then on", async () => {
	const h = harness({ recheckMs: 30 });
	h.tiers.set("mel", "member");
	const member = await h.open("mel", { tier: "member" });
	h.sockets.deliver({ type: "changed" }, { owners: true });
	expect(member.sent.map((f) => f.type)).toEqual(["ready"]);
	h.tiers.set("mel", "owner");
	await wait(120);
	h.sockets.deliver({ type: "changed" }, { owners: true });
	expect(member.sent.some((f) => f.type === "changed")).toBe(true);
});
