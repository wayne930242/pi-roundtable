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
	): {
		socket: RouteSocket<AppSocket>;
		sent: ServerFrame[];
		closed: { code?: number | undefined; open: boolean };
	};
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
		desk: partial<OwnerDesk>({ openFrames: () => [] }),
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
			claim: () => [],
			use: () => undefined,
			refOf: () => ({}) as never,
		}),
		identity: {
			tierOf: async (id: string) => tiers.get(id) as never,
		},
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
		open: (principal, facts = {}) => {
			const sent: ServerFrame[] = [];
			const closed: { code?: number | undefined; open: boolean } = {
				open: true,
			};
			const socket: RouteSocket<AppSocket> = {
				data: {
					principal: { id: principal, name: principal },
					actor: ACTOR,
					expiresAt: undefined,
					visible: true,
					focus: undefined,
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
			return { socket, sent, closed };
		},
	};
}

const wait = (ms: number) => Bun.sleep(ms);

test("RV-F001: in password mode a socket lives at most the cap, then closes 4401", async () => {
	const h = harness({ maxLifeMs: 60 });
	const farOff = new Date(Date.now() + 30 * 86_400_000);
	const { closed } = h.open("ada", { expiresAt: farOff });
	await wait(20);
	expect(closed.open).toBe(true);
	await wait(120);
	expect(closed.code).toBe(4401);
});

test("RV-F001: the credential's own expiry still wins when it is sooner than the cap", async () => {
	const h = harness({ maxLifeMs: 10_000 });
	const { closed } = h.open("ada", { expiresAt: new Date(Date.now() + 50) });
	await wait(150);
	expect(closed.code).toBe(4401);
});

test("RV-F001: without a cap a socket with no expiry stays open", async () => {
	const h = harness({});
	const { closed } = h.open("ada");
	await wait(80);
	expect(closed.open).toBe(true);
});

test("RV-F002: an owner who is demoted is dropped on the next check and gets no more frames", async () => {
	const h = harness({ recheckMs: 30 });
	const { sent, closed } = h.open("ada");
	h.sockets.broadcast({ type: "changed" });
	expect(sent.some((f) => f.type === "changed")).toBe(true);
	h.tiers.set("ada", "member");
	await wait(120);
	expect(closed.code).toBe(4403);
	const before = sent.length;
	h.sockets.broadcast({ type: "changed" });
	expect(sent.length).toBe(before);
});

test("RV-F002: a frame from a demoted owner closes the socket, even one that only moves focus", async () => {
	const h = harness({ recheckMs: 60_000 });
	const { socket, closed } = h.open("ada");
	h.tiers.set("ada", undefined);
	await h.route.message(socket, JSON.stringify({ type: "focus", room: ROOM }));
	expect(closed.code).toBe(4403);
	expect(socket.data.focus).toBeUndefined();
});

test("RV-F003: a visitor admitted with no actor is refused when they send, and nothing is delivered", async () => {
	const h = harness({});
	const { socket, sent } = h.open("ada", { actor: undefined });
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
	const { socket, sent } = h.open("ada");
	await h.route.message(
		socket,
		JSON.stringify({ type: "send", id: "m2", room: ROOM, text: "hello" }),
	);
	expect(sent.some((f) => f.type === "accepted")).toBe(true);
	expect(h.delivered[0]?.actor).toEqual(ACTOR);
});
