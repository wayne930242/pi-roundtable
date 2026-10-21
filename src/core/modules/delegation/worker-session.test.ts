import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	type ExtensionFactory,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { AgentRunError } from "../../domain/errors.ts";
import { toolText } from "../../shared/tool-result.ts";
import { workerSessions } from "./worker-session.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

async function host(
	responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0],
) {
	const dir = mkdtempSync(join(tmpdir(), "worker-sessions-"));
	dirs.push(dir);
	const agentDir = join(dir, "login");
	mkdirSync(agentDir);
	const core = createFauxCore({ provider: "faux", models: [{ id: "worker" }] });
	core.setResponses(responses);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("faux", {
		api: core.api,
		apiKey: "test",
		baseUrl: "http://faux.invalid",
		streamSimple: core.streamSimple,
		models: [
			{
				id: "worker",
				name: "Worker",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
		],
	});
	return workerSessions({
		modelRuntime,
		agentDir,
		workDir: join(dir, "work"),
		delegation: { model: "faux/worker", thinking: "off" },
	});
}

const probeTool =
	(calls: string[], name: string): ExtensionFactory =>
	(pi) => {
		pi.registerTool({
			name,
			label: name,
			description: `the ${name} tool`,
			parameters: { type: "object", properties: {} } as never,
			execute: async () => {
				calls.push(name);
				return toolText(`${name} ran`);
			},
		});
	};

test("a worker session runs the given tools, returns its last answer, and exposes the host's delegation settings", async () => {
	const seen: string[][] = [];
	const sessions = await host([
		fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
		(context) => {
			seen.push(
				context.messages
					.filter((message) => message.role === "toolResult")
					.map((message) => JSON.stringify(message.content)),
			);
			return fauxAssistantMessage("report: done");
		},
	]);
	const calls: string[] = [];
	expect(sessions.delegation).toEqual({
		model: "faux/worker",
		thinking: "off",
	});
	const report = await sessions.run({
		task: "do it",
		prompt: "You are a probe worker.",
		signal: new AbortController().signal,
		extensions: [probeTool(calls, "probe")],
		toolNames: ["probe"],
	});
	expect(report).toBe("report: done");
	expect(calls).toEqual(["probe"]);
	expect(seen[0]?.[0]).toContain("probe ran");
});

test("only the named tools are active, even when an extension registers more", async () => {
	const sessions = await host([
		fauxAssistantMessage(fauxToolCall("hidden", {}), { stopReason: "toolUse" }),
		(context) =>
			fauxAssistantMessage(
				`results=${JSON.stringify(context.messages.filter((message) => message.role === "toolResult"))}`,
			),
	]);
	const calls: string[] = [];
	const report = await sessions.run({
		task: "try the hidden tool",
		prompt: "p",
		signal: new AbortController().signal,
		extensions: [probeTool(calls, "probe"), probeTool(calls, "hidden")],
		toolNames: ["probe"],
	});
	expect(calls).toEqual([]);
	expect(report).toContain("hidden");
	expect(report).toContain("not found");
});

test("aborting the signal rejects the run with the aborted message", async () => {
	const controller = new AbortController();
	const sessions = await host([
		() => {
			controller.abort();
			return fauxAssistantMessage("late", { stopReason: "aborted" });
		},
	]);
	await expect(
		sessions.run({
			task: "t",
			prompt: "p",
			signal: controller.signal,
			extensions: [],
			toolNames: [],
			aborted: "stopped by the test",
		}),
	).rejects.toThrow(AgentRunError);
});
