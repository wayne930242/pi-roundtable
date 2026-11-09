import { beforeEach, expect, test } from "bun:test";
import type {
	PromptDocumentView,
	PromptVersion,
	SkillDocument,
	SkillVersion,
	Tier,
} from "pi-roundtable";
import { PromptConflictError, SkillConflictError } from "pi-roundtable";
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

// The routes that edit the main prompts and the skills' SKILL.md files: the owner-only rules every
// write shares, the 409 of a stale save, and the words of a refusal. The core's own behavior (the
// frontmatter rules, the history) has its tests in the core; here the registry is a stand-in.

export const assets: AssetBundle = new Map([
	["index.html", { body: Buffer.from("<html></html>"), type: "text/html" }],
]);

export const HASH = (n: number) => String(n).repeat(64).slice(0, 64);
export const AT = new Date("2026-10-29T08:00:00.000Z");

export let who: { id: string; name: string; tier: Tier };
export let calls: string[];
export let documents: Map<string, PromptDocumentView>;
export let history: PromptVersion[];
export let agentHistory: PromptVersion[];
export let skillDocs: Map<string, SkillDocument>;
export let skillVersions: SkillVersion[];
export let skillGroups: {
	name: string;
	description: string;
	skills: string[];
}[];
/** Set by a test: the next save throws this. */
export let saveFails: Error | undefined;

export const document = (
	id: string,
	over: Partial<PromptDocumentView> = {},
): PromptDocumentView => ({
	id,
	label: `${id} prompt`,
	text: "File text.",
	fileText: "File text.",
	overridden: false,
	differs: false,
	maxChars: 20_000,
	...over,
});

export const skillText = (body: string) =>
	`---\nname: daily-notes\ndescription: "Use when keeping notes."\n---\n\n${body}\n`;

export const CATALOG: SkillView[] = [
	{
		name: "daily-notes",
		source: { kind: "written" },
		description: "Use when keeping notes.",
		groups: [],
		carriers: [],
	},
	{
		name: "kit-do",
		source: { kind: "linked", repo: "acme/kit", path: "skills/kit-do" },
		description: "Use when changing source.",
		groups: [],
		carriers: ["scout"],
	},
	{
		name: "writing-skills",
		source: { kind: "builtin" },
		description: "Use when writing skills.",
		groups: [],
		carriers: [],
	},
	{
		name: "tidy",
		source: { kind: "written" },
		description: "Use when tidying.",
		groups: [],
		carriers: [],
	},
];

export function setup(
	options: { prompts?: boolean; skills?: boolean } = {
		prompts: true,
		skills: true,
	},
) {
	const recorder = recordingLogger();
	const visitor = (): Visitor => ({
		principal: { id: who.id, displayName: who.name, disabled: false },
		tier: who.tier,
		speakerId: who.id,
		roles: [],
	});
	const prompts = {
		list: () => [...documents.values()],
		get: (id: string) => documents.get(id),
		set: async (id: string, text: string, by: string, base?: string) => {
			if (saveFails) throw saveFails;
			const current = documents.get(id);
			if (!current)
				throw new AgentError(`There is no prompt document "${id}".`);
			if (base !== undefined && base !== current.text)
				throw new PromptConflictError(current);
			if (!text.trim())
				throw new AgentError(
					"A prompt document must have 1 to 20000 characters.",
				);
			calls.push(`set ${id} by ${by}`);
			const next = {
				...current,
				text,
				overridden: true,
				differs: text !== current.fileText,
				override: { by, at: AT },
			};
			documents.set(id, next);
			return next;
		},
		revert: async (id: string, by: string, base?: string) => {
			const current = documents.get(id);
			if (current && base !== undefined && base !== current.text)
				throw new PromptConflictError(current);
			if (!current?.overridden)
				throw new AgentError(`"${id}" has no override.`);
			calls.push(`revert ${id} by ${by}`);
			const next = document(id, {
				fileText: current.fileText,
				text: current.fileText,
			});
			documents.set(id, next);
			return next;
		},
		history: async () => history,
	};
	const documentsApi = {
		document: async (name: string) => {
			const found = skillDocs.get(name);
			if (!found) throw new AgentError(`There is no skill "${name}".`);
			return found;
		},
		saveDocument: async (
			name: string,
			text: string,
			baseHash: string,
			by: string,
		) => {
			if (saveFails) throw saveFails;
			const found = skillDocs.get(name);
			if (!found) throw new AgentError(`There is no skill "${name}".`);
			if (!found.writable)
				throw new AgentError(`${name} is linked and is read-only here.`);
			if (found.hash !== baseHash) throw new SkillConflictError(found);
			calls.push(`save ${name} by ${by}`);
			const next = { ...found, text, hash: HASH(text.length) };
			skillDocs.set(name, next);
			return next;
		},
		createDocument: async (text: string, by: string) => {
			if (!text.startsWith("---"))
				throw new AgentError("A SKILL.md starts with frontmatter.");
			calls.push(`create by ${by}`);
			const made: SkillDocument = {
				name: "fresh",
				source: { kind: "written" },
				text,
				hash: HASH(text.length),
				writable: true,
			};
			skillDocs.set("fresh", made);
			return made;
		},
		documentHistory: async () => skillVersions,
		delete: async (name: string) => {
			const found = skillDocs.get(name);
			if (!found) throw new AgentError(`There is no skill "${name}".`);
			if (!found.writable)
				throw new AgentError(`${name} is linked and is read-only here.`);
			calls.push(`delete ${name}`);
			skillDocs.delete(name);
			return `Removed skill ${name}; detached from agents scout.`;
		},
	};
	const groupsApi = {
		groups: () => skillGroups.map((group) => ({ ...group })),
		setGroup: async (
			name: string,
			description: string,
			skills: readonly string[],
		) => {
			const unknown = skills.filter(
				(skill) => !CATALOG.some((entry) => entry.name === skill),
			);
			if (unknown.length > 0)
				throw new AgentError(`Unknown skills: ${unknown.join(", ")}.`);
			calls.push(`set group ${name}: ${skills.join(", ")}`);
			const existed = skillGroups.some((group) => group.name === name);
			skillGroups = [
				...skillGroups.filter((group) => group.name !== name),
				{ name, description, skills: [...skills] },
			];
			return `${existed ? "Replaced" : "Created"} skill group ${name}.`;
		},
		deleteGroup: async (name: string) => {
			calls.push(`delete group ${name}`);
			skillGroups = skillGroups.filter((group) => group.name !== name);
			return `Deleted skill group ${name}; its skills are untouched.`;
		},
	};
	const team = {
		update: async (name: string, _change: unknown, by?: string) =>
			calls.push(`update ${name} by ${by ?? "-"}`) && "updated",
		promptHistory: async (name: string) => {
			if (name === "nobody") throw new AgentError("There is no agent.");
			return agentHistory;
		},
		modelOf: () => ({ model: "m/one", thinking: "medium" as const }),
		helpersOn: () => false,
	};
	const api = new AppApi({
		surface: { surface: "app" } as never,
		rooms: { avatarOf: () => "/console/avatars/x.png" } as never,
		log: {} as never,
		cards: {} as never,
		uploads: {} as never,
		files: {} as never,
		modes: {} as never,
		conversations: {} as never,
		identity: { principal: async () => undefined },
		directory: {
			agent: (name: string) =>
				name === "scout"
					? {
							name,
							displayName: "Scout",
							prompt: "You scout.",
							avatarPrompt: "",
							status: "active",
							character: { class: "scribe" },
						}
					: undefined,
			agents: () => [],
			group: () => undefined,
			groups: () => [],
		} as never,
		team: team as never,
		avatars: {} as never,
		mutes: {} as never,
		threads: {} as never,
		layout: {} as never,
		...(options.prompts ? { prompts } : {}),
		...(options.skills
			? {
					skills: {
						catalog: () => CATALOG,
						attach: async (
							agent: string,
							add: readonly string[],
							remove: readonly string[],
						) => {
							calls.push(
								`attach ${agent} +${add.join(",")} -${remove.join(",")}`,
							);
							return [];
						},
						documents: documentsApi,
						groups: groupsApi,
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

/** Registers the stand-in registry and host, reset before each test. */
export function editHostPerTest(): void {
	beforeEach(() => {
		calls = [];
		skillGroups = [
			{
				name: "coding",
				description: "Coding workflow.",
				skills: ["kit-do", "writing-skills", "tidy", "daily-notes"],
			},
		];
		saveFails = undefined;
		who = { id: "owner", name: "Riley", tier: "owner" };
		documents = new Map([
			["shared", document("shared")],
			[
				"guest",
				document("guest", {
					text: "Owner's guest text.",
					overridden: true,
					differs: true,
					override: { by: "Riley", at: AT },
				}),
			],
		]);
		history = [
			{
				id: 2,
				action: "set",
				text: "Owner's guest text.",
				previous: "File text.",
				by: "Riley",
				at: AT,
			},
		];
		agentHistory = [
			{
				id: 1,
				action: "set",
				text: "You scout well.",
				previous: "You scout.",
				by: "doctor",
				at: AT,
			},
		];
		const doc = (
			writable: boolean,
			source: SkillDocument["source"],
			name: string,
			text: string,
		) => ({
			name,
			source,
			text,
			hash: HASH(text.length),
			writable,
		});
		skillDocs = new Map([
			[
				"daily-notes",
				doc(true, { kind: "written" }, "daily-notes", skillText("One.")),
			],
			[
				"kit-do",
				doc(
					false,
					{ kind: "linked", repo: "acme/kit", path: "skills/kit-do" },
					"kit-do",
					"---\nname: kit-do\ndescription: Use when changing source.\n---\n\nDo.\n",
				),
			],
		]);
		skillVersions = [
			{
				id: 1,
				text: skillText("One."),
				hash: HASH(skillText("One.").length),
				by: "Riley",
				at: AT,
			},
		];
	});
}

export const call = (
	server: ConsoleServer,
	method: string,
	path: string,
	init: { body?: unknown; origin?: string | null } = {},
) =>
	server.handle(
		new Request(`http://host/console/api/${path}`, {
			method,
			headers: {
				...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }),
				...(init.body !== undefined
					? { "content-type": "application/json" }
					: {}),
			},
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
		}),
	);

export interface Write {
	method: string;
	path: string;
	body?: unknown;
	unknown: string;
}

/** Every owner-only call: a member is refused, a write needs the console's Origin, an unknown target is 404, and nothing changes. */
export function ownerOnly(label: string, write: Write) {
	test(`${label}: a member, a foreign Origin and an unknown target are refused, and nothing changes`, async () => {
		const server = setup();
		who = { id: "member", name: "Mel", tier: "member" };
		const asMember = await call(server, write.method, write.path, {
			...(write.body !== undefined ? { body: write.body } : {}),
		});
		expect(asMember.status).toBe(403);
		expect(((await asMember.json()) as ApiError).error).toBe(
			"Only an owner may do this.",
		);
		// The tier answers before the target is looked up, so a member learns of no id or name.
		const probed = await call(server, write.method, write.unknown, {
			...(write.body !== undefined ? { body: write.body } : {}),
		});
		expect(probed.status).toBe(403);
		who = { id: "owner", name: "Riley", tier: "owner" };
		if (write.method !== "GET")
			for (const origin of [null, "https://evil.example.test"]) {
				const response = await call(server, write.method, write.path, {
					origin,
					...(write.body !== undefined ? { body: write.body } : {}),
				});
				expect(response.status).toBe(403);
			}
		const missing = await call(server, write.method, write.unknown, {
			...(write.body !== undefined ? { body: write.body } : {}),
		});
		expect(missing.status).toBe(404);
		expect(calls).toEqual([]);
	});
}

/** Signs the next calls in as this person. */
export function actAs(person: { id: string; name: string; tier: Tier }): void {
	who = person;
}

/** Replaces the skill groups the stand-in registry holds. */
export function setSkillGroups(
	groups: { name: string; description: string; skills: string[] }[],
): void {
	skillGroups = groups;
}
