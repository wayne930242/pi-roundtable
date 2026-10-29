import { beforeEach, describe, expect, test } from "bun:test";
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
import type {
	ApiError,
	PromptConflict,
	PromptHistoryView,
	PromptsView,
	PromptView,
	SessionView,
	SkillConflict,
	SkillDocView,
	SkillHistoryView,
	SkillView,
} from "./api-types.ts";
import { AppApi } from "./app/routes.ts";
import type { AssetBundle } from "./assets.ts";
import { createAuthenticator } from "./auth/authenticator.ts";
import { ConsoleServer } from "./console-server.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import { admit } from "./verifier.ts";
import type { Visitor } from "./visitors.ts";

// The routes that edit the main prompts and the skills' SKILL.md files: the owner-only rules every
// write shares, the 409 of a stale save, and the words of a refusal. The core's own behavior (the
// frontmatter rules, the history) has its tests in the core; here the registry is a stand-in.

const assets: AssetBundle = new Map([
	["index.html", { body: Buffer.from("<html></html>"), type: "text/html" }],
]);

const HASH = (n: number) => String(n).repeat(64).slice(0, 64);
const AT = new Date("2026-10-29T08:00:00.000Z");

let who: { id: string; name: string; tier: Tier };
let calls: string[];
let documents: Map<string, PromptDocumentView>;
let history: PromptVersion[];
let agentHistory: PromptVersion[];
let skillDocs: Map<string, SkillDocument>;
let skillVersions: SkillVersion[];
/** Set by a test: the next save throws this. */
let saveFails: Error | undefined;

const document = (
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

const skillText = (body: string) =>
	`---\nname: daily-notes\ndescription: "Use when keeping notes."\n---\n\n${body}\n`;

const CATALOG: SkillView[] = [
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
		carriers: [],
	},
];

function setup(
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
	};
	const team = {
		update: async (name: string, _change: unknown, by?: string) => {
			calls.push(`update ${name} by ${by ?? "-"}`);
			return "updated";
		},
		promptHistory: async (name: string) => {
			if (name === "nobody") throw new AgentError("There is no agent.");
			return agentHistory;
		},
		modelOf: () => ({ model: "m/one", thinking: "medium" as const }),
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
						attach: async () => [],
						documents: documentsApi,
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

beforeEach(() => {
	calls = [];
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

const call = (
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

interface Write {
	method: string;
	path: string;
	body?: unknown;
	unknown: string;
}

/** Every owner-only call: a member is refused, a write needs the console's Origin, an unknown target is 404, and nothing changes. */
function ownerOnly(label: string, write: Write) {
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

describe("api/prompts", () => {
	test("lists the documents without their text, and says which differ from the file", async () => {
		const response = await call(setup(), "GET", "prompts");
		expect(response.status).toBe(200);
		const view = (await response.json()) as PromptsView;
		expect(view.documents).toEqual([
			{ id: "shared", label: "shared prompt", differs: false },
			{
				id: "guest",
				label: "guest prompt",
				differs: true,
				override: { by: "Riley", at: AT.toISOString() },
			},
		]);
	});

	test("a document whose file version cannot be read is marked in the list and the read, and the others are listed as before", async () => {
		const server = setup();
		documents.set(
			"aria",
			document("aria", {
				text: "",
				fileText: "",
				broken: "ENOENT: persona/aria.md",
			}),
		);
		const listed = (await (
			await call(server, "GET", "prompts")
		).json()) as PromptsView;
		expect(listed.documents.map((one) => one.id)).toEqual([
			"shared",
			"guest",
			"aria",
		]);
		expect(listed.documents.map((one) => one.broken)).toEqual([
			undefined,
			undefined,
			"ENOENT: persona/aria.md",
		]);
		const read = await call(server, "GET", "prompts/aria");
		expect(read.status).toBe(200);
		expect(((await read.json()) as PromptView).broken).toBe(
			"ENOENT: persona/aria.md",
		);
	});

	test("reads one document with its text and the file version", async () => {
		const view = (await (
			await call(setup(), "GET", "prompts/guest")
		).json()) as PromptView;
		expect(view).toMatchObject({
			id: "guest",
			text: "Owner's guest text.",
			fileText: "File text.",
			differs: true,
			maxChars: 20_000,
		});
	});

	test("a save names the text it was edited from and is kept under the owner's name", async () => {
		const server = setup();
		const response = await call(server, "PUT", "prompts/shared", {
			body: { text: "New text.", base: "File text." },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as PromptView).text).toBe("New text.");
		expect(calls).toEqual(["set shared by Riley"]);
	});

	test("a save from text that is no longer the current one is a 409 that carries the current document, and writes nothing", async () => {
		const server = setup();
		const response = await call(server, "PUT", "prompts/guest", {
			body: { text: "Mine.", base: "File text." },
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as PromptConflict;
		expect(body.conflict).toBe("changed");
		expect(body.current.text).toBe("Owner's guest text.");
		expect(calls).toEqual([]);
	});

	test("a refused text is a 400 with the core's words; a bad body is a 400", async () => {
		const server = setup();
		const empty = await call(server, "PUT", "prompts/shared", {
			body: { text: "  ", base: "File text." },
		});
		expect(empty.status).toBe(400);
		expect(((await empty.json()) as ApiError).error).toContain("1 to 20000");
		for (const body of [{ text: 1, base: "x" }, { text: "x" }, {}]) {
			expect(
				(await call(server, "PUT", "prompts/shared", { body })).status,
			).toBe(400);
		}
		expect(calls).toEqual([]);
	});

	test("the largest body follows the document's maxChars: a long text of a roomy document is saved, a body past the limit is a 413", async () => {
		const server = setup();
		// 60,000 characters of three bytes each is 180 KB, more than the 20,000-character default allows for.
		documents.set("roomy", document("roomy", { maxChars: 60_000 }));
		// Built at run time, so this file does not trip the public scan for Chinese text.
		const long = String.fromCodePoint(0x5b57).repeat(60_000);
		const saved = await call(server, "PUT", "prompts/roomy", {
			body: { text: long, base: "File text." },
		});
		expect(saved.status).toBe(200);
		expect(((await saved.json()) as PromptView).text).toBe(long);
		expect(calls).toEqual(["set roomy by Riley"]);
		// A document that keeps the default limit refuses a body far past what its texts can fill.
		const past = await call(server, "PUT", "prompts/shared", {
			body: { text: "x".repeat(300_000), base: "File text." },
		});
		expect(past.status).toBe(413);
		expect(calls).toEqual(["set roomy by Riley"]);
	});

	test("reverting returns to the file version and is kept under the owner's name; a document without an override is a 400", async () => {
		const server = setup();
		const response = await call(server, "POST", "prompts/guest/revert", {
			body: { base: "Owner's guest text." },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as PromptView).differs).toBe(false);
		expect(calls).toEqual(["revert guest by Riley"]);
		expect(
			(
				await call(server, "POST", "prompts/shared/revert", {
					body: { base: "File text." },
				})
			).status,
		).toBe(400);
	});

	test("a revert from text that is no longer the current one is a 409 that carries the current document, and writes nothing", async () => {
		const server = setup();
		const response = await call(server, "POST", "prompts/guest/revert", {
			body: { base: "The text a tab loaded earlier." },
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as PromptConflict;
		expect(body.conflict).toBe("changed");
		expect(body.current.text).toBe("Owner's guest text.");
		expect(calls).toEqual([]);
	});

	test("a revert that does not name the text it was asked from is a 400", async () => {
		const server = setup();
		for (const body of [{}, { base: 1 }])
			expect(
				(await call(server, "POST", "prompts/guest/revert", { body })).status,
			).toBe(400);
		expect(calls).toEqual([]);
	});

	test("the history lists who changed it, when, and the text each change replaced", async () => {
		const view = (await (
			await call(setup(), "GET", "prompts/guest/history")
		).json()) as PromptHistoryView;
		expect(view.versions).toEqual([
			{
				id: 2,
				action: "set",
				text: "Owner's guest text.",
				previous: "File text.",
				by: "Riley",
				at: AT.toISOString(),
			},
		]);
	});

	test("a host without prompt documents answers 404", async () => {
		const server = setup({ skills: true });
		expect((await call(server, "GET", "prompts")).status).toBe(404);
	});

	test("an unsupported method is refused", async () => {
		const server = setup();
		expect((await call(server, "DELETE", "prompts")).status).toBe(405);
		expect((await call(server, "DELETE", "prompts/shared")).status).toBe(404);
	});

	ownerOnly("a save", {
		method: "PUT",
		path: "prompts/shared",
		body: { text: "x", base: "File text." },
		unknown: "prompts/nope",
	});
	ownerOnly("a revert", {
		method: "POST",
		path: "prompts/guest/revert",
		body: { base: "Owner's guest text." },
		unknown: "prompts/nope/revert",
	});
	ownerOnly("a read", {
		method: "GET",
		path: "prompts/shared",
		unknown: "prompts/nope",
	});
	ownerOnly("the history", {
		method: "GET",
		path: "prompts/shared/history",
		unknown: "prompts/nope/history",
	});
});

describe("api/skill-docs", () => {
	test("reads a skill's whole SKILL.md with its hash and whether it can be edited", async () => {
		const server = setup();
		const written = (await (
			await call(server, "GET", "skill-docs/daily-notes")
		).json()) as SkillDocView;
		expect(written).toMatchObject({
			name: "daily-notes",
			source: { kind: "written" },
			writable: true,
		});
		expect(written.text).toBe(skillText("One."));
		const linked = (await (
			await call(server, "GET", "skill-docs/kit-do")
		).json()) as SkillDocView;
		expect(linked).toMatchObject({
			writable: false,
			source: { kind: "linked", repo: "acme/kit" },
		});
	});

	test("a save names the hash it was edited from and is kept under the owner's name", async () => {
		const server = setup();
		const read = (await (
			await call(server, "GET", "skill-docs/daily-notes")
		).json()) as SkillDocView;
		const response = await call(server, "PUT", "skill-docs/daily-notes", {
			body: { text: skillText("Two."), baseHash: read.hash },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as SkillDocView).text).toBe(
			skillText("Two."),
		);
		expect(calls).toEqual(["save daily-notes by Riley"]);
	});

	test("a save from an older hash is a 409 that carries what is there now", async () => {
		const server = setup();
		const response = await call(server, "PUT", "skill-docs/daily-notes", {
			body: { text: skillText("Mine."), baseHash: HASH(9) },
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as SkillConflict;
		expect(body.conflict).toBe("changed");
		expect(body.current.text).toBe(skillText("One."));
		expect(calls).toEqual([]);
	});

	test("a read-only skill's save is refused with the core's words", async () => {
		const server = setup();
		const read = (await (
			await call(server, "GET", "skill-docs/kit-do")
		).json()) as SkillDocView;
		const response = await call(server, "PUT", "skill-docs/kit-do", {
			body: { text: read.text, baseHash: read.hash },
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as ApiError).error).toContain("read-only");
	});

	test("a bad body is a 400, and a bad hash is named", async () => {
		const server = setup();
		for (const body of [{ text: 1, baseHash: HASH(1) }, { text: "x" }]) {
			expect(
				(await call(server, "PUT", "skill-docs/daily-notes", { body })).status,
			).toBe(400);
		}
		const response = await call(server, "PUT", "skill-docs/daily-notes", {
			body: { text: "x", baseHash: "nope" },
		});
		expect(((await response.json()) as ApiError).error).toContain("baseHash");
	});

	test("makes a skill from a whole SKILL.md and answers 201 with it", async () => {
		const server = setup();
		const response = await call(server, "POST", "skill-docs", {
			body: { text: skillText("New.") },
		});
		expect(response.status).toBe(201);
		expect(((await response.json()) as SkillDocView).name).toBe("fresh");
		expect(calls).toEqual(["create by Riley"]);
		const refused = await call(server, "POST", "skill-docs", {
			body: { text: "no frontmatter" },
		});
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as ApiError).error).toContain("frontmatter");
	});

	test("the history lists the versions kept, with who saved each", async () => {
		const view = (await (
			await call(setup(), "GET", "skill-docs/daily-notes/history")
		).json()) as SkillHistoryView;
		expect(view.versions.map((v) => [v.id, v.by, v.at])).toEqual([
			[1, "Riley", AT.toISOString()],
		]);
	});

	test("a skill the catalog does not list is a 404", async () => {
		const server = setup();
		expect((await call(server, "GET", "skill-docs/ghost")).status).toBe(404);
		expect(
			(
				await call(server, "PUT", "skill-docs/ghost", {
					body: { text: "x", baseHash: HASH(1) },
				})
			).status,
		).toBe(404);
	});

	test("a host without the skills addon answers 404", async () => {
		const server = setup({ prompts: true });
		expect((await call(server, "GET", "skill-docs/daily-notes")).status).toBe(
			404,
		);
		expect(
			(await call(server, "POST", "skill-docs", { body: { text: "x" } }))
				.status,
		).toBe(404);
	});

	ownerOnly("a save", {
		method: "PUT",
		path: "skill-docs/daily-notes",
		body: { text: "x", baseHash: HASH(1) },
		unknown: "skill-docs/ghost",
	});
	ownerOnly("a read", {
		method: "GET",
		path: "skill-docs/daily-notes",
		unknown: "skill-docs/ghost",
	});
	ownerOnly("the history", {
		method: "GET",
		path: "skill-docs/daily-notes/history",
		unknown: "skill-docs/ghost/history",
	});
	test("creating: a member and a foreign Origin are refused, and nothing is made", async () => {
		const server = setup();
		who = { id: "member", name: "Mel", tier: "member" };
		expect(
			(await call(server, "POST", "skill-docs", { body: { text: "x" } }))
				.status,
		).toBe(403);
		who = { id: "owner", name: "Riley", tier: "owner" };
		expect(
			(
				await call(server, "POST", "skill-docs", {
					body: { text: "x" },
					origin: "https://evil.example.test",
				})
			).status,
		).toBe(403);
		expect(calls).toEqual([]);
	});
});

describe("agent prompt history and the name a change is kept under", () => {
	test("lists an agent's prompt versions, newest first", async () => {
		const view = (await (
			await call(setup(), "GET", "agents/scout/prompt-history")
		).json()) as PromptHistoryView;
		expect(view.versions.map((v) => [v.by, v.previous, v.text])).toEqual([
			["doctor", "You scout.", "You scout well."],
		]);
	});

	test("a member and an unknown agent are refused", async () => {
		const server = setup();
		expect(
			(await call(server, "GET", "agents/nobody/prompt-history")).status,
		).toBe(404);
		who = { id: "member", name: "Mel", tier: "member" };
		expect(
			(await call(server, "GET", "agents/scout/prompt-history")).status,
		).toBe(403);
	});

	test("a prompt saved through PATCH is kept under the owner's name", async () => {
		const server = setup();
		const response = await call(server, "PATCH", "agents/scout", {
			body: { prompt: "You scout better." },
		});
		expect(response.status).toBe(200);
		expect(calls).toEqual(["update scout by Riley"]);
	});
});

describe("what the session says the host can edit", () => {
	test("prompts and skills are announced when the host has them, and only then", async () => {
		const both = (await (
			await call(setup(), "GET", "session")
		).json()) as SessionView;
		expect(both).toMatchObject({ prompts: true, skillEdit: true });
		const neither = (await (
			await call(setup({}), "GET", "session")
		).json()) as SessionView;
		expect(neither.prompts).toBeUndefined();
		expect(neither.skillEdit).toBeUndefined();
	});
});
