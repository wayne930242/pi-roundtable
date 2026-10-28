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

	test("without one, redrawing refuses clearly and the picture stays", async () => {
		const { ctx, store, studio } = context("none", [
			agent("coordinator", { avatarHash: "a".repeat(64) }),
		]);
		const editing = new TeamEditing(ctx);
		for (const mode of ["redraw", "new_prompt", "edit"] as const) {
			const refusal = editing.redrawAvatar("coordinator", mode, "x");
			expect(refusal).rejects.toThrow("No image provider is configured");
			expect(refusal).rejects.toBeInstanceOf(AgentError);
			await refusal.catch(() => undefined);
		}
		expect(studio.calls).toEqual([]);
		expect(store.agent("coordinator")?.avatarHash).toBe("a".repeat(64));
		expect(store.agent("coordinator")?.avatarPrompt).toBe(
			"A portrait of coordinator.",
		);
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

describe("the tools agents are offered, by whether an image provider is configured", () => {
	function team(kind: "none" | "draws") {
		const store = memoryStore([agent("coordinator")]);
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

	test("with a provider: agent_avatar is registered and agent_create takes avatar_prompt", async () => {
		const tools = await registered("draws");
		expect([...tools.keys()]).toEqual([
			"agent_list",
			"agent_get",
			"agent_update",
			"agent_create",
			"agent_avatar",
			"group_create",
			"group_update",
			"archive",
			"channel_arrange",
			"channel_read",
			"message_agent",
		]);
		expect(tools.get("agent_create")).toContain("avatar_prompt");
		expect(tools.get("agent_avatar")).toEqual(["name", "mode", "text"]);
	});

	test("without one: no agent_avatar and no avatar_prompt, everything else the same", async () => {
		const withProvider = await registered("draws");
		const tools = await registered("none");
		expect([...tools.keys()]).toEqual(
			[...withProvider.keys()].filter((name) => name !== "agent_avatar"),
		);
		expect(tools.get("agent_create")).toEqual([
			"name",
			"display_name",
			"prompt",
			"task",
			"category",
			"skills",
		]);
	});

	test("the tool selection, the prompt, and agent_get follow", () => {
		const draws = team("draws");
		const none = team("none");
		expect(draws.selection().tools).toContain("agent_avatar");
		expect(none.selection().tools).not.toContain("agent_avatar");
		expect(none.selection().tools).toContain("agent_create");
		expect(draws.systemPrompt(SCOPE)).toContain("agent_avatar redraws");
		expect(none.systemPrompt(SCOPE)).not.toContain("agent_avatar");
		expect(draws.get("coordinator")).toContain("Avatar prompt:");
		expect(none.get("coordinator")).not.toContain("Avatar prompt:");
	});
});
