import { describe, expect, test } from "bun:test";
import { agentSystemPrompt } from "./agents/agent-prompt.ts";
import { teamSelection } from "./agents/team-selection.ts";
import type { AgentRuntime } from "./contract/runtime.ts";
import type { SurfacePort } from "./contract/surface.ts";
import { ConfigError } from "./domain/errors.ts";
import type { TurnRequest } from "./domain/ports.ts";
import { Roundtable, type RoundtableOptions } from "./host.ts";
import { silentLogger } from "./log.ts";
import { SHELL_TOOLS } from "./modules/host-shell/shell-policy.ts";
import type { AgentTools, LinkedSessions, RoundtablePlugin } from "./plugin.ts";
import { conversationTurns } from "./routing/conversation-turns.ts";
import type { PiAgentRuntimeOptions } from "./runtime/runtime-types.ts";
import { SessionFactory } from "./runtime/session-factory.ts";
import { OWNER_SPEAKER } from "./testing/owner.ts";

const SHELL: readonly string[] = SHELL_TOOLS;
const plugged = () => ({ tools: ["note_add"], groups: ["mail"] });

/** A factory over the part `toolsFor` reads: the linked plan. */
function factory(agentTools: AgentTools): SessionFactory {
	// SAFETY: toolsFor reads only the linked plan.
	const options = {
		agentTools,
		sessions: () =>
			({
				piPackages: [],
				plan: { tools: [], mcp: [] },
			}) as unknown as LinkedSessions,
	} as unknown as PiAgentRuntimeOptions;
	return new SessionFactory(options, {
		speaker: () => undefined,
		origin: () => undefined,
		client: () => undefined,
		formatting: () => undefined,
		withholdsMemory: () => false,
		runTask: async () => "",
	});
}

const options = (agentTools: AgentTools): RoundtableOptions => ({
	logger: silentLogger(),
	environment: { agentTools },
});

describe("the agent team's selection", () => {
	test("carries the shell and file tools by default, and none on a chat-only host", () => {
		const full = teamSelection({ pluginSelection: plugged }).tools;
		for (const tool of SHELL) expect(full).toContain(tool);
		for (const scope of [undefined, { group: "g" }] as const) {
			const chatOnly = teamSelection(
				{ pluginSelection: plugged, agentTools: "chat-only" },
				scope as never,
			).tools;
			for (const tool of SHELL) expect(chatOnly).not.toContain(tool);
			expect(chatOnly).toContain("note_add");
			expect(chatOnly).toContain("agent_list");
		}
	});

	test("no selection source turns into active tools with a shell tool on a chat-only host", () => {
		const sessions = factory("chat-only");
		const sources = [
			teamSelection({ pluginSelection: plugged, agentTools: "chat-only" }),
			{ id: "turns", ...plugged() },
			{ id: "persona", tools: ["memory_add"], groups: [] },
		];
		for (const selection of sources) {
			const active = sessions.toolsFor(selection);
			for (const tool of SHELL) expect(active).not.toContain(tool);
		}
	});
});

describe("the one check where a selection becomes active tools", () => {
	test("throws for any shell or file tool on a chat-only host, naming it", () => {
		for (const tool of SHELL) {
			expect(() =>
				factory("chat-only").toolsFor({
					tools: ["memory_add", tool],
					groups: [],
				}),
			).toThrow(ConfigError);
		}
		expect(() =>
			factory("chat-only").toolsFor({ tools: ["bash", "read"], groups: [] }),
		).toThrow(/names bash, read/);
		// A task beside a turn goes through the same check.
		expect(() =>
			factory("chat-only").taskTools({ tools: ["write"], groups: [] }, []),
		).toThrow(/names write/);
	});

	test("lets the shell through on a host that gives its agents the full tools", () => {
		const active = factory("full").toolsFor({
			tools: ["bash", "read"],
			groups: [],
		});
		expect(active).toEqual(expect.arrayContaining(["bash", "read"]));
	});

	test("a turn run through context.turns with a shell tool injected at run time fails closed and is logged", async () => {
		const sessions = factory("chat-only");
		const logged: string[] = [];
		const runtime = {
			// What the runtime does first with a turn's selection.
			runTurn: async (request: TurnRequest) => {
				sessions.toolsFor(request.selection);
				return { ok: true, text: "ran" };
			},
		} as unknown as AgentRuntime;
		const surfaces = {
			of: () => undefined,
			sendReply: async () => undefined,
			startTyping: () => () => undefined,
			showStop: () => () => undefined,
			interim: () => undefined,
		} as unknown as SurfacePort;
		const turns = conversationTurns({
			linked: () => undefined,
			runtime: () => runtime,
			surfaces,
			events: {
				turnStarted: () => undefined,
				turnEnded: () => undefined,
				changed: () => undefined,
			},
			selection: plugged,
			logger: {
				...silentLogger(),
				error: (fields: unknown, message?: string) => {
					logged.push(
						`${message} ${JSON.stringify((fields as { err?: unknown }).err instanceof Error ? (fields as { err: Error }).err.message : "")}`,
					);
				},
			},
		});
		const result = await turns.run({
			channel: "web:room",
			kind: "owner",
			text: "hi",
			speaker: OWNER_SPEAKER,
			selection: { id: "grant", tools: ["bash"], groups: [] },
		});
		expect(result.ok).toBe(false);
		expect(logged.join("\n")).toContain("turn failed");
		expect(logged.join("\n")).toContain("names bash");
	});
});

describe("registering plugins on a chat-only host", () => {
	const check = (agentTools: AgentTools, plugins: RoundtablePlugin[]) =>
		new Roundtable(options(agentTools), plugins).check();

	test("a plugin whose agentSelection names bash is a ConfigError at start", async () => {
		const plugin: RoundtablePlugin = {
			name: "shelly",
			setup: () => ({
				agentSelection: () => ({ tools: ["note_add", "bash"], groups: [] }),
			}),
		};
		await expect(check("chat-only", [plugin])).rejects.toThrow(
			/plugin shelly: agentSelection names bash/,
		);
		await expect(check("full", [plugin])).resolves.toMatchObject({
			plugins: ["shelly"],
		});
	});

	test("a plugin that declares hostAccess is a ConfigError naming hostAccess, before any setup", async () => {
		let setUp = false;
		const coding: RoundtablePlugin = {
			name: "coding",
			hostAccess: true,
			setup: () => {
				setUp = true;
				return { dashboard: ["coding"] };
			},
		};
		await expect(check("chat-only", [coding])).rejects.toThrow(
			/plugin coding declares hostAccess/,
		);
		expect(setUp).toBe(false);
		await expect(check("full", [coding])).resolves.toMatchObject({
			plugins: ["coding"],
		});
	});

	test("a plugin with ordinary tools and selection registers on a chat-only host", async () => {
		const notes: RoundtablePlugin = {
			name: "notes",
			setup: () => ({
				agentSelection: () => ({ tools: ["note_add"], groups: [] }),
			}),
		};
		await expect(check("chat-only", [notes])).resolves.toMatchObject({
			plugins: ["notes"],
		});
	});
});

describe("the agent's prompt", () => {
	const input = {
		agent: {
			name: "scout",
			displayName: "Scout",
			prompt: "Scout things.",
			avatarPrompt: "",
			channelId: "5",
			status: "active" as const,
		},
		shared: "",
		workDir: "/w",
		owner: {
			name: "Alice",
			pronouns: { subject: "she", object: "her", possessive: "her" },
		},
		shellUser: "alice-bot",
	};

	test("tells a chat-only agent it has no shell, file tools or workspace, and a full agent as before", () => {
		const chatOnly = agentSystemPrompt({ ...input, agentTools: "chat-only" });
		expect(chatOnly).toContain(
			"You have no shell or file tools and no workspace",
		);
		expect(chatOnly).not.toContain("alice-bot");
		expect(chatOnly).not.toContain("attach_file");
		const full = agentSystemPrompt(input);
		expect(full).toContain("Your shell and file tools run on");
		expect(agentSystemPrompt({ ...input, agentTools: "full" })).toBe(full);
	});
});
