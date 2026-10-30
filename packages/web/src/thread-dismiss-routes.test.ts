import { beforeEach, describe, expect, test } from "bun:test";
import type { Tier } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import type {
	ApiError,
	RoomOneView,
	RoomView,
	ThreadsDismissed,
} from "./api-types.ts";
import type { ResolvedRoom } from "./app/rooms.ts";
import { AppApi } from "./app/routes.ts";
import type { AssetBundle } from "./assets.ts";
import { createAuthenticator } from "./auth/authenticator.ts";
import { ConsoleServer } from "./console-server.ts";
import { EMPTY_LAYOUT } from "./layout-order.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import { admit } from "./verifier.ts";
import type { Visitor } from "./visitors.ts";

const GUIDE = "app:agent.guide";
const DONE = "app:thread.0b5e7c1a-0000-4000-8000-000000000001";
const OPEN = "app:thread.0b5e7c1a-0000-4000-8000-000000000002";
const NONE = "app:thread.0b5e7c1a-0000-4000-8000-000000000003";

const assets: AssetBundle = new Map([
	["index.html", { body: Buffer.from("<html></html>"), type: "text/html" }],
]);

const room = (key: string, kind: ResolvedRoom["kind"]): ResolvedRoom => ({
	key: key as ResolvedRoom["key"],
	kind,
	name: key.slice(key.indexOf(":") + 1),
	displayName: key,
	readOnly: kind === "thread",
});
const known = new Map([
	[GUIDE, room(GUIDE, "agent")],
	[DONE, room(DONE, "thread")],
	[OPEN, room(OPEN, "thread")],
	[NONE, room(NONE, "thread")],
]);

let who: { id: string; tier: Tier };
let changes: number;
/** The threads by id: open or finished, and whether the list still shows them. */
let stored: Map<string, { parent: string; open: boolean; dismissed: boolean }>;

function setup() {
	const recorder = recordingLogger();
	const visitor = (): Visitor => ({
		principal: { id: who.id, displayName: who.id, disabled: false },
		tier: who.tier,
		speakerId: who.id,
		roles: [],
	});
	const api = new AppApi({
		surface: {} as never,
		rooms: {
			resolve: async (key: string) => known.get(key),
			threadView: async (key: string) =>
				known.get(key)?.kind === "thread"
					? ({ key, kind: "thread", closed: true } as unknown as RoomView)
					: undefined,
			placeable: () => new Set(),
			homeKey: () => GUIDE,
			list: async () => [],
		} as never,
		log: {} as never,
		cards: {} as never,
		uploads: {} as never,
		files: {} as never,
		modes: {} as never,
		conversations: {} as never,
		identity: { principal: async () => undefined },
		directory: {} as never,
		team: {} as never,
		avatars: {} as never,
		mutes: {} as never,
		threads: {
			under: async () => [],
			removeUnder: async () => 0,
			dismiss: async (id: string) => {
				const one = stored.get(id);
				if (!one) return "missing" as const;
				if (one.open) return "open" as const;
				one.dismissed = true;
				return "dismissed" as const;
			},
			dismissFinished: async (parent: string) => {
				let count = 0;
				for (const one of stored.values())
					if (one.parent === parent && !one.open && !one.dismissed) {
						one.dismissed = true;
						count += 1;
					}
				return count;
			},
		},
		layout: { view: async () => EMPTY_LAYOUT } as never,
		mount: "/console",
		authMode: "verifier",
		changed: () => {
			changes += 1;
		},
		logger: recorder.logger,
	});
	return new ConsoleServer({
		mount: "/console",
		assets,
		authenticator: createAuthenticator({
			auth: { mode: "verifier", verifier: () => admit() },
			identify: async () => ({ visitor: visitor() }),
			origin: ORIGIN,
			mount: "/console",
			title: "Console",
			logger: recorder.logger,
			dataDir: "unused",
			listener: { id: "public", address: undefined },
		}),
		api: { handle: async () => new Response("no", { status: 404 }) },
		app: {
			handle: (request, rest, admission) =>
				api.handle(request, rest, admission),
			websocket: {} as never,
		},
		subscribe: () => undefined,
		logger: recorder.logger,
	});
}

beforeEach(() => {
	who = { id: "owner", tier: "owner" };
	changes = 0;
	stored = new Map([
		[DONE.slice(4), { parent: GUIDE, open: false, dismissed: false }],
		[OPEN.slice(4), { parent: GUIDE, open: true, dismissed: false }],
	]);
});

const call = (server: ConsoleServer, method: string, path: string) =>
	server.handle(
		new Request(`http://host/console/api/${path}`, {
			method,
			headers: { origin: ORIGIN },
		}),
	);
const at = (key: string, action = "") =>
	`rooms/${encodeURIComponent(key)}${action && `/${action}`}`;
const errorOf = async (response: Response) =>
	((await response.json()) as ApiError).error;

describe("dismissing dispatch threads from the room list", () => {
	test("an owner dismisses a finished thread, and the other pages are told", async () => {
		const response = await call(setup(), "POST", at(DONE, "dismiss"));
		expect(response.status).toBe(200);
		expect((await response.json()) as ThreadsDismissed).toEqual({
			dismissed: 1,
		});
		expect(stored.get(DONE.slice(4))?.dismissed).toBe(true);
		expect(changes).toBe(1);
	});

	test("an open thread is refused with 409 and stays listed", async () => {
		const response = await call(setup(), "POST", at(OPEN, "dismiss"));
		expect(response.status).toBe(409);
		expect(await errorOf(response)).toContain("still open");
		expect(stored.get(OPEN.slice(4))?.dismissed).toBe(false);
		expect(changes).toBe(0);
	});

	test("a thread that is not stored, and a room that is no thread, answer 404", async () => {
		const server = setup();
		expect((await call(server, "POST", at(NONE, "dismiss"))).status).toBe(404);
		expect((await call(server, "POST", at(GUIDE, "dismiss"))).status).toBe(404);
		expect(
			(await call(server, "POST", at("app:agent.nobody", "dismiss"))).status,
		).toBe(404);
		expect(changes).toBe(0);
	});

	test("clearing a room's finished threads dismisses only the finished ones, once", async () => {
		const server = setup();
		const first = await call(server, "POST", at(GUIDE, "dismiss-threads"));
		expect((await first.json()) as ThreadsDismissed).toEqual({ dismissed: 1 });
		expect(stored.get(DONE.slice(4))?.dismissed).toBe(true);
		expect(stored.get(OPEN.slice(4))?.dismissed).toBe(false);
		expect(changes).toBe(1);
		const again = await call(server, "POST", at(GUIDE, "dismiss-threads"));
		expect((await again.json()) as ThreadsDismissed).toEqual({ dismissed: 0 });
		// Nothing changed, so no page needs to refetch.
		expect(changes).toBe(1);
		// A thread has no threads of its own.
		expect(
			(await call(server, "POST", at(DONE, "dismiss-threads"))).status,
		).toBe(404);
	});

	test("a dismissed thread still has its view by address; an agent's room has none", async () => {
		const server = setup();
		await call(server, "POST", at(DONE, "dismiss"));
		const view = await call(server, "GET", at(DONE));
		expect(view.status).toBe(200);
		expect(((await view.json()) as RoomOneView).room).toMatchObject({
			key: DONE,
			closed: true,
		});
		expect((await call(server, "GET", at(GUIDE))).status).toBe(404);
	});

	test("nobody but an owner can ask: the routes do not exist for anyone else", async () => {
		for (const tier of ["admin", "member"] as const) {
			who = { id: tier, tier };
			const server = setup();
			for (const [method, path] of [
				["POST", at(DONE, "dismiss")],
				["POST", at(GUIDE, "dismiss-threads")],
				["GET", at(DONE)],
			] as const)
				expect((await call(server, method, path)).status).toBe(404);
		}
		expect(stored.get(DONE.slice(4))?.dismissed).toBe(false);
		expect(changes).toBe(0);
	});

	test("a write from another origin is refused", async () => {
		const response = await setup().handle(
			new Request(`http://host/console/api/${at(DONE, "dismiss")}`, {
				method: "POST",
				headers: { origin: "https://evil.example" },
			}),
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(stored.get(DONE.slice(4))?.dismissed).toBe(false);
	});
});
