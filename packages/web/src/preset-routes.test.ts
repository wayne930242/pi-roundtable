import { beforeEach, describe, expect, test } from "bun:test";
import type { HelperPreset, Tier } from "pi-roundtable";
import { AgentError } from "pi-roundtable/kit";
import { recordingLogger } from "pi-roundtable/testing";
import type {
	ApiError,
	PresetSaved,
	PresetsView,
	SessionView,
} from "./api-types.ts";
import { AppApi } from "./app/routes.ts";
import type { AssetBundle } from "./assets.ts";
import { createAuthenticator } from "./auth/authenticator.ts";
import { ConsoleServer } from "./console-server.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import { admit } from "./verifier.ts";

const assets: AssetBundle = new Map([
	["index.html", { body: Buffer.from("<html></html>"), type: "text/html" }],
]);

const SHARED: HelperPreset = {
	name: "medic",
	displayName: "Medic",
	prompt: "You heal.",
	skills: [],
};

let who: { id: string; tier: Tier };
let saved: Map<string, HelperPreset>;
let calls: string[];

/** The app over a fake team that keeps one knight's presets, the way the core refuses. */
function setup(helpersOn = true) {
	const recorder = recordingLogger();
	const knight = (name: string) => {
		if (name !== "scout")
			throw new AgentError(`There is no active agent "${name}".`);
	};
	const team = {
		helpersOn: () => helpersOn,
		modelOf: () => ({ model: "m/one", thinking: "medium" as const }),
		presets: async (agent: string) => {
			knight(agent);
			return [...saved.values()];
		},
		usablePresets: async (agent: string) => {
			knight(agent);
			return [
				...[...saved.values()].map((p) => ({ ...p, agent })),
				{ ...SHARED, agent: "boss" },
			];
		},
		savePreset: async (
			agent: string,
			preset: HelperPreset,
			...sharing: unknown[]
		) => {
			knight(agent);
			if (preset.skills.includes("nope"))
				throw new AgentError("Unknown skills: nope.");
			calls.push(
				`save ${agent} ${preset.name}${sharing.length > 0 ? ` ${JSON.stringify(sharing[0])}` : ""}`,
			);
			const replaced = saved.has(preset.name);
			saved.set(preset.name, preset);
			return { preset, replaced };
		},
		deletePreset: async (agent: string, name: string) => {
			knight(agent);
			calls.push(`delete ${agent} ${name}`);
			return saved.delete(name);
		},
	};
	const scout = {
		name: "scout",
		displayName: "Scout",
		prompt: "You scout.",
		avatarPrompt: "",
		status: "active" as const,
	};
	const api = new AppApi({
		surface: { surface: "app" } as never,
		rooms: {} as never,
		log: {} as never,
		cards: {} as never,
		uploads: {} as never,
		files: {} as never,
		modes: {} as never,
		conversations: {} as never,
		identity: { principal: async () => undefined },
		directory: {
			agent: (name: string) => (name === "scout" ? scout : undefined),
			agents: () => [scout],
			group: () => undefined,
			groups: () => [],
		} as never,
		team: team as never,
		avatars: {} as never,
		threads: {} as never,
		mutes: {} as never,
		layout: {} as never,
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
					principal: { id: who.id, displayName: who.id, disabled: false },
					tier: who.tier,
					speakerId: who.id,
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

const call = (
	server: ConsoleServer,
	method: string,
	path: string,
	body?: unknown,
) =>
	server.handle(
		new Request(`http://host/console/api/${path}`, {
			method,
			headers: {
				origin: ORIGIN,
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		}),
	);

const WRITER = {
	displayName: "Writer",
	prompt: "You write.",
	skills: ["kit-do"],
	model: "m/two",
	thinking: "high",
	character: { class: "bard" as const },
};

beforeEach(() => {
	who = { id: "owner", tier: "owner" };
	saved = new Map();
	calls = [];
});

describe("a knight's presets over the API", () => {
	test("save, replace, list, and delete", async () => {
		const server = setup();
		const made = await call(server, "PUT", "agents/scout/presets/writer", {
			...WRITER,
		});
		expect(made.status).toBe(200);
		expect((await made.json()) as PresetSaved).toEqual({
			preset: { name: "writer", ...WRITER },
			replaced: false,
		});
		const again = await call(server, "PUT", "agents/scout/presets/writer", {
			displayName: "Writer",
			prompt: "Another.",
		});
		expect(((await again.json()) as PresetSaved).replaced).toBe(true);
		const listed = (await (
			await call(server, "GET", "agents/scout/presets")
		).json()) as PresetsView;
		expect(listed).toEqual({
			presets: [
				{
					name: "writer",
					displayName: "Writer",
					prompt: "Another.",
					skills: [],
				},
			],
			shared: [{ ...SHARED, agent: "boss" }],
			max: 20,
		});
		expect(
			(await call(server, "DELETE", "agents/scout/presets/writer")).status,
		).toBe(204);
		const gone = await call(server, "DELETE", "agents/scout/presets/writer");
		expect(gone.status).toBe(404);
		expect(((await gone.json()) as ApiError).error).toContain(
			'no preset "writer"',
		);
	});

	test("a save carries whom the preset is shared with, and leaves it out to keep it", async () => {
		const server = setup();
		for (const sharedWith of ["all", ["boss"], null, undefined])
			expect(
				(
					await call(server, "PUT", "agents/scout/presets/writer", {
						...WRITER,
						...(sharedWith === undefined ? {} : { sharedWith }),
					})
				).status,
			).toBe(200);
		expect(calls).toEqual([
			'save scout writer "all"',
			'save scout writer ["boss"]',
			"save scout writer null",
			"save scout writer",
		]);
		const bad = await call(server, "PUT", "agents/scout/presets/writer", {
			...WRITER,
			sharedWith: "boss",
		});
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as ApiError).error).toContain("sharedWith");
	});

	test("the team's refusal is a 400 in its words, and a bad body is named", async () => {
		const server = setup();
		const refused = await call(server, "PUT", "agents/scout/presets/w", {
			...WRITER,
			skills: ["nope"],
		});
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as ApiError).error).toBe(
			"Unknown skills: nope.",
		);
		const noPrompt = await call(server, "PUT", "agents/scout/presets/w", {
			displayName: "W",
		});
		expect(noPrompt.status).toBe(400);
		expect(((await noPrompt.json()) as ApiError).error).toContain("prompt");
		expect(calls).toEqual([]);
	});

	test("only an owner reads or writes them", async () => {
		const server = setup();
		who = { id: "member", tier: "member" };
		for (const [method, path, body] of [
			["GET", "agents/scout/presets", undefined],
			["PUT", "agents/scout/presets/writer", WRITER],
			["DELETE", "agents/scout/presets/writer", undefined],
		] as const) {
			const response = await call(server, method, path, body);
			expect([method, response.status]).toEqual([method, 403]);
		}
		expect(calls).toEqual([]);
	});

	test("the session tells the page whether temp knights are on", async () => {
		const on = (await (
			await call(setup(), "GET", "session")
		).json()) as SessionView;
		expect(on.helpers).toBe(true);
		const off = (await (
			await call(setup(false), "GET", "session")
		).json()) as SessionView;
		expect(off.helpers).toBeUndefined();
	});
});
