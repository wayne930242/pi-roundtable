import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pino from "pino";
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
			avatarPrompt: string;
			channelId: string;
		}) => {
			const created = agent(input.name, input);
			rows.set(input.name, created);
			return created;
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
		changed: () => undefined,
	} as unknown as TeamContext;
	return { ctx, store, studio, created };
}

const NEW_AGENT = {
	name: "scout",
	displayName: "Scout",
	prompt: "You scout.",
	task: "Look around.",
};

describe("agent_create and avatars, by whether an image provider is configured", () => {
	test("with a provider it needs an avatar prompt and draws from it", async () => {
		const { ctx, store, studio } = context("draws", [agent("coordinator")]);
		const editing = new TeamEditing(ctx);
		expect(editing.create(SCOPE, NEW_AGENT)).rejects.toThrow("avatar_prompt");
		const said = await editing.create(SCOPE, {
			...NEW_AGENT,
			avatarPrompt: "a fox scout",
		});
		expect(said).toContain("its avatar is drawn");
		expect(studio.calls).toEqual(["draw a fox scout"]);
		expect(store.agent("scout")?.avatarHash).toBe("d".repeat(64));
	});

	test("without one it needs no avatar prompt and generates the picture from the display name", async () => {
		const { ctx, store, studio } = context("none", [agent("coordinator")]);
		const said = await new TeamEditing(ctx).create(SCOPE, NEW_AGENT);
		expect(said).toContain("its avatar is generated from its display name");
		expect(studio.calls).toEqual(["fallback Scout"]);
		expect(store.agent("scout")).toMatchObject({
			avatarPrompt: "",
			avatarHash: "f".repeat(64),
		});
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

	test("with a provider that fails, a new agent keeps the neutral avatar and the error is reported", async () => {
		const { ctx, store } = context("fails", [agent("coordinator")]);
		const said = await new TeamEditing(ctx).create(SCOPE, {
			...NEW_AGENT,
			avatarPrompt: "a fox scout",
		});
		expect(said).toContain("its avatar could not be drawn (");
		expect(said).toContain("the provider is down");
		expect(store.agent("scout")?.avatarHash).toBeUndefined();
	});
});

describe("startup avatars", () => {
	const flush = () => Bun.sleep(20);
	const missing = () => [
		agent("coordinator"),
		agent("infra"),
		agent("done", { avatarHash: "c".repeat(64) }),
	];

	test("without a provider it generates the missing pictures and logs one info line", async () => {
		const { lines, logger } = capturedLog();
		const { ctx, store, studio } = context("none", missing(), logger);
		await new TeamLifecycle(ctx).start();
		await flush();
		expect(studio.calls).toEqual(["fallback COORDINATOR", "fallback INFRA"]);
		expect(store.agent("infra")?.avatarHash).toBe("f".repeat(64));
		expect(lines).toEqual([
			"info no image provider is configured; agents without a picture got one generated from their display name",
		]);
	});

	test("without a provider and nothing missing it logs nothing", async () => {
		const { lines, logger } = capturedLog();
		const { ctx } = context(
			"none",
			[agent("coordinator", { avatarHash: "c".repeat(64) })],
			logger,
		);
		await new TeamLifecycle(ctx).start();
		await flush();
		expect(lines).toEqual([]);
	});

	test("with a provider it draws each one and logs each, as before", async () => {
		const { lines, logger } = capturedLog();
		const { ctx, studio } = context("draws", missing(), logger);
		await new TeamLifecycle(ctx).start();
		await flush();
		expect(studio.calls).toEqual([
			"draw A portrait of coordinator.",
			"draw A portrait of infra.",
		]);
		expect(lines).toEqual(["info avatar drawn", "info avatar drawn"]);
	});

	test("with a provider that fails it warns once per agent, as before", async () => {
		const { lines, logger } = capturedLog();
		const { ctx } = context("fails", missing(), logger);
		await new TeamLifecycle(ctx).start();
		await flush();
		expect(lines).toEqual(["warn avatar not drawn", "warn avatar not drawn"]);
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
