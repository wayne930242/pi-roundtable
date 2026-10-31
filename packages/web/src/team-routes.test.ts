import { beforeEach, describe, expect, test } from "bun:test";
import type { Agent, AgentGroup, Speaker, Tier } from "pi-roundtable";
import { AgentError } from "pi-roundtable/kit";
import { recordingLogger } from "pi-roundtable/testing";
import type {
	AgentProfileView,
	AgentSkillsView,
	ApiError,
	ArchiveView,
	CharacterRefusal,
	GroupProfileView,
	SkillView,
} from "./api-types.ts";
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

const agent = (over: Partial<Agent> & { name: string }): Agent => ({
	displayName: over.name,
	prompt: `You are ${over.name}.`,
	avatarPrompt: "",
	status: "active",
	...over,
});

/** What the fakes did, in order. */
let calls: string[];
let agents: Map<string, Agent>;
let groups: Map<string, AgentGroup>;
let carried: Map<string, string[]>;
let changes: number;
let who: { id: string; tier: Tier };
let speakers: Speaker[];
/** The dispatch threads under each room, by parent. */
let threadsOf: Map<string, string[]>;
/** Makes the app's cleanup of a deleted room fail, as a database error would. */
let cleanupFails: boolean;

const CATALOG: SkillView[] = [
	{
		name: "writing-skills",
		source: { kind: "builtin" },
		description: "Use when writing a skill.",
		groups: [],
		carriers: [],
	},
	{
		name: "kit-do",
		source: { kind: "linked", repo: "acme/kit", path: "skills/kit-do" },
		description: "Use when changing source.",
		groups: [],
		carriers: [],
	},
	{
		name: "broken",
		source: { kind: "written" },
		missing: "file not found",
		groups: [],
		carriers: [],
	},
];

const MODELS = ["m/one", "m/two"];

function setup(withSkills = true) {
	const recorder = recordingLogger();
	const visitor = (): Visitor => ({
		principal: { id: who.id, displayName: who.id, disabled: false },
		tier: who.tier,
		speakerId: who.id,
		roles: [],
	});
	const directory = {
		agent: (name: string) => agents.get(name),
		agents: () => [...agents.values()],
		group: (name: string) => groups.get(name),
		groups: () => [...groups.values()],
	};
	const need = (name: string, status?: "active" | "archived") => {
		const target = agents.get(name) ?? groups.get(name);
		if (!target) throw new AgentError(`There is no agent or group "${name}".`);
		if (status && target.status !== status)
			throw new AgentError(
				status === "active"
					? `"${name}" is already archived.`
					: `"${name}" is not archived.`,
			);
		return target;
	};
	const team = {
		update: async () => "updated",
		dress: async () => {
			throw new Error("unused");
		},
		modelOf: () => ({ model: "m/one", thinking: "medium" as const }),
		createAgent: async (
			speaker: Speaker,
			input: {
				name: string;
				displayName: string;
				prompt: string;
				model?: string;
				thinking?: string;
				task?: string;
				openIn?: string;
				skills?: string[];
			},
		) => {
			speakers.push(speaker);
			if (agents.has(input.name) || groups.has(input.name))
				throw new AgentError(`The name "${input.name}" is taken.`);
			if (input.model && !MODELS.includes(input.model))
				throw new AgentError(`cannot run ${input.model}`);
			const made = agent({
				name: input.name,
				displayName: input.displayName,
				prompt: input.prompt,
				...(input.model ? { model: input.model } : {}),
			});
			agents.set(made.name, made);
			if (input.skills) carried.set(made.name, input.skills);
			calls.push(
				`createAgent ${input.name} task=${input.task ?? "-"} in=${input.openIn ?? "-"} skills=${(input.skills ?? []).join("+") || "-"}`,
			);
			return made;
		},
		archive: async (caller: unknown, name: string) => {
			if (name === "boss")
				throw new AgentError("The coordinator cannot be archived.");
			const target = need(name, "active");
			target.status = "archived";
			calls.push(
				`archive ${name} caller=${caller === undefined ? "none" : "?"}`,
			);
			return "Archived";
		},
		restore: async (name: string) => {
			need(name, "archived").status = "active";
			calls.push(`restore ${name}`);
			return "Restored";
		},
		remove: async (name: string, cleanup?: () => Promise<void>) => {
			need(name, "archived");
			await cleanup?.();
			agents.delete(name);
			groups.delete(name);
			calls.push(`remove ${name}`);
			return "Deleted";
		},
		createGroup: async (input: {
			name: string;
			displayName: string;
			members: string[];
			host?: string;
		}) => {
			if (input.members.length < 2)
				throw new AgentError("A group has 2 to 8 different members.");
			for (const member of input.members) need(member, "active");
			groups.set(input.name, {
				name: input.name,
				displayName: input.displayName,
				members: input.members,
				host: input.host ?? input.members[0] ?? "",
				status: "active",
			});
			calls.push(`createGroup ${input.name}`);
			return "Created";
		},
		updateGroup: async (
			name: string,
			change: { displayName?: string; members?: string[]; host?: string },
		) => {
			const group = groups.get(name);
			if (group?.status !== "active")
				throw new AgentError(`There is no active group "${name}".`);
			if (change.members && change.members.length < 2)
				throw new AgentError("A group has 2 to 8 different members.");
			Object.assign(group, change);
			calls.push(`updateGroup ${name} ${JSON.stringify(change)}`);
			return "Updated";
		},
	};
	const api = new AppApi({
		surface: { surface: "app" } as never,
		rooms: { avatarOf: () => "/console/avatars/x.png" } as never,
		log: {
			removeRoom: async (room: string) => {
				if (cleanupFails) throw new Error("the database is gone");
				calls.push(`forget log ${room}`);
				return 0;
			},
		} as never,
		cards: {
			removeRoom: async (room: string) => {
				calls.push(`forget cards ${room}`);
			},
		} as never,
		uploads: {} as never,
		files: {} as never,
		modes: {
			forget: async (room: string) => {
				calls.push(`modes reset ${room}`);
			},
		} as never,
		conversations: {} as never,
		identity: { principal: async () => undefined },
		directory: directory as never,
		team: team as never,
		avatars: {} as never,
		threads: {
			under: async (parent: string) =>
				(threadsOf.get(parent) ?? []).map((id) => ({ id, parent })),
			removeUnder: async (parent: string) => {
				if (!threadsOf.delete(parent)) return 0;
				calls.push(`forget threads ${parent}`);
				return 1;
			},
		} as never,
		mutes: {
			set: async (room: string, muted: boolean) => {
				calls.push(`mute ${room} ${muted}`);
			},
		} as never,
		layout: {
			forget: async (room: string) => {
				calls.push(`forget layout ${room}`);
			},
		} as never,
		...(withSkills
			? {
					skills: {
						documents: {} as never,
						catalog: () =>
							CATALOG.map((entry) => ({
								...entry,
								carriers: [...carried.entries()].flatMap(([name, list]) =>
									list.includes(entry.name) ? [name] : [],
								),
							})),
						attach: async (
							name: string,
							add: readonly string[],
							remove: readonly string[],
						) => {
							const unknown = [...add].filter(
								(one) => !CATALOG.some((entry) => entry.name === one),
							);
							if (unknown.length)
								throw new AgentError(`Unknown skills: ${unknown.join(", ")}.`);
							if (remove.includes("writing-skills"))
								throw new AgentError("writing-skills is built in.");
							const next = [
								...new Set([...(carried.get(name) ?? []), ...add]),
							].filter((one) => !remove.includes(one));
							carried.set(name, next);
							calls.push(
								`attach ${name} +${add.join(",")} -${remove.join(",")}`,
							);
							return next;
						},
					},
				}
			: {}),
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
	calls = [];
	changes = 0;
	speakers = [];
	cleanupFails = false;
	threadsOf = new Map();
	who = { id: "owner", tier: "owner" };
	agents = new Map([
		["boss", agent({ name: "boss", displayName: "Boss" })],
		["scout", agent({ name: "scout", displayName: "Scout" })],
		["infra", agent({ name: "infra", displayName: "Infra" })],
		["old", agent({ name: "old", displayName: "Old", status: "archived" })],
	]);
	groups = new Map([
		[
			"crew",
			{
				name: "crew",
				displayName: "Crew",
				members: ["boss", "scout"],
				host: "boss",
				status: "active" as const,
			},
		],
		[
			"past",
			{
				name: "past",
				displayName: "Past",
				members: ["scout", "infra"],
				host: "scout",
				status: "archived" as const,
			},
		],
	]);
	carried = new Map();
});

const call = (
	server: ConsoleServer,
	method: string,
	path: string,
	init: { body?: unknown; origin?: string | null; raw?: string } = {},
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

/** The request of every write, for the refusals every one of them shares. */
interface Write {
	method: string;
	path: string;
	body?: unknown;
}

/** Each write must refuse a non-owner, a missing or foreign Origin and an unknown target the same way, and change nothing. */
function refusesTheSame(label: string, write: Write, unknown: string) {
	test(`${label}: a member, a request from elsewhere and an unknown target are refused, and nothing changes`, async () => {
		const server = setup();
		who = { id: "member", tier: "member" };
		const asMember = await call(server, write.method, write.path, {
			...(write.body !== undefined ? { body: write.body } : {}),
		});
		expect(asMember.status).toBe(403);
		expect(((await asMember.json()) as ApiError).error).toBe(
			"Only an owner may do this.",
		);
		who = { id: "owner", tier: "owner" };
		for (const origin of [null, "https://evil.example.test"]) {
			const response = await call(server, write.method, write.path, {
				origin,
				...(write.body !== undefined ? { body: write.body } : {}),
			});
			expect(response.status).toBe(403);
		}
		const missing = await call(server, write.method, unknown, {
			...(write.body !== undefined ? { body: write.body } : {}),
		});
		expect(missing.status).toBe(404);
		expect(calls).toEqual([]);
		expect(changes).toBe(0);
	});
}

describe("a member learns nothing of the team from a write", () => {
	test("the owner check comes before any lookup, so a state or name that would be a 400 or 404 is a 403", async () => {
		const server = setup();
		who = { id: "member", tier: "member" };
		const writes: [string, string][] = [
			["DELETE", "agents/nobody"],
			["DELETE", "agents/scout"],
			["POST", "agents/scout/restore"],
			["POST", "agents/nobody/restore"],
			["DELETE", "groups/nobody"],
			["DELETE", "groups/crew"],
			["POST", "groups/crew/restore"],
			["PATCH", "groups/past"],
		];
		for (const [method, path] of writes) {
			const response = await call(server, method, path, { body: {} });
			expect([method, path, response.status]).toEqual([method, path, 403]);
		}
		expect(calls).toEqual([]);
		// The same requests as the owner are the 400s and 404s the state calls for.
		who = { id: "owner", tier: "owner" };
		expect((await call(server, "DELETE", "agents/nobody")).status).toBe(404);
		expect((await call(server, "POST", "agents/scout/restore")).status).toBe(
			400,
		);
	});
});

describe("POST api/agents", () => {
	const body = {
		name: "notes",
		displayName: "Notes",
		prompt: "Keep notes.",
		model: "m/two",
		task: "  Say hi.  ",
		skills: ["kit-do"],
		character: { class: "scribe" },
	};

	test("a member and a request from elsewhere are refused", async () => {
		const server = setup();
		who = { id: "member", tier: "member" };
		expect((await call(server, "POST", "agents", { body })).status).toBe(403);
		who = { id: "owner", tier: "owner" };
		expect(
			(await call(server, "POST", "agents", { body, origin: null })).status,
		).toBe(403);
		expect(agents.has("notes")).toBe(false);
		expect(changes).toBe(0);
	});

	test("makes the agent as the owner, with the trimmed task, and answers its profile", async () => {
		const response = await call(setup(), "POST", "agents", { body });
		expect(response.status).toBe(201);
		const profile = (await response.json()) as AgentProfileView;
		expect(profile).toMatchObject({
			name: "notes",
			displayName: "Notes",
			room: "app:agent.notes",
			model: "m/two",
		});
		expect(calls).toEqual([
			"createAgent notes task=Say hi. in=app skills=kit-do",
		]);
		expect(speakers[0]).toMatchObject({ tier: "owner", principalId: "owner" });
		expect(changes).toBe(1);
	});

	test("an empty task and no skills are left out", async () => {
		const response = await call(setup(), "POST", "agents", {
			body: {
				name: "bare",
				displayName: "Bare",
				prompt: "Be.",
				task: "  ",
				skills: [],
			},
		});
		expect(response.status).toBe(201);
		expect(calls).toEqual(["createAgent bare task=- in=app skills=-"]);
	});

	test("refuses a bad body with 400 and makes nothing", async () => {
		const server = setup();
		const bads: unknown[] = [
			{},
			{ ...body, name: 7 },
			{ ...body, displayName: "" },
			{ ...body, prompt: undefined },
			{ ...body, model: 1 },
			{ ...body, task: ["x"] },
			{ ...body, skills: "kit-do" },
			{ ...body, skills: [1] },
			{ ...body, character: "knight" },
			{ ...body, character: [] },
		];
		for (const one of bads)
			expect((await call(server, "POST", "agents", { body: one })).status).toBe(
				400,
			);
		expect(
			(await call(server, "POST", "agents", { raw: "{not json" })).status,
		).toBe(400);
		expect((await call(server, "POST", "agents", { raw: "[1]" })).status).toBe(
			400,
		);
		expect(calls).toEqual([]);
	});

	test("names the field of a look that is not usable", async () => {
		const response = await call(setup(), "POST", "agents", {
			body: { ...body, character: { class: "nope" } },
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as CharacterRefusal).field).toBe("class");
		const unknown = await call(setup(), "POST", "agents", {
			body: { ...body, character: { wings: 2 } },
		});
		expect(((await unknown.json()) as CharacterRefusal).field).toBe("wings");
		expect(calls).toEqual([]);
	});

	test("the agent server's refusals are 400s with its words", async () => {
		const server = setup();
		const taken = await call(server, "POST", "agents", {
			body: { ...body, name: "scout" },
		});
		expect(taken.status).toBe(400);
		expect(((await taken.json()) as ApiError).error).toContain("taken");
		const model = await call(server, "POST", "agents", {
			body: { ...body, model: "other/model" },
		});
		expect(model.status).toBe(400);
		expect(agents.has("notes")).toBe(false);
		expect(changes).toBe(0);
	});

	test("other methods on the collection are 405", async () => {
		expect((await call(setup(), "DELETE", "agents")).status).toBe(405);
	});
});

describe("agent archive, restore and delete", () => {
	refusesTheSame(
		"archive",
		{ method: "POST", path: "agents/scout/archive" },
		"agents/nobody/archive",
	);
	refusesTheSame(
		"restore",
		{ method: "POST", path: "agents/old/restore" },
		"agents/nobody/restore",
	);
	refusesTheSame(
		"delete",
		{ method: "DELETE", path: "agents/old" },
		"agents/nobody",
	);

	test("archives an agent through the team with no calling agent, and the room leaves the list", async () => {
		const response = await call(setup(), "POST", "agents/scout/archive");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(calls).toEqual(["archive scout caller=none"]);
		expect(agents.get("scout")?.status).toBe("archived");
		expect(changes).toBe(1);
		// An archived agent is no active agent: it cannot be archived again, nor read or edited.
		const again = await call(setup(), "POST", "agents/scout/archive");
		expect(again.status).toBe(404);
		expect((await call(setup(), "GET", "agents/scout")).status).toBe(404);
		expect(
			(await call(setup(), "PATCH", "agents/scout", { body: { prompt: "x" } }))
				.status,
		).toBe(404);
	});

	test("the coordinator's refusal is a 400", async () => {
		const response = await call(setup(), "POST", "agents/boss/archive");
		expect(response.status).toBe(400);
		expect(((await response.json()) as ApiError).error).toBe(
			"The coordinator cannot be archived.",
		);
		expect(agents.get("boss")?.status).toBe("active");
		expect(changes).toBe(0);
	});

	test("restores an archived agent and answers its profile; an active one is a 400", async () => {
		const response = await call(setup(), "POST", "agents/old/restore");
		expect(response.status).toBe(200);
		expect(((await response.json()) as AgentProfileView).name).toBe("old");
		expect(agents.get("old")?.status).toBe("active");
		expect(changes).toBe(1);
		const active = await call(setup(), "POST", "agents/scout/restore");
		expect(active.status).toBe(400);
		expect(calls).toEqual(["restore old"]);
	});

	test("deletes only an archived agent, and clears what the app kept of its room, its pin and folder place included", async () => {
		const server = setup();
		const active = await call(server, "DELETE", "agents/scout");
		expect(active.status).toBe(400);
		expect(agents.has("scout")).toBe(true);
		expect(calls).toEqual([]);
		const response = await call(server, "DELETE", "agents/old");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(agents.has("old")).toBe(false);
		expect(calls).toEqual([
			"forget log app:agent.old",
			"forget cards app:agent.old",
			"mute app:agent.old false",
			"forget layout app:agent.old",
			"modes reset app:agent.old",
			"remove old",
		]);
		expect(changes).toBe(1);
	});

	test("deleting an agent also deletes its dispatch threads, with their messages and cards", async () => {
		const server = setup();
		threadsOf.set("app:agent.old", ["thread.a", "thread.b"]);
		const response = await call(server, "DELETE", "agents/old");
		expect(response.status).toBe(200);
		expect(calls).toEqual([
			"forget log app:thread.a",
			"forget cards app:thread.a",
			"forget log app:thread.b",
			"forget cards app:thread.b",
			"forget threads app:agent.old",
			"forget log app:agent.old",
			"forget cards app:agent.old",
			"mute app:agent.old false",
			"forget layout app:agent.old",
			"modes reset app:agent.old",
			"remove old",
		]);
		expect(threadsOf.has("app:agent.old")).toBe(false);
	});

	test("a cleanup that fails halfway leaves the agent deletable, and the retry finishes", async () => {
		const server = setup();
		cleanupFails = true;
		const failed = await call(server, "DELETE", "agents/old");
		expect(failed.status).toBe(500);
		expect(agents.has("old")).toBe(true);
		expect(calls).toEqual([]);
		cleanupFails = false;
		const retried = await call(server, "DELETE", "agents/old");
		expect(retried.status).toBe(200);
		expect(agents.has("old")).toBe(false);
		expect(calls.at(-1)).toBe("remove old");
	});

	test("a group's name is no agent's", async () => {
		const server = setup();
		expect((await call(server, "POST", "agents/crew/archive")).status).toBe(
			404,
		);
		expect((await call(server, "DELETE", "agents/past")).status).toBe(404);
		expect(calls).toEqual([]);
	});
});

describe("agent skills", () => {
	refusesTheSame(
		"change",
		{ method: "PUT", path: "agents/scout/skills", body: { add: ["kit-do"] } },
		"agents/nobody/skills",
	);

	test("lists the host's skills with what the agent carries; built-in skills are always carried", async () => {
		carried.set("scout", ["kit-do"]);
		const response = await call(setup(), "GET", "agents/scout/skills");
		expect(response.status).toBe(200);
		const view = (await response.json()) as AgentSkillsView;
		expect(view.skills).toEqual([
			{
				name: "writing-skills",
				description: "Use when writing a skill.",
				source: "builtin",
				builtin: true,
				carried: true,
			},
			{
				name: "kit-do",
				description: "Use when changing source.",
				source: "linked",
				builtin: false,
				carried: true,
			},
			{
				name: "broken",
				source: "written",
				builtin: false,
				carried: false,
				missing: "file not found",
			},
		]);
		// Another agent carries none of the registered ones.
		const other = (await (
			await call(setup(), "GET", "agents/infra/skills")
		).json()) as AgentSkillsView;
		expect(other.skills.map((skill) => skill.carried)).toEqual([
			true,
			false,
			false,
		]);
	});

	test("a member may not read them, and an unknown or archived agent is a 404", async () => {
		const server = setup();
		who = { id: "member", tier: "member" };
		expect((await call(server, "GET", "agents/scout/skills")).status).toBe(403);
		who = { id: "owner", tier: "owner" };
		expect((await call(server, "GET", "agents/nobody/skills")).status).toBe(
			404,
		);
		expect((await call(server, "GET", "agents/old/skills")).status).toBe(404);
	});

	test("adds and removes in one change and answers the list again", async () => {
		carried.set("scout", ["kit-do"]);
		const server = setup();
		const response = await call(server, "PUT", "agents/scout/skills", {
			body: { remove: ["kit-do"] },
		});
		expect(response.status).toBe(200);
		const view = (await response.json()) as AgentSkillsView;
		expect(view.skills.find((skill) => skill.name === "kit-do")?.carried).toBe(
			false,
		);
		await call(server, "PUT", "agents/scout/skills", {
			body: { add: ["kit-do"], remove: [] },
		});
		expect(calls).toEqual(["attach scout + -kit-do", "attach scout +kit-do -"]);
		expect(changes).toBe(2);
	});

	test("an unknown or built-in name refuses the whole change with 400", async () => {
		const server = setup();
		for (const body of [
			{ add: ["kit-do", "nope"] },
			{ remove: ["writing-skills"] },
		]) {
			const response = await call(server, "PUT", "agents/scout/skills", {
				body,
			});
			expect(response.status).toBe(400);
		}
		expect(carried.get("scout")).toBeUndefined();
		expect(changes).toBe(0);
	});

	test("a bad body is a 400", async () => {
		const server = setup();
		for (const body of [{}, { add: [] }, { add: "kit-do" }, { remove: [3] }])
			expect(
				(await call(server, "PUT", "agents/scout/skills", { body })).status,
			).toBe(400);
		expect(calls).toEqual([]);
	});

	test("a host without the skills addon answers 404", async () => {
		const server = setup(false);
		expect((await call(server, "GET", "agents/scout/skills")).status).toBe(404);
		expect(
			(
				await call(server, "PUT", "agents/scout/skills", {
					body: { add: ["kit-do"] },
				})
			).status,
		).toBe(404);
	});
});

describe("groups", () => {
	const body = {
		name: "duo",
		displayName: "Duo",
		members: ["scout", "infra"],
		host: "infra",
	};
	refusesTheSame(
		"create",
		{ method: "POST", path: "groups", body },
		"groups/nobody",
	);
	refusesTheSame(
		"rename",
		{ method: "PATCH", path: "groups/crew", body: { displayName: "Team" } },
		"groups/nobody",
	);
	refusesTheSame(
		"archive",
		{ method: "POST", path: "groups/crew/archive" },
		"groups/nobody/archive",
	);
	refusesTheSame(
		"restore",
		{ method: "POST", path: "groups/past/restore" },
		"groups/nobody/restore",
	);
	refusesTheSame(
		"delete",
		{ method: "DELETE", path: "groups/past" },
		"groups/nobody",
	);

	test("creates a group of active agents and answers it; the host is the first member by default", async () => {
		const server = setup();
		const response = await call(server, "POST", "groups", { body });
		expect(response.status).toBe(201);
		expect((await response.json()) as GroupProfileView).toEqual({
			name: "duo",
			displayName: "Duo",
			members: ["scout", "infra"],
			host: "infra",
			room: "app:group.duo",
		});
		const bare = await call(server, "POST", "groups", {
			body: { name: "trio", displayName: "Trio", members: ["boss", "infra"] },
		});
		expect(((await bare.json()) as GroupProfileView).host).toBe("boss");
		expect(calls).toEqual(["createGroup duo", "createGroup trio"]);
		expect(changes).toBe(2);
	});

	test("refuses a bad body (400) and the team's refusals (400) without making a group", async () => {
		const server = setup();
		for (const one of [
			{},
			{ ...body, name: 3 },
			{ ...body, displayName: "" },
			{ ...body, members: "scout" },
			{ ...body, members: undefined },
			{ ...body, members: [1, 2] },
			{ ...body, host: 4 },
		])
			expect((await call(server, "POST", "groups", { body: one })).status).toBe(
				400,
			);
		// Too few members, and a member that is archived.
		for (const members of [["scout"], ["scout", "old"], ["scout", "ghost"]])
			expect(
				(await call(server, "POST", "groups", { body: { ...body, members } }))
					.status,
			).toBe(400);
		expect(groups.has("duo")).toBe(false);
		expect(calls).toEqual([]);
	});

	test("reads a group; only an owner may, and an archived or unknown one is a 404", async () => {
		const server = setup();
		const view = (await (
			await call(server, "GET", "groups/crew")
		).json()) as GroupProfileView;
		expect(view).toMatchObject({
			name: "crew",
			members: ["boss", "scout"],
			host: "boss",
			room: "app:group.crew",
		});
		who = { id: "member", tier: "member" };
		expect((await call(server, "GET", "groups/crew")).status).toBe(403);
		who = { id: "owner", tier: "owner" };
		expect((await call(server, "GET", "groups/past")).status).toBe(404);
		expect((await call(server, "GET", "groups/nobody")).status).toBe(404);
	});

	test("renames, changes the members and chooses the host", async () => {
		const server = setup();
		const response = await call(server, "PATCH", "groups/crew", {
			body: {
				displayName: "Team",
				members: ["boss", "scout", "infra"],
				host: "infra",
			},
		});
		expect(response.status).toBe(200);
		expect((await response.json()) as GroupProfileView).toMatchObject({
			displayName: "Team",
			members: ["boss", "scout", "infra"],
			host: "infra",
		});
		expect(changes).toBe(1);
	});

	test("a bad patch is a 400 and changes nothing", async () => {
		const server = setup();
		for (const one of [
			{},
			{ displayName: 1 },
			{ members: "boss" },
			{ members: ["boss"] },
			{ host: 2 },
		])
			expect(
				(await call(server, "PATCH", "groups/crew", { body: one })).status,
			).toBe(400);
		expect(groups.get("crew")?.members).toEqual(["boss", "scout"]);
		expect(changes).toBe(0);
	});

	test("archives, restores and deletes a group like an agent", async () => {
		const server = setup();
		expect((await call(server, "POST", "groups/crew/archive")).status).toBe(
			200,
		);
		expect(groups.get("crew")?.status).toBe("archived");
		// Archived, it is no active group.
		expect((await call(server, "POST", "groups/crew/archive")).status).toBe(
			404,
		);
		const restored = await call(server, "POST", "groups/past/restore");
		expect(restored.status).toBe(200);
		expect(((await restored.json()) as GroupProfileView).name).toBe("past");
		expect((await call(server, "POST", "groups/past/restore")).status).toBe(
			400,
		);
		expect((await call(server, "DELETE", "groups/past")).status).toBe(400);
		const deleted = await call(server, "DELETE", "groups/crew");
		expect(deleted.status).toBe(200);
		expect(groups.has("crew")).toBe(false);
		expect(calls).toEqual([
			"archive crew caller=none",
			"restore past",
			"forget log app:group.crew",
			"forget cards app:group.crew",
			"mute app:group.crew false",
			"forget layout app:group.crew",
			"modes reset app:group.crew",
			"remove crew",
		]);
	});

	test("an agent's name is no group's", async () => {
		const server = setup();
		expect((await call(server, "GET", "groups/scout")).status).toBe(404);
		expect((await call(server, "DELETE", "groups/old")).status).toBe(404);
	});
});

describe("GET api/archive", () => {
	test("lists archived agents and groups, by name, for an owner only", async () => {
		const server = setup();
		const view = (await (
			await call(server, "GET", "archive")
		).json()) as ArchiveView;
		expect(view.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
			"agent:old",
			"group:past",
		]);
		expect(view.entries[0]?.avatar).toBe("/console/avatars/x.png");
		expect(view.entries[1]?.members).toEqual(["scout", "infra"]);
		who = { id: "member", tier: "member" };
		expect((await call(server, "GET", "archive")).status).toBe(403);
		who = { id: "owner", tier: "owner" };
		expect((await call(server, "POST", "archive")).status).toBe(404);
	});
});
