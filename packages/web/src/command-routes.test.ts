import { describe, expect, test } from "bun:test";
import type { ChatCommand, Tier } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import type { RoomCommandsView } from "./api-types.ts";
import type { ResolvedRoom } from "./app/rooms.ts";
import { AppApi } from "./app/routes.ts";
import type { AssetBundle } from "./assets.ts";
import { createAuthenticator } from "./auth/authenticator.ts";
import { ConsoleServer } from "./console-server.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import { admit } from "./verifier.ts";

const assets: AssetBundle = new Map([
	["index.html", { body: Buffer.from("<html></html>"), type: "text/html" }],
]);

const ROOMS: Record<string, ResolvedRoom> = {
	"app:agent.scout": {
		key: "app:agent.scout" as never,
		kind: "agent",
		name: "scout",
		displayName: "Scout",
		readOnly: false,
	},
	"app:group.crew": {
		key: "app:group.crew" as never,
		kind: "group",
		name: "crew",
		displayName: "Crew",
		readOnly: false,
	},
	"app:thread.0b5e7c1a": {
		key: "app:thread.0b5e7c1a" as never,
		kind: "thread",
		name: "thread.0b5e7c1a",
		displayName: "A thread",
		readOnly: true,
	},
};

function setup(
	tier: Tier,
	over: {
		declared?: readonly ChatCommand[];
		withSkills?: boolean;
		asked?: string[];
	} = {},
) {
	const recorder = recordingLogger();
	const { declared = [], withSkills = true, asked = [] } = over;
	const api = new AppApi({
		surface: { surface: "app" } as never,
		rooms: { resolve: async (key: string) => ROOMS[key] } as never,
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
		threads: {} as never,
		mutes: {} as never,
		layout: {} as never,
		chatCommands: () => declared,
		...(withSkills
			? {
					skills: {
						documents: {} as never,
						groups: {} as never,
						catalog: () => [],
						carried: (agent: string) => {
							asked.push(agent);
							return [
								{ name: "writing-skills", description: "Use when writing." },
								{ name: "kit-do", description: "Use when changing source." },
							];
						},
						attach: async () => [],
					},
				}
			: {}),
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
			identify: async () => ({
				visitor: {
					principal: { id: "someone", displayName: "Someone", disabled: false },
					tier,
					speakerId: "someone",
					roles: [],
				},
			}),
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

const commandsOf = (server: ConsoleServer, room: string) =>
	server.handle(
		new Request(
			`http://host/console/api/rooms/${encodeURIComponent(room)}/commands`,
			{ headers: { origin: ORIGIN } },
		),
	);

describe("GET api/rooms/<room>/commands", () => {
	test("an agent's room lists the skills the agent carries, then the declared extension commands", async () => {
		const asked: string[] = [];
		const server = setup("owner", {
			asked,
			declared: [{ name: "stats", description: "Show the stats" }],
		});
		const response = await commandsOf(server, "app:agent.scout");
		expect(response.status).toBe(200);
		expect(((await response.json()) as RoomCommandsView).commands).toEqual([
			{
				name: "skill:writing-skills",
				description: "Use when writing.",
				source: "skill",
			},
			{
				name: "skill:kit-do",
				description: "Use when changing source.",
				source: "skill",
			},
			{
				name: "stats",
				description: "Show the stats",
				source: "extension",
			},
		]);
		expect(asked).toEqual(["scout"]);
	});

	test("nothing is listed that nobody declared: a host with no skills addon and no declaration offers none", async () => {
		const server = setup("owner", { withSkills: false });
		const response = await commandsOf(server, "app:agent.scout");
		expect(((await response.json()) as RoomCommandsView).commands).toEqual([]);
	});

	test("a group's room, a thread and an unknown room offer none or are not found, and ask the registry nothing", async () => {
		const asked: string[] = [];
		const server = setup("owner", {
			asked,
			declared: [{ name: "stats", description: "Show the stats" }],
		});
		for (const room of ["app:group.crew", "app:thread.0b5e7c1a"]) {
			const response = await commandsOf(server, room);
			expect(response.status).toBe(200);
			expect(((await response.json()) as RoomCommandsView).commands).toEqual(
				[],
			);
		}
		expect((await commandsOf(server, "app:agent.nobody")).status).toBe(404);
		expect(asked).toEqual([]);
	});

	test("a member and an admin get the 404 of every owners-only room route, and learn no skill or command name", async () => {
		for (const tier of ["member", "admin"] as const) {
			const server = setup(tier, {
				declared: [{ name: "stats", description: "Show the stats" }],
			});
			const response = await commandsOf(server, "app:agent.scout");
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("kit-do");
			expect((await commandsOf(server, "app:agent.nobody")).status).not.toBe(
				200,
			);
		}
	});

	test("only a GET is answered", async () => {
		const server = setup("owner");
		const response = await server.handle(
			new Request(
				`http://host/console/api/rooms/${encodeURIComponent("app:agent.scout")}/commands`,
				{ method: "POST", headers: { origin: ORIGIN } },
			),
		);
		expect(response.status).toBe(404);
	});
});
