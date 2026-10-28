import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pino from "pino";
import { resolveCharacter } from "../../characters/index.ts";
import { AgentError } from "../domain/errors.ts";
import { silentLogger } from "../log.ts";
import type { AgentTurnScope } from "../sessions.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import type { Agent } from "./agent-store.ts";
import { type AgentTeamOptions, DiscordAgentTeam } from "./agent-team.ts";
import { type AgentOps, agentToolsExtension } from "./agent-tools.ts";
import { TeamEditing } from "./team-editing.ts";
import { discordKey } from "./team-keys.ts";
import { TeamLifecycle } from "./team-lifecycle.ts";
import type { TeamContext } from "./team-options.ts";

const SCOPE: AgentTurnScope = {
	name: "coordinator",
	session: discordKey("ch-coordinator"),
	home: discordKey("ch-coordinator"),
};

function agent(name: string, extra: Partial<Agent> = {}): Agent {
	return {
		name,
		displayName: name.toUpperCase(),
		prompt: `You are ${name}.`,
		avatarPrompt: `A portrait of ${name}.`,
		channelId: `ch-${name}`,
		status: "active",
		...extra,
	};
}

/** What an agent store does for the team, in memory. */
function memoryStore(initial: Agent[]) {
	const rows = new Map(initial.map((a) => [a.name, a]));
	return {
		agents: () => [...rows.values()],
		groups: () => [],
		seed: async () => [],
		agent: (name: string) => rows.get(name),
		agentByChannel: (id: string) =>
			[...rows.values()].find((a) => a.channelId === id),
		group: () => undefined,
		activeAgent: (name: string) => {
			const found = rows.get(name);
			if (!found) throw new AgentError(`There is no agent "${name}".`);
			return found;
		},
		checkNewName: () => undefined,
		createAgent: async (input: {
			name: string;
			displayName: string;
			prompt: string;
			avatarPrompt?: string;
			channelId: string;
		}) => {
			const created = agent(input.name, {
				...input,
				avatarPrompt: input.avatarPrompt ?? "",
			});
			rows.set(input.name, created);
			return created;
		},
		hasStoredCharacter: (name: string) =>
			rows.get(name)?.character !== undefined,
		dressIfUndressed: async (
			name: string,
			character: Agent["character"],
			avatarHash: string,
		) => {
			const current = rows.get(name) as Agent;
			if (current.character) return false;
			rows.set(name, { ...current, character, avatarHash });
			return true;
		},
		updateAgent: async (name: string, change: Partial<Agent>) => {
			const updated = { ...(rows.get(name) as Agent), ...change };
			rows.set(name, updated);
			return updated;
		},
	};
}

/** A studio that records what it was asked and can be made to fail drawing. */
function recordingStudio(kind: "none" | "draws" | "fails") {
	const calls: string[] = [];
	return {
		calls,
		url: (hash: string | undefined) => `https://x/${hash ?? "default"}.png`,
		render: async (spec: { class: string }) => {
			calls.push(`render ${spec.class}`);
			if (kind === "fails") throw new Error("the renderer is down");
			return "r".repeat(64);
		},
		draw: async (prompt: string) => {
			calls.push(`draw ${prompt}`);
			if (kind === "fails") throw new Error("the provider is down");
			return "d".repeat(64);
		},
		edit: async () => "e".repeat(64),
		...(kind === "none"
			? {
					canDraw: false,
					fallback: async (displayName: string, _name: string) => {
						calls.push(`fallback ${displayName}`);
						return "f".repeat(64);
					},
				}
			: {}),
	};
}

/** Every line a logger wrote, as `level message`. */
function capturedLog() {
	const lines: string[] = [];
	const logger = pino(
		{ level: "info" },
		{
			write: (line: string) => {
				const entry = JSON.parse(line) as { level: number; msg: string };
				lines.push(`${entry.level >= 40 ? "warn" : "info"} ${entry.msg}`);
			},
		},
	);
	return { lines, logger };
}

function context(
	kind: "none" | "draws" | "fails",
	agents: Agent[],
	logger = silentLogger(),
) {
	const changes = { count: 0 };
	const store = memoryStore(agents);
	const studio = recordingStudio(kind);
	const created: string[] = [];
	const ctx = {
		options: {
			store,
			studio,
			logger,
			seeds: () => [],
			channels: {
				exists: async () => true,
				layout: async () => [],
				placeIn: async () => false,
				createChannel: async (name: string) => {
					created.push(name);
					return `ch-${name}`;
				},
			},
			skills: { checkRegistered: () => undefined, attach: async () => [] },
			queue: { run: async () => undefined },
			owner: TEST_OWNER,
		},
		turns: {
			speakerOf: () => ({ id: "1", name: "Riley", tier: "owner" as const }),
			answerBackground: async () => undefined,
		},
		changed: () => {
			changes.count++;
		},
	} as unknown as TeamContext;
	return { ctx, store, studio, created, changes };
}

const NEW_AGENT = {
	name: "scout",
	displayName: "Scout",
	prompt: "You scout.",
	task: "Look around.",
};

describe("agent_create and avatars", () => {
	test("a new agent is dressed from its role and rendered, whether or not a provider is configured", async () => {
		for (const kind of ["draws", "none"] as const) {
			const { ctx, store, studio } = context(kind, [agent("coordinator")]);
			const said = await new TeamEditing(ctx).create(SCOPE, {
				...NEW_AGENT,
				name: "researcher",
				displayName: "Researcher",
				prompt: "You research the literature.",
			});
			expect(said).toContain("its picture is the scholar look");
			expect(studio.calls).toEqual(["render scholar"]);
			expect(store.agent("researcher")).toMatchObject({
				avatarPrompt: "",
				avatarHash: "r".repeat(64),
			});
			expect(store.agent("researcher")?.character?.class).toBe("scholar");
		}
	});

	test("the character given to the tool wins over the role", async () => {
		const { ctx, store, studio } = context("draws", [agent("coordinator")]);
		await new TeamEditing(ctx).create(SCOPE, {
			...NEW_AGENT,
			avatarPrompt: "ignored",
			character: { class: "ranger", palette: "vert" },
		});
		expect(studio.calls).toEqual(["render ranger"]);
		expect(store.agent("scout")?.character).toMatchObject({
			class: "ranger",
			palette: "vert",
		});
		expect(store.agent("scout")?.avatarPrompt).toBe("");
	});

	test("redrawAvatar is deprecated but still draws, edits and refuses without a provider", async () => {
		const drawn = context("draws", [
			agent("scout", { avatarHash: "a".repeat(64) }),
		]);
		const editing = new TeamEditing(drawn.ctx);
		await editing.redrawAvatar("scout", "redraw");
		await editing.redrawAvatar("scout", "edit", "add a hat");
		await editing.redrawAvatar("scout", "new_prompt", "A fox.");
		expect(drawn.store.agent("scout")?.avatarPrompt).toBe("A fox.");
		expect(drawn.studio.calls.length).toBe(3);
		const none = context("none", [agent("scout")]);
		const refusal = new TeamEditing(none.ctx).redrawAvatar("scout", "redraw");
		expect(refusal).rejects.toThrow("No image provider is configured");
		expect(refusal).rejects.toBeInstanceOf(AgentError);
		await refusal.catch(() => undefined);
		expect("redrawAvatar" in DiscordAgentTeam.prototype).toBe(true);
	});

	test("the deprecation is stated in the source, the changelog and the plugin guide", async () => {
		const root = new URL("../../../", import.meta.url);
		const read = (path: string) => Bun.file(new URL(path, root)).text();
		const services = await read("src/core/services.ts");
		expect(services).toMatch(/@deprecated[^]*?\n\tredrawAvatar\(/);
		expect(await read("src/core/agents/agent-tools.ts")).toMatch(
			/@deprecated[^]*?export type AvatarMode/,
		);
		expect(await read("CHANGELOG.md")).toContain(
			"`AgentTeam.redrawAvatar` and the `AvatarMode` type (`pi-roundtable`) still work",
		);
		expect(await read("docs/plugins.md")).toContain(
			"`AgentTeam.redrawAvatar` and the `AvatarMode` type are deprecated",
		);
	});

	test("dressing a part changes only that part, whether or not a provider is configured", async () => {
		for (const kind of ["draws", "none"] as const) {
			const worn = resolveCharacter({ class: "scholar", palette: "teal" });
			const { ctx, store, studio } = context(kind, [
				agent("scout", { character: worn }),
			]);
			await new TeamEditing(ctx).dress("scout", { hat: "beret" });
			expect(store.agent("scout")?.character).toEqual({
				...worn,
				hat: "beret",
			});
			expect(studio.calls).toEqual(["render scholar"]);
		}
	});

	test("a render failure fails the create: no channel, no row", async () => {
		const { ctx, store, created } = context("fails", [agent("coordinator")]);
		const failure = new TeamEditing(ctx).create(SCOPE, NEW_AGENT);
		expect(failure).rejects.toThrow("the renderer is down");
		await failure.catch(() => undefined);
		expect(store.agent("scout")).toBeUndefined();
		expect(created).toEqual([]);
	});
});

describe("startup dressing", () => {
	const flush = () => Bun.sleep(20);
	const worn = resolveCharacter({ class: "monk", palette: "sable" });
	const missing = () => [
		agent("coordinator"),
		agent("infra"),
		agent("done", { avatarHash: "c".repeat(64), character: worn }),
	];

	test("each active agent without a character is dressed and rendered, the others left alone", async () => {
		const { lines, logger } = capturedLog();
		const c = context("draws", missing(), logger);
		const { ctx, store, studio, changes } = c;
		await new TeamLifecycle(ctx).start();
		await flush();
		// One change after the seeds and channels, one after the whole dressing pass.
		expect(changes.count).toBe(2);
		expect(studio.calls).toHaveLength(2);
		expect(store.agent("infra")?.avatarHash).toBe("r".repeat(64));
		expect(store.agent("infra")?.character).toBeDefined();
		expect(store.agent("done")?.character).toEqual(worn);
		expect(store.agent("done")?.avatarHash).toBe("c".repeat(64));
		expect(lines).toEqual(["info agent dressed", "info agent dressed"]);
	});

	test("with nothing missing it renders and logs nothing", async () => {
		const { lines, logger } = capturedLog();
		const { ctx, studio } = context(
			"none",
			[agent("coordinator", { avatarHash: "c".repeat(64), character: worn })],
			logger,
		);
		await new TeamLifecycle(ctx).start();
		await flush();
		expect(studio.calls).toEqual([]);
		expect(lines).toEqual([]);
	});

	test("a render that fails warns once per agent and leaves the old picture", async () => {
		const { lines, logger } = capturedLog();
		const { ctx, store } = context("fails", missing(), logger);
		await new TeamLifecycle(ctx).start();
		await flush();
		expect(lines).toEqual(["warn agent not dressed", "warn agent not dressed"]);
		expect(store.agent("infra")?.character).toBeUndefined();
	});
});

describe("the agent tools, with and without an image provider", () => {
	function team(kind: "none" | "draws") {
		const store = memoryStore([
			agent("coordinator", {
				character: resolveCharacter({ class: "bard", palette: "rose" }),
			}),
		]);
		return new DiscordAgentTeam({
			guildId: "1",
			entryChannelId: "ch-coordinator",
			owner: TEST_OWNER,
			shellUser: "bot",
			workDir: "/work",
			sharedPrompt: "Shared.",
			store,
			studio: recordingStudio(kind),
			pluginSelection: () => ({ id: "plugged", tools: [], groups: [] }),
			models: {
				defaults: { model: "a/b", thinking: "auto" },
				usable: async () => [],
			},
			skills: {
				checkRegistered: () => undefined,
				describeCarried: () => "none",
			},
			logger: silentLogger(),
		} as unknown as AgentTeamOptions);
	}

	/** The tools an agent session registers, with each one's parameter names. */
	async function registered(kind: "none" | "draws") {
		const tools = new Map<string, string[]>();
		const pi = {
			registerTool: (tool: {
				name: string;
				parameters: { properties?: Record<string, unknown> };
			}) => tools.set(tool.name, Object.keys(tool.parameters.properties ?? {})),
		} as unknown as ExtensionAPI;
		await team(kind).extension(SCOPE)(pi);
		return tools;
	}

	test("agent_avatar is listed on a host without an image provider, and agent_create has class and color but no avatar_prompt", async () => {
		const withProvider = await registered("draws");
		const tools = await registered("none");
		expect([...tools.keys()]).toEqual([...withProvider.keys()]);
		expect(tools.has("agent_avatar")).toBe(true);
		for (const each of [withProvider, tools]) {
			expect(each.get("agent_create")).toEqual([
				"name",
				"display_name",
				"prompt",
				"class",
				"color",
				"task",
				"category",
				"skills",
			]);
			expect(each.get("agent_avatar")).toEqual([
				"name",
				"class",
				"color",
				"parts",
			]);
		}
	});

	test("the selection offers agent_avatar either way, and the prompt says it changes a look", () => {
		for (const kind of ["draws", "none"] as const) {
			const t = team(kind);
			expect(t.selection().tools).toContain("agent_avatar");
			expect(t.systemPrompt(SCOPE)).toContain(
				"agent_avatar changes an agent's look (class, colors, parts)",
			);
		}
	});

	test("agent_get shows the look and no avatar prompt", () => {
		const text = team("none").get("coordinator");
		expect(text).toContain("Look: Bard, rose");
		expect(text).not.toContain("Avatar prompt");
	});
});

describe("the agent_create and agent_avatar tools pass looks to the team", () => {
	/** The tools registered over stub ops, each callable by name. */
	function tools() {
		const calls: [string, unknown[]][] = [];
		const ops = new Proxy(
			{},
			{
				get:
					(_t, key: string) =>
					async (...args: unknown[]) => {
						calls.push([key, args]);
						return "ok";
					},
			},
		) as unknown as AgentOps;
		const run = new Map<
			string,
			(params: Record<string, unknown>) => Promise<unknown>
		>();
		const pi = {
			registerTool: (tool: {
				name: string;
				execute: (
					id: string,
					params: Record<string, unknown>,
				) => Promise<unknown>;
			}) => run.set(tool.name, (params) => tool.execute("id", params)),
		} as unknown as ExtensionAPI;
		agentToolsExtension(ops, SCOPE, TEST_OWNER, { skills: false })(pi);
		return { calls, run };
	}

	test("agent_create sends class and color as the character", async () => {
		const { calls, run } = tools();
		await run.get("agent_create")?.({
			name: "bob",
			display_name: "Bob",
			prompt: "p",
			class: "bard",
			color: "rose",
			task: "t",
		});
		expect(calls[0]?.[0]).toBe("create");
		expect(calls[0]?.[1][1]).toMatchObject({
			character: { class: "bard", palette: "rose" },
		});
		expect(calls[0]?.[1][1]).not.toHaveProperty("avatarPrompt");
	});

	test("agent_avatar sends only what it is given, parts named in camel case", async () => {
		const { calls, run } = tools();
		await run.get("agent_avatar")?.({
			name: "bob",
			parts: { hat: "beret", hair_color: "#112233" },
		});
		expect(calls[0]).toEqual([
			"avatar",
			["bob", { hat: "beret", hairColor: "#112233" }],
		]);
	});
});
