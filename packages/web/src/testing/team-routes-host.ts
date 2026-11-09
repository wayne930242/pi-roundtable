import { beforeEach, expect, test } from "bun:test";
import type { Agent, AgentGroup, Speaker, Tier } from "pi-roundtable";
import { AgentError } from "pi-roundtable/kit";
import { recordingLogger } from "pi-roundtable/testing";
import type { ApiError, SkillView } from "../api-types.ts";
import { AppApi } from "../app/routes.ts";
import type { AssetBundle } from "../assets.ts";
import { createAuthenticator } from "../auth/authenticator.ts";
import { ConsoleServer } from "../console-server.ts";
import { admit } from "../verifier.ts";
import type { Visitor } from "../visitors.ts";
import { ORIGIN } from "./fixtures.ts";

export const assets: AssetBundle = new Map([
	["index.html", { body: Buffer.from("<html></html>"), type: "text/html" }],
]);

export const agent = (over: Partial<Agent> & { name: string }): Agent => ({
	displayName: over.name,
	prompt: `You are ${over.name}.`,
	avatarPrompt: "",
	status: "active",
	...over,
});

/** What the fakes did, in order. */
export let calls: string[];
export let agents: Map<string, Agent>;
export let groups: Map<string, AgentGroup>;
export let carried: Map<string, string[]>;
export let changes: number;
export let who: { id: string; tier: Tier };
export let speakers: Speaker[];
/** The dispatch threads under each room, by parent. */
export let threadsOf: Map<string, string[]>;
/** Makes the app's cleanup of a deleted room fail, as a database error would. */
export let cleanupFails: boolean;

export const CATALOG: SkillView[] = [
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

export const MODELS = ["m/one", "m/two"];

export function setup(withSkills = true) {
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
						groups: {} as never,
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

/** Resets the stand-in team and host before each test. */
export function teamHostPerTest(): void {
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
}

export const call = (
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
export interface Write {
	method: string;
	path: string;
	body?: unknown;
}

/** Each write must refuse a non-owner, a missing or foreign Origin and an unknown target the same way, and change nothing. */
export function refusesTheSame(label: string, write: Write, unknown: string) {
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

/** Signs the next calls in as this person. */
export function actAs(person: { id: string; tier: Tier }): void {
	who = person;
}

/** Makes the stand-in cleanup fail, or not. */
export function setCleanupFails(fails: boolean): void {
	cleanupFails = fails;
}
