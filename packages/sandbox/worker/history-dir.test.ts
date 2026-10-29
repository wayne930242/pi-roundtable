import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeHistory, userHistoryContent } from "../src/history.ts";
import { isSandboxTurn, type SandboxTurn } from "../src/protocol.ts";
import { runWorkerTurn } from "./agent.ts";
import { SandboxMemory } from "./memory.ts";

const turn: SandboxTurn = {
	text: "hello",
	speaker: { id: "alice", name: "Alice" },
	model: "fake",
	prompt: "Be helpful",
	timeZone: "UTC",
	tools: [],
	mcp: [],
};

test("with historyDir the worker reads and writes history in the channel directory and memory in the workspace", async () => {
	const root = mkdtempSync(join(tmpdir(), "sb-histdir-"));
	const workspace = join(root, "workspace");
	const channel = join(root, "channel");
	mkdirSync(workspace);
	mkdirSync(channel);
	try {
		writeFileSync(
			join(channel, "history.json"),
			encodeHistory([
				{
					role: "user",
					content: userHistoryContent(
						{ id: "x", name: "X" },
						"earlier question",
					),
				},
				{ role: "assistant", content: "earlier answer" },
			]),
		);
		// A history file in the shared workspace belongs to no channel and is never read.
		writeFileSync(join(workspace, "history.json"), "not json");
		let sent = "";
		const reply = await runWorkerTurn(
			{ ...turn, historyDir: "/channel" },
			{
				workspace,
				historyDir: channel,
				broker: async (_route, body) => {
					sent = JSON.stringify(body.messages);
					return { choices: [{ message: { content: "answer" } }] };
				},
			},
		);
		expect(reply).toEqual({ ok: true, text: "answer" });
		expect(sent).toContain("earlier question");
		const saved = JSON.parse(
			readFileSync(join(channel, "history.json"), "utf8"),
		);
		expect(saved.map((entry: { role: string }) => entry.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(saved[2].content).toBe(userHistoryContent(turn.speaker, "hello"));
		expect(readFileSync(join(workspace, "history.json"), "utf8")).toBe(
			"not json",
		);
		// Memory is the guild's: it stays in the workspace.
		new SandboxMemory(workspace).call(
			"memory_set",
			{ scope: "channel", key: "k", text: "t" },
			"alice",
		);
		expect(existsSync(join(workspace, "memory.json"))).toBe(true);
		expect(existsSync(join(channel, "memory.json"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("without historyDir history stays in the workspace, as before", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "sb-histdir-"));
	try {
		await runWorkerTurn(turn, {
			workspace,
			broker: async () => ({ choices: [{ message: { content: "answer" } }] }),
		});
		expect(existsSync(join(workspace, "history.json"))).toBe(true);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a history file written by encodeHistory is accepted, and the turn field is validated", () => {
	expect(isSandboxTurn({ ...turn, historyDir: "/channel" })).toBe(true);
	expect(isSandboxTurn({ ...turn, historyDir: "/workspace" })).toBe(false);
	expect(isSandboxTurn({ ...turn, historyDir: 3 })).toBe(false);
});
