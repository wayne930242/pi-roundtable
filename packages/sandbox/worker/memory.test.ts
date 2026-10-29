import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkerTurn } from "./agent.ts";
import { SandboxMemory } from "./memory.ts";

test("memory namespaces are speaker-bound, shared notes are channel-bound, and entries persist", () => {
	const root = mkdtempSync(join(tmpdir(), "sandbox-memory-"));
	try {
		const a = new SandboxMemory(join(root, "a"));
		const b = new SandboxMemory(join(root, "b"));
		a.call(
			"memory_set",
			{ scope: "speaker", key: "drink", text: "Tea", speaker: "victim" },
			"alice",
		);
		expect(a.call("memory_get", { scope: "speaker" }, "bob")).toBe("[]");
		expect(b.call("memory_get", { scope: "speaker" }, "alice")).toBe("[]");
		a.call(
			"memory_set",
			{ scope: "channel", key: "meeting", text: "Wednesday" },
			"alice",
		);
		expect(
			a.call("memory_get", { scope: "channel", query: "wednesday" }, "bob"),
		).toContain("Wednesday");
		expect(
			new SandboxMemory(join(root, "a")).call(
				"memory_get",
				{ scope: "speaker", key: "drink" },
				"alice",
			),
		).toContain("Tea");
		a.call("memory_remove", { scope: "speaker", key: "drink" }, "alice");
		expect(a.call("memory_get", { scope: "speaker" }, "alice")).toBe("[]");
		expect(a.call("memory_get", { scope: "channel" }, "alice")).toContain(
			"Wednesday",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("memory values are data, never filesystem paths, and limits fail without destroying prior entries", () => {
	const root = mkdtempSync(join(tmpdir(), "sandbox-memory-"));
	try {
		const store = new SandboxMemory(root);
		store.call(
			"memory_set",
			{ scope: "speaker", key: "../../host", text: "plain data" },
			"../../person",
		);
		expect(
			store.call(
				"memory_get",
				{ scope: "speaker", key: "../../host" },
				"../../person",
			),
		).toContain("plain data");
		expect(() =>
			store.call(
				"memory_set",
				{ scope: "owner", key: "x", text: "x" },
				"alice",
			),
		).toThrow();
		expect(() =>
			store.call(
				"memory_set",
				{ scope: "speaker", key: "x", text: "x".repeat(2049) },
				"alice",
			),
		).toThrow();
		expect(() =>
			store.call("bash", { scope: "speaker", key: "x" }, "alice"),
		).toThrow();
		expect(
			store.call("memory_get", { scope: "speaker" }, "../../person"),
		).toContain("plain data");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("in a server workspace the memory tools and the system line say the notes are shared by every channel of the server", async () => {
	const turn = {
		text: "hi",
		speaker: { id: "alice", name: "Alice" },
		model: "fake",
		prompt: "Be helpful",
		timeZone: "UTC",
		tools: [],
		mcp: [],
	};
	const seen: Record<"channel" | "server", { text: string; system: string }> = {
		channel: { text: "", system: "" },
		server: { text: "", system: "" },
	};
	for (const mode of ["channel", "server"] as const) {
		const root = mkdtempSync(join(tmpdir(), "sandbox-memory-"));
		try {
			await runWorkerTurn(
				mode === "server" ? { ...turn, historyDir: "/channel" } : turn,
				{
					workspace: root,
					historyDir: root,
					broker: async (_route, body) => {
						seen[mode].text = JSON.stringify(body.tools);
						seen[mode].system = String(
							(body.messages as { content: string }[])[0]?.content,
						);
						return { choices: [{ message: { content: "ok" } }] };
					},
				},
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	expect(seen.server.text).toContain("every channel of the server");
	expect(seen.server.system).toContain("every channel of the server");
	expect(seen.server.system).not.toContain("Shared channel notes");
	expect(seen.channel.text).not.toContain("server");
	expect(seen.channel.system).toContain("Shared channel notes");
});
