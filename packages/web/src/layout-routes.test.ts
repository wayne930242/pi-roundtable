import { beforeEach, describe, expect, test } from "bun:test";
import type { Tier } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import type { ApiError, LayoutView, RoomsView } from "./api-types.ts";
import type { LayoutStore } from "./app/layout.ts";
import type { ResolvedRoom } from "./app/rooms.ts";
import { AppApi } from "./app/routes.ts";
import type { AssetBundle } from "./assets.ts";
import { createAuthenticator } from "./auth/authenticator.ts";
import { ConsoleServer } from "./console-server.ts";
import type { ConsolePresentation } from "./features.ts";
import { EMPTY_LAYOUT, forgetRoom } from "./layout-order.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import { admit } from "./verifier.ts";
import type { Visitor } from "./visitors.ts";

const HOME = "app:agent.guide";
const SCOUT = "app:agent.scout";
const BUILD = "app:agent.build";
const TEAM = "app:group.team";
const GONE = "app:agent.gone";
const THREAD = "app:thread.0b5e7c1a-0000-4000-8000-000000000001";

const assets: AssetBundle = new Map([
	["index.html", { body: Buffer.from("<html></html>"), type: "text/html" }],
]);

/** The stored layout in memory, as the store keeps it: edits apply as one step, a throwing edit changes nothing. */
class MemoryLayout implements LayoutStore {
	stored: LayoutView = structuredClone(EMPTY_LAYOUT);
	async view() {
		return structuredClone(this.stored);
	}
	async forget(room: string) {
		this.stored = forgetRoom(this.stored, room);
	}
	async change(edit: (layout: LayoutView) => LayoutView) {
		this.stored = edit(structuredClone(this.stored));
		return structuredClone(this.stored);
	}
}

const room = (key: string, kind: ResolvedRoom["kind"]): ResolvedRoom => ({
	key: key as ResolvedRoom["key"],
	kind,
	name: key,
	displayName: key,
	readOnly: kind === "thread",
});
const known = new Map([
	[HOME, room(HOME, "agent")],
	[SCOUT, room(SCOUT, "agent")],
	[BUILD, room(BUILD, "agent")],
	[TEAM, room(TEAM, "group")],
	[THREAD, room(THREAD, "thread")],
]);

let who: { id: string; tier: Tier };
let store: MemoryLayout;
let changes: number;
/** The muted rooms, and who muted each. */
let muted: Map<string, string>;

function setup(presentation?: ConsolePresentation) {
	const recorder = recordingLogger();
	const visitor = (): Visitor => ({
		principal: { id: who.id, displayName: who.id, disabled: false },
	});
	const api = new AppApi({
		...(presentation ? { presentation } : {}),
		surface: {} as never,
		rooms: {
			resolve: async (key: string) => known.get(key),
			placeable: () => new Set([SCOUT, BUILD, TEAM]),
			homeKey: () => HOME,
			list: async () => [],
		} as never,
		log: {} as never,
		cards: {} as never,
		uploads: {} as never,
		files: {} as never,
		modes: {} as never,
		conversations: {} as never,
		identity: { tierOf: async () => who.tier },
		directory: {} as never,
		team: {} as never,
		avatars: {} as never,
		mutes: {
			set: async () => undefined,
			setMany: async (rooms: readonly string[], on: boolean, by: string) => {
				for (const room of rooms)
					if (on) muted.set(room, by);
					else muted.delete(room);
			},
		},
		threads: {} as never,
		layout: store,
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
	store = new MemoryLayout();
	changes = 0;
	muted = new Map();
});

const call = (
	server: ConsoleServer,
	method: string,
	path: string,
	init: {
		body?: unknown;
		origin?: string | null;
		raw?: string;
	} = {},
) =>
	server.handle(
		new Request(`http://host/console/api/${path}`, {
			method,
			headers: {
				...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }),
				...(init.body !== undefined || init.raw !== undefined
					? { "content-type": "application/json" }
					: {}),
			},
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
			...(init.raw !== undefined ? { body: init.raw } : {}),
		}),
	);

const layoutOf = async (response: Response) =>
	(await response.json()) as LayoutView;
const errorOf = async (response: Response) =>
	((await response.json()) as ApiError).error;
const encoded = (key: string) => encodeURIComponent(key);

/** Makes a folder through the API and returns its id. */
async function folder(server: ConsoleServer, name: string): Promise<string> {
	const answer = await layoutOf(
		await call(server, "POST", "folders", { body: { name } }),
	);
	return answer.folders.find((one) => one.name === name)?.id as string;
}

describe("the room list's layout", () => {
	test("GET rooms carries the layout with it, and hides rooms that are gone", async () => {
		store.stored = {
			pins: [SCOUT, GONE],
			folders: [{ id: "folder.x", name: "Old", rooms: [GONE, TEAM] }],
		};
		const view = (await (
			await call(setup(), "GET", "rooms")
		).json()) as RoomsView;
		expect(view.rooms).toEqual([]);
		expect(view.pins).toEqual([SCOUT]);
		expect(view.folders).toEqual([
			{ id: "folder.x", name: "Old", rooms: [TEAM] },
		]);
		// The stored layout keeps the deleted agent's place.
		expect(store.stored.pins).toEqual([SCOUT, GONE]);
	});

	test("an owner makes, renames, places and removes folders; every answer is the whole layout", async () => {
		const server = setup();
		const created = await call(server, "POST", "folders", {
			body: { name: "  Work " },
		});
		expect(created.status).toBe(201);
		const work = (await layoutOf(created)).folders[0];
		expect(work).toMatchObject({ name: "Work", rooms: [] });
		expect(work?.id).toMatch(/^folder\.[0-9a-f-]{36}$/);
		const play = await folder(server, "Play");

		const renamed = await call(server, "PATCH", `folders/${work?.id}`, {
			body: { name: "Office" },
		});
		expect(renamed.status).toBe(200);
		expect((await layoutOf(renamed)).folders.map((f) => f.name)).toEqual([
			"Office",
			"Play",
		]);
		const moved = await call(server, "PATCH", `folders/${play}`, {
			body: { before: work?.id },
		});
		expect((await layoutOf(moved)).folders.map((f) => f.name)).toEqual([
			"Play",
			"Office",
		]);
		const both = await call(server, "PATCH", `folders/${play}`, {
			body: { name: "Fun", before: null },
		});
		expect((await layoutOf(both)).folders.map((f) => f.name)).toEqual([
			"Office",
			"Fun",
		]);

		const removed = await call(server, "DELETE", `folders/${work?.id}`);
		expect((await layoutOf(removed)).folders.map((f) => f.name)).toEqual([
			"Fun",
		]);
		expect(changes).toBe(6);
	});

	test("a room goes into a folder and out of it, and is pinned and unpinned, before a neighbour or last", async () => {
		const server = setup();
		const work = await folder(server, "Work");
		const into = await call(server, "PUT", `rooms/${encoded(SCOUT)}/folder`, {
			body: { folder: work },
		});
		expect(into.status).toBe(200);
		expect((await layoutOf(into)).folders[0]?.rooms).toEqual([SCOUT]);
		const before = await call(server, "PUT", `rooms/${encoded(TEAM)}/folder`, {
			body: { folder: work, before: SCOUT },
		});
		expect((await layoutOf(before)).folders[0]?.rooms).toEqual([TEAM, SCOUT]);

		const pinned = await call(server, "PUT", `rooms/${encoded(SCOUT)}/pin`, {
			body: { pinned: true },
		});
		expect(await layoutOf(pinned)).toEqual({
			pins: [SCOUT],
			folders: [{ id: work, name: "Work", rooms: [TEAM] }],
		});
		const second = await call(server, "PUT", `rooms/${encoded(BUILD)}/pin`, {
			body: { pinned: true, before: SCOUT },
		});
		expect((await layoutOf(second)).pins).toEqual([BUILD, SCOUT]);
		const unpinned = await call(server, "PUT", `rooms/${encoded(BUILD)}/pin`, {
			body: { pinned: false },
		});
		expect((await layoutOf(unpinned)).pins).toEqual([SCOUT]);
		const out = await call(server, "PUT", `rooms/${encoded(TEAM)}/folder`, {
			body: { folder: null },
		});
		expect((await layoutOf(out)).folders[0]?.rooms).toEqual([]);
	});

	test("a folder or a pin needs an owner", async () => {
		const server = setup();
		const work = await folder(server, "Work");
		who = { id: "member", tier: "member" as Tier };
		const writes: [string, string, unknown][] = [
			["POST", "folders", { name: "X" }],
			["PATCH", `folders/${work}`, { name: "Y" }],
			["DELETE", `folders/${work}`, undefined],
			["PUT", `rooms/${encoded(SCOUT)}/folder`, { folder: work }],
			["PUT", `rooms/${encoded(SCOUT)}/pin`, { pinned: true }],
		];
		for (const [method, path, body] of writes) {
			const answer = await call(server, method, path, {
				...(body === undefined ? {} : { body }),
			});
			expect(answer.status).toBe(403);
			expect(await errorOf(answer)).toBe("Only an owner may do this.");
		}
		expect(store.stored.folders.map((f) => f.name)).toEqual(["Work"]);
	});

	test("a write from another origin or without one is refused and changes nothing", async () => {
		const server = setup();
		for (const origin of ["https://evil.example.test", null]) {
			const answer = await call(server, "POST", "folders", {
				body: { name: "X" },
				origin,
			});
			expect(answer.status).toBe(403);
		}
		expect(store.stored).toEqual(EMPTY_LAYOUT);
		expect(changes).toBe(0);
	});

	test("an unknown room is 404; Home and a thread are 400; an unknown folder is 404", async () => {
		const server = setup();
		const work = await folder(server, "Work");
		const unknown = await call(
			server,
			"PUT",
			`rooms/${encoded("app:agent.nobody")}/pin`,
			{ body: { pinned: true } },
		);
		expect(unknown.status).toBe(404);
		const other = await call(
			server,
			"PUT",
			`rooms/${encoded("discord:123")}/folder`,
			{ body: { folder: work } },
		);
		expect(other.status).toBe(404);

		for (const action of ["pin", "folder"] as const) {
			const body = action === "pin" ? { pinned: true } : { folder: work };
			const home = await call(
				server,
				"PUT",
				`rooms/${encoded(HOME)}/${action}`,
				{
					body,
				},
			);
			expect(home.status).toBe(400);
			expect(await errorOf(home)).toBe("Home stays at the top.");
			const thread = await call(
				server,
				"PUT",
				`rooms/${encoded(THREAD)}/${action}`,
				{ body },
			);
			expect(thread.status).toBe(400);
			expect(await errorOf(thread)).toBe("A thread stays under its room.");
		}

		const missing = "folder.00000000-0000-4000-8000-000000000000";
		const into = await call(server, "PUT", `rooms/${encoded(SCOUT)}/folder`, {
			body: { folder: missing },
		});
		expect(into.status).toBe(404);
		expect(await errorOf(into)).toBe("There is no such folder.");
		for (const method of ["PATCH", "DELETE"]) {
			const answer = await call(server, method, `folders/${missing}`, {
				...(method === "PATCH" ? { body: { name: "X" } } : {}),
			});
			expect(answer.status).toBe(404);
		}
		expect((await call(server, "DELETE", "folders/not-an-id")).status).toBe(
			404,
		);
		expect(store.stored.pins).toEqual([]);
	});

	test("under a host that words the console in zh-TW a refusal reaches the API's client in that wording, and in English without one", async () => {
		const pin = (server: ReturnType<typeof setup>) =>
			call(server, "PUT", `rooms/${encoded(HOME)}/pin`, {
				body: { pinned: true },
			});
		const english = await pin(setup());
		expect(await errorOf(english)).toBe("Home stays at the top.");
		const worded = await pin(setup({ locale: "zh-TW" }));
		expect(worded.status).toBe(400);
		expect(await errorOf(worded)).toBe(
			"\u9996\u9801\u56fa\u5b9a\u5728\u6700\u4e0a\u9762\u3002",
		);
		// the host's own wording wins over the catalog's, and an answer that is no refusal is left alone
		const hosted = await pin(
			setup({
				locale: "zh-TW",
				messages: { "Home stays at the top.": "Home first." },
			}),
		);
		expect(await errorOf(hosted)).toBe("Home first.");
		const ok = await call(setup({ locale: "zh-TW" }), "GET", "rooms");
		expect(ok.status).toBe(200);
	});

	test("a bad name, a duplicate and the 51st folder are refused with their words", async () => {
		const server = setup();
		await folder(server, "Work");
		const words = "Give the folder a name of 1 to 40 characters.";
		for (const name of ["", "   ", "x".repeat(41)]) {
			const answer = await call(server, "POST", "folders", { body: { name } });
			expect(answer.status).toBe(400);
			expect(await errorOf(answer)).toBe(words);
		}
		const duplicate = await call(server, "POST", "folders", {
			body: { name: "work" },
		});
		expect(duplicate.status).toBe(409);
		expect(await errorOf(duplicate)).toBe("A folder of that name exists.");
		for (let i = 1; i < 50; i++) await folder(server, `Folder ${i}`);
		const full = await call(server, "POST", "folders", {
			body: { name: "One more" },
		});
		expect(full.status).toBe(409);
		expect(await errorOf(full)).toBe("There are 50 folders already.");
		expect(store.stored.folders).toHaveLength(50);
	});

	test("a body that is not JSON or has the wrong types is 400, never 500", async () => {
		const server = setup();
		const work = await folder(server, "Work");
		const pin = `rooms/${encoded(SCOUT)}/pin`;
		const place = `rooms/${encoded(SCOUT)}/folder`;
		const cases: [string, string, { body?: unknown; raw?: string }][] = [
			["POST", "folders", { raw: "{nope" }],
			["POST", "folders", { raw: "[1]" }],
			["POST", "folders", { body: { name: 7 } }],
			["POST", "folders", { body: {} }],
			["PATCH", `folders/${work}`, { body: {} }],
			["PATCH", `folders/${work}`, { body: { name: 3 } }],
			["PATCH", `folders/${work}`, { body: { before: 3 } }],
			["PUT", pin, { body: { pinned: "yes" } }],
			["PUT", pin, { body: { pinned: true, before: 1 } }],
			["PUT", pin, { raw: "oops" }],
			["PUT", place, { body: { folder: 4 } }],
			["PUT", place, { body: {} }],
			["PUT", place, { body: { folder: null, before: false } }],
		];
		for (const [method, path, init] of cases) {
			const answer = await call(server, method, path, init);
			expect(answer.status).toBe(400);
			expect(typeof (await errorOf(answer))).toBe("string");
		}
		expect(store.stored.pins).toEqual([]);
	});

	test("other methods are refused", async () => {
		const server = setup();
		expect((await call(server, "GET", "folders")).status).toBe(405);
		expect((await call(server, "PUT", "folders")).status).toBe(405);
		expect(
			(
				await call(
					server,
					"POST",
					"folders/folder.00000000-0000-4000-8000-000000000000",
				)
			).status,
		).toBe(405);
		expect(
			(await call(server, "GET", `rooms/${encoded(SCOUT)}/pin`)).status,
		).toBe(404);
	});

	test("muting a folder mutes every room in it through the rooms' own mutes, and unmuting lifts them", async () => {
		const server = setup();
		const work = await folder(server, "Work");
		store.stored = {
			pins: [],
			folders: [{ id: work, name: "Work", rooms: [SCOUT, GONE, TEAM] }],
		};
		muted.set(BUILD, "ada");
		changes = 0;
		const on = await call(server, "PUT", `folders/${work}/mute`, {
			body: { muted: true },
		});
		expect(on.status).toBe(200);
		// The deleted agent's stored place is not a room to mute.
		expect(await on.json()).toEqual({ muted: true, rooms: [SCOUT, TEAM] });
		expect([...muted.keys()].sort()).toEqual([BUILD, SCOUT, TEAM]);
		expect(muted.get(SCOUT)).toBe("owner");
		expect(changes).toBe(1);
		const off = await call(server, "PUT", `folders/${work}/mute`, {
			body: { muted: false },
		});
		expect(await off.json()).toEqual({ muted: false, rooms: [SCOUT, TEAM] });
		// A room outside the folder keeps its own mute.
		expect([...muted.keys()]).toEqual([BUILD]);
		// An empty folder is a quiet no-op.
		store.stored = {
			pins: [],
			folders: [{ id: work, name: "Work", rooms: [] }],
		};
		const none = await call(server, "PUT", `folders/${work}/mute`, {
			body: { muted: true },
		});
		expect(await none.json()).toEqual({ muted: true, rooms: [] });
	});

	test("a folder's mute is refused for a non-owner, another origin, an unknown folder, a wrong body or another method", async () => {
		const server = setup();
		const work = await folder(server, "Work");
		store.stored = {
			pins: [],
			folders: [{ id: work, name: "Work", rooms: [SCOUT] }],
		};
		const path = `folders/${work}/mute`;
		who = { id: "member", tier: "member" as Tier };
		const member = await call(server, "PUT", path, { body: { muted: true } });
		expect(member.status).toBe(403);
		who = { id: "owner", tier: "owner" };
		expect(
			(await call(server, "PUT", path, { body: { muted: true }, origin: null }))
				.status,
		).toBe(403);
		expect(
			(
				await call(server, "PUT", path, {
					body: { muted: true },
					origin: "https://evil.example.test",
				})
			).status,
		).toBe(403);
		const missing = "folders/folder.00000000-0000-4000-8000-000000000000/mute";
		expect(
			(await call(server, "PUT", missing, { body: { muted: true } })).status,
		).toBe(404);
		for (const init of [
			{ body: { muted: "yes" } },
			{ body: {} },
			{ raw: "{nope" },
			{ raw: "[]" },
		])
			expect((await call(server, "PUT", path, init)).status).toBe(400);
		expect(
			(await call(server, "POST", path, { body: { muted: true } })).status,
		).toBe(405);
		expect(
			(await call(server, "PUT", `${path}/extra`, { body: { muted: true } }))
				.status,
		).toBe(404);
		expect(muted.size).toBe(0);
	});
});
