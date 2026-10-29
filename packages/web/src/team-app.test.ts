import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { type ActorFacts, AGENTS, SKILLS } from "pi-roundtable";
import {
	describeDb,
	type TestHost,
	testDatabaseUrl,
	testHost,
} from "pi-roundtable/testing";
import type {
	AgentProfileView,
	AgentSkillsView,
	ApiError,
	ArchiveView,
	GroupProfileView,
	MessagesView,
	RoomsView,
} from "./api-types.ts";
import { admitAs, refuse, type Verdict } from "./verifier.ts";
import { webConsole } from "./web-plugin.ts";

// This suite needs the test database (PG): it boots the host with the agent server and `rooms`.

const ORIGIN = "https://app.example.test";
const ADA_DISCORD = "100000000000000051";
const MEL_DISCORD = "200000000000000052";
const GUILD = "900000000000000751";
const ENTRY_CHANNEL = "900000000000000752";
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

function verifier(request: Request): Verdict {
	const who = request.headers.get("x-actor");
	if (who === "owner") return admitAs(ADA);
	if (who === "member") return admitAs(MEL);
	return refuse("no proxy assertion");
}

interface Booted {
	host: TestHost;
	socket: string;
	stop(): Promise<void>;
}

async function boot(): Promise<Booted> {
	const dataDir = mkdtempSync(join(tmpdir(), "team-app-"));
	const socket = join(dataDir, "public.sock");
	const assets = mkdtempSync(join(tmpdir(), "team-app-page-"));
	writeFileSync(join(assets, "index.html"), "<html>app</html>");
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
		runtime: {
			runTurn: async () => ({ ok: true as const, text: "ok" }),
			steer: async () => false,
			stop: () => false,
			startFresh: async () => undefined,
			deleteConversation: async () => undefined,
			pendingConfirmation: () => undefined,
			heldActions: async () => undefined,
			recentTranscript: async () => [],
		},
		plugins: [
			webConsole({
				verifier,
				origin: ORIGIN,
				dataDir,
				assetDir: assets,
				panes: ["rooms"],
				push: { quietHours: false },
			}),
		],
	});
	return {
		host,
		socket,
		stop: async () => {
			await host.stop();
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}

function call(
	app: Booted,
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
		},
		unix: app.socket,
	} as never);
}

const send = (
	app: Booted,
	method: string,
	path: string,
	body?: unknown,
	init: { who?: string; origin?: string | null } = {},
) =>
	call(app, path, {
		method,
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		...init,
	});

const roomKeys = async (app: Booted): Promise<string[]> =>
	((await (await call(app, "rooms")).json()) as RoomsView).rooms.map(
		(room) => room.key,
	);

describeDb("making, archiving and grouping agents over a real host", () => {
	let app: Booted;
	beforeAll(async () => {
		app = await boot();
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});

	test("an owner makes an agent through the agent server, and its room appears; a member cannot", async () => {
		const body = {
			name: "notes",
			displayName: "Notes",
			prompt: "Keep notes.",
			character: { class: "scribe" },
		};
		expect(
			(await send(app, "POST", "agents", body, { who: "member" })).status,
		).toBe(403);
		expect(
			(await send(app, "POST", "agents", body, { origin: null })).status,
		).toBe(403);
		const made = await send(app, "POST", "agents", body);
		expect(made.status).toBe(201);
		const profile = (await made.json()) as AgentProfileView;
		expect(profile).toMatchObject({
			name: "notes",
			room: "app:agent.notes",
			character: { class: "scribe" },
		});
		const agent = app.host.context.services
			.get(AGENTS)
			.directory.agent("notes");
		expect(agent?.status).toBe("active");
		expect(await roomKeys(app)).toContain("app:agent.notes");
		// The name is permanent and taken.
		const again = await send(app, "POST", "agents", body);
		expect(again.status).toBe(400);
		expect(((await again.json()) as ApiError).error).toContain("taken");
	});

	test("archive, restore and delete follow the agent server's own semantics", async () => {
		const directory = app.host.context.services.get(AGENTS).directory;
		// The coordinator cannot be archived.
		expect((await send(app, "POST", "agents/guide/archive")).status).toBe(400);
		expect((await send(app, "POST", "agents/scout/archive")).status).toBe(200);
		expect(directory.agent("scout")?.status).toBe("archived");
		expect(await roomKeys(app)).not.toContain("app:agent.scout");
		expect((await call(app, "agents/scout")).status).toBe(404);
		const archive = (await (await call(app, "archive")).json()) as ArchiveView;
		expect(archive.entries.map((entry) => entry.name)).toEqual(["scout"]);
		// An active agent is not deleted.
		expect((await send(app, "DELETE", "agents/notes")).status).toBe(400);
		expect((await send(app, "POST", "agents/scout/restore")).status).toBe(200);
		expect(await roomKeys(app)).toContain("app:agent.scout");
		// Delete: archive first, then the name is free.
		expect((await send(app, "POST", "agents/notes/archive")).status).toBe(200);
		expect((await send(app, "DELETE", "agents/notes")).status).toBe(200);
		expect(directory.agent("notes")).toBeUndefined();
		const remade = await send(app, "POST", "agents", {
			name: "notes",
			displayName: "Notes again",
			prompt: "Keep notes.",
		});
		expect(remade.status).toBe(201);
	});

	test("a deleted agent leaves no history, thread or card for a new agent of the same name", async () => {
		const room = "app:agent.ghost";
		const thread = "thread.00000000-0000-4000-8000-000000000001";
		const made = await send(app, "POST", "agents", {
			name: "ghost",
			displayName: "Ghost",
			prompt: "Haunt.",
		});
		expect(made.status).toBe(201);
		const sql = new SQL(testDatabaseUrl, { max: 1 });
		try {
			await sql`INSERT INTO web_threads (id, parent, title) VALUES (${thread}, ${room}, 'Old dispatch')`;
			for (const where of [room, `app:${thread}`])
				await sql`INSERT INTO web_room_messages (room, kind, author_name, text) VALUES (${where}, 'system', 'Notice', 'old line')`;
			expect((await send(app, "DELETE", "agents/ghost")).status).toBe(400);
			expect((await send(app, "POST", "agents/ghost/archive")).status).toBe(
				200,
			);
			expect((await send(app, "DELETE", "agents/ghost")).status).toBe(200);
			const kept: unknown[] = await sql`
				SELECT 1 FROM web_room_messages WHERE room IN (${room}, ${`app:${thread}`})`;
			const threads: unknown[] = await sql`
				SELECT 1 FROM web_threads WHERE parent = ${room}`;
			expect(kept).toEqual([]);
			expect(threads).toEqual([]);
			const again = await send(app, "POST", "agents", {
				name: "ghost",
				displayName: "Ghost again",
				prompt: "Haunt.",
			});
			expect(again.status).toBe(201);
			const history = (await (
				await call(app, `rooms/${encodeURIComponent(room)}/messages`)
			).json()) as MessagesView;
			expect(history.messages).toEqual([]);
			expect(await roomKeys(app)).not.toContain(`app:${thread}`);
		} finally {
			await sql.close();
		}
	});

	test("the skills an agent carries are the host's catalog; built-in ones stay", async () => {
		const view = (await (
			await call(app, "agents/scout/skills")
		).json()) as AgentSkillsView;
		const builtin = view.skills.find((skill) => skill.builtin);
		expect(builtin?.carried).toBe(true);
		const registry = app.host.context.services.get(SKILLS);
		expect(view.skills.map((skill) => skill.name)).toEqual(
			registry.catalog().map((entry) => entry.name),
		);
		expect(
			(
				await send(app, "PUT", "agents/scout/skills", {
					add: ["no-such-skill"],
				})
			).status,
		).toBe(400);
		if (builtin)
			expect(
				(
					await send(app, "PUT", "agents/scout/skills", {
						remove: [builtin.name],
					})
				).status,
			).toBe(400);
	});

	test("a group is made, renamed, archived, restored and deleted", async () => {
		const made = await send(app, "POST", "groups", {
			name: "duo",
			displayName: "Duo",
			members: ["guide", "scout"],
			host: "scout",
		});
		expect(made.status).toBe(201);
		expect((await made.json()) as GroupProfileView).toMatchObject({
			room: "app:group.duo",
			members: ["guide", "scout"],
			host: "scout",
		});
		expect(await roomKeys(app)).toContain("app:group.duo");
		const renamed = await send(app, "PATCH", "groups/duo", {
			displayName: "Pair",
			host: "guide",
		});
		expect((await renamed.json()) as GroupProfileView).toMatchObject({
			displayName: "Pair",
			host: "guide",
		});
		expect((await send(app, "POST", "groups/duo/archive")).status).toBe(200);
		expect(await roomKeys(app)).not.toContain("app:group.duo");
		expect((await send(app, "POST", "groups/duo/restore")).status).toBe(200);
		expect(await roomKeys(app)).toContain("app:group.duo");
		expect((await send(app, "DELETE", "groups/duo")).status).toBe(400);
		await send(app, "POST", "groups/duo/archive");
		expect((await send(app, "DELETE", "groups/duo")).status).toBe(200);
		expect(
			app.host.context.services.get(AGENTS).directory.group("duo"),
		).toBeUndefined();
	});
});
