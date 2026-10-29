import { beforeEach, describe, expect, test } from "bun:test";
import type { Tier } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import type { SchedulesView } from "./api-types.ts";
import type { ResolvedRoom } from "./app/rooms.ts";
import { AppApi } from "./app/routes.ts";
import type { AssetBundle } from "./assets.ts";
import { createAuthenticator } from "./auth/authenticator.ts";
import { ConsoleServer } from "./console-server.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import { admit } from "./verifier.ts";
import type { Visitor } from "./visitors.ts";

const assets: AssetBundle = new Map([
	["index.html", { body: Buffer.from("<html></html>"), type: "text/html" }],
]);

const GUIDE = "app:agent.guide";
const row = (id: number, createdById: string, title: string) => ({
	id,
	channel: GUIDE,
	target: "guide",
	title,
	prompt: "p",
	recurrence: { kind: "daily" },
	nextRun: new Date("2026-10-30T08:00:00.000Z"),
	createdById,
	createdByName: createdById,
	createdTier: "member" as Tier,
	createdAt: new Date("2026-10-01T00:00:00.000Z"),
});

let who: { id: string; tier: Tier };
let stored: ReturnType<typeof row>[];
let removed: number[];
let switched: object[];

function setup(modeSwitches = true) {
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
			resolve: async (key: string) =>
				key === GUIDE
					? ({
							key: GUIDE,
							kind: "agent",
							name: "guide",
							displayName: "Guide",
							readOnly: false,
						} satisfies ResolvedRoom)
					: undefined,
			placeable: () => new Set(),
			homeKey: () => GUIDE,
			list: async () => [],
		} as never,
		log: {} as never,
		cards: {} as never,
		uploads: {} as never,
		files: {} as never,
		modes: {
			set: async (_room: string, change: object) => {
				switched.push(change);
				return { yolo: true, longRunning: false };
			},
			peek: () => ({ yolo: false, longRunning: false }),
		} as never,
		modeSwitches,
		conversations: {} as never,
		// A 0.8 schedule names its creator by a user id the backfill made an alias of a principal.
		identity: {
			principal: async (id: string) =>
				id === "legacy-ada" ? { id: "ada" } : undefined,
		} as never,
		directory: {} as never,
		team: {} as never,
		avatars: {} as never,
		mutes: {} as never,
		threads: {} as never,
		layout: {} as never,
		schedules: {
			all: async () => stored,
			get: async (id: number) => stored.find((one) => one.id === id),
			remove: async (id: number) => {
				removed.push(id);
				return true;
			},
		} as never,
		mount: "/console",
		authMode: "verifier",
		changed: () => undefined,
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

const call = (
	server: ConsoleServer,
	method: string,
	path: string,
	body?: unknown,
) =>
	server.handle(
		new Request(`http://host/console/api/${path}`, {
			method,
			headers: { origin: ORIGIN, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);

beforeEach(() => {
	stored = [
		row(1, "ada", "Ada's"),
		row(2, "bea", "Bea's"),
		row(3, "legacy-ada", "Ada's, from 0.8"),
	];
	removed = [];
	switched = [];
	who = { id: "ada", tier: "member" };
});

describe("schedules for a member", () => {
	test("the list holds the member's own, 0.8 ones included, and names no room", async () => {
		const answer = await call(setup(), "GET", "schedules");
		const view = (await answer.json()) as SchedulesView;
		expect(view.schedules.map((s) => s.id)).toEqual([1, 3]);
		expect(view.schedules.every((s) => s.room === undefined)).toBe(true);
	});

	test("the owner sees every schedule, with its room", async () => {
		who = { id: "owner", tier: "owner" };
		const view = (await (
			await call(setup(), "GET", "schedules")
		).json()) as SchedulesView;
		expect(view.schedules.map((s) => s.id)).toEqual([1, 2, 3]);
		expect(view.schedules[0]?.room).toBe(GUIDE);
	});

	test("a member removes their own and finds no one else's", async () => {
		const server = setup();
		expect((await call(server, "DELETE", "schedules/1")).status).toBe(200);
		expect((await call(server, "DELETE", "schedules/3")).status).toBe(200);
		expect((await call(server, "DELETE", "schedules/2")).status).toBe(404);
		expect((await call(server, "DELETE", "schedules/99")).status).toBe(404);
		expect(removed).toEqual([1, 3]);
	});

	test("an owner removes anyone's", async () => {
		who = { id: "owner", tier: "owner" };
		expect((await call(setup(), "DELETE", "schedules/2")).status).toBe(200);
		expect(removed).toEqual([2]);
	});
});

describe("the mode switches", () => {
	const mode = `rooms/${encodeURIComponent(GUIDE)}/mode`;

	test("an owner switches a room's mode", async () => {
		who = { id: "owner", tier: "owner" };
		const answer = await call(setup(), "PUT", mode, { yolo: true });
		expect(answer.status).toBe(200);
		expect(switched).toEqual([{ yolo: true }]);
	});

	test("with modes: false the route is not there, even for an owner, and nothing changes", async () => {
		who = { id: "owner", tier: "owner" };
		expect((await call(setup(false), "PUT", mode, { yolo: true })).status).toBe(
			404,
		);
		expect(switched).toEqual([]);
	});
});
