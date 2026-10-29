import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FILES_DEFAULTS,
	isSandboxTurn,
	type SandboxTurn,
} from "../src/protocol.ts";
import { runWorkerTurn } from "./agent.ts";
import { FILE_TOOLS, WorkspaceFiles } from "./files.ts";

function fixture(limits = FILES_DEFAULTS, resultBytes = 4096) {
	const workspace = mkdtempSync(join(tmpdir(), "sb-files-"));
	return {
		workspace,
		files: new WorkspaceFiles(workspace, limits, resultBytes),
		cleanup: () => rmSync(workspace, { recursive: true, force: true }),
	};
}

test("the four tools are declared with their schemas", () => {
	expect(FILE_TOOLS.map((tool) => tool.name)).toEqual([
		"files_list",
		"files_read",
		"files_write",
		"files_delete",
	]);
});

test("write creates parent directories, replaces, and keeps files private under files/", () => {
	const f = fixture();
	try {
		expect(
			f.files.call("files_write", { path: "notes/a/b.md", content: "你好" }),
		).toContain("Wrote");
		expect(readFileSync(join(f.workspace, "files/notes/a/b.md"), "utf8")).toBe(
			"你好",
		);
		expect(statSync(join(f.workspace, "files/notes/a/b.md")).mode & 0o777).toBe(
			0o600,
		);
		expect(statSync(join(f.workspace, "files/notes")).mode & 0o777).toBe(0o700);
		f.files.call("files_write", { path: "notes/a/b.md", content: "新" });
		expect(f.files.call("files_read", { path: "notes/a/b.md" })).toBe("新");
		// No temporary file is left behind, and nothing outside files/ was touched.
		expect(readdirSync(join(f.workspace, "files/notes/a"))).toEqual(["b.md"]);
		expect(readdirSync(f.workspace)).toEqual(["files"]);
	} finally {
		f.cleanup();
	}
});

test.each([
	"../x",
	"a/../../x",
	"/etc/passwd",
	"a//b",
	"a/",
	"",
	"a/./b",
	"a\0b",
	"..",
	`${"a/".repeat(20)}b`,
	"a".repeat(300),
])("path %p is refused everywhere", (path) => {
	const f = fixture();
	try {
		for (const name of ["files_read", "files_write", "files_delete"] as const)
			expect(f.files.call(name, { path, content: "x" })).toStartWith("Error:");
		expect(f.files.call("files_list", { path })).toStartWith("Error:");
		expect(existsSync(join(f.workspace, "x"))).toBe(false);
	} finally {
		f.cleanup();
	}
});

test("a symlink at any segment is refused, for the file, a parent, and the root", () => {
	const f = fixture();
	try {
		const outside = mkdtempSync(join(tmpdir(), "sb-outside-"));
		writeFileSync(join(outside, "secret.txt"), "secret");
		mkdirSync(join(f.workspace, "files/real"), { recursive: true });
		symlinkSync(outside, join(f.workspace, "files/link"));
		symlinkSync(
			join(outside, "secret.txt"),
			join(f.workspace, "files/real/leak.txt"),
		);
		for (const path of ["link/secret.txt", "link", "real/leak.txt"]) {
			expect(f.files.call("files_read", { path })).toStartWith("Error:");
			expect(f.files.call("files_write", { path, content: "x" })).toStartWith(
				"Error:",
			);
			expect(f.files.call("files_delete", { path })).toStartWith("Error:");
		}
		expect(
			f.files.call("files_write", { path: "link/new.txt", content: "x" }),
		).toStartWith("Error:");
		expect(existsSync(join(outside, "new.txt"))).toBe(false);
		expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
		// A listing does not follow links either.
		expect(f.files.call("files_list", {})).not.toContain("secret");
		expect(f.files.call("files_list", { path: "link" })).toStartWith("Error:");
		rmSync(join(f.workspace, "files"), { recursive: true });
		symlinkSync(outside, join(f.workspace, "files"));
		expect(
			f.files.call("files_write", { path: "x.txt", content: "x" }),
		).toStartWith("Error:");
		expect(f.files.call("files_list", {})).toStartWith("Error:");
		rmSync(outside, { recursive: true, force: true });
	} finally {
		f.cleanup();
	}
});

test("memory and history are not reachable through the tools", () => {
	const f = fixture();
	try {
		writeFileSync(join(f.workspace, "memory.json"), "[]");
		writeFileSync(join(f.workspace, "history.json"), "[]");
		for (const path of ["memory.json", "history.json", "../memory.json"])
			expect(f.files.call("files_read", { path })).toStartWith("Error:");
		expect(f.files.call("files_list", {})).not.toContain("memory");
		expect(
			f.files.call("files_write", { path: "memory.json", content: "x" }),
		).toContain("Wrote");
		expect(readFileSync(join(f.workspace, "memory.json"), "utf8")).toBe("[]");
	} finally {
		f.cleanup();
	}
});

test("the per-file and total limits refuse a write whole, counting UTF-8 bytes and what the write replaces", () => {
	const f = fixture({ maxFileBytes: 30, maxTotalBytes: 50 });
	try {
		expect(
			f.files.call("files_write", { path: "a", content: "字".repeat(11) }),
		).toContain("30 bytes");
		expect(existsSync(join(f.workspace, "files/a"))).toBe(false);
		expect(
			f.files.call("files_write", { path: "a", content: "字".repeat(10) }),
		).toContain("Wrote");
		expect(
			f.files.call("files_write", { path: "d/b", content: "x".repeat(20) }),
		).toContain("Wrote");
		// 30 + 20 = 50 is full: another byte is over, but replacing a file in place is judged by the net.
		expect(f.files.call("files_write", { path: "c", content: "x" })).toContain(
			"50 bytes",
		);
		expect(existsSync(join(f.workspace, "files/c"))).toBe(false);
		expect(
			f.files.call("files_write", { path: "d/b", content: "y".repeat(20) }),
		).toContain("Wrote");
		expect(f.files.call("files_write", { path: "a", content: "z" })).toContain(
			"Wrote",
		);
		expect(
			f.files.call("files_write", { path: "c", content: "x".repeat(29) }),
		).toContain("Wrote");
		expect(readdirSync(join(f.workspace, "files")).sort()).toEqual([
			"a",
			"c",
			"d",
		]);
	} finally {
		f.cleanup();
	}
});

test("default limits are 256 KiB per file and 32 MiB in total", () => {
	expect(FILES_DEFAULTS).toEqual({
		maxFileBytes: 256 * 1024,
		maxTotalBytes: 32 * 1024 * 1024,
	});
});

test("list is recursive, sorted, shows sizes, skips links, and caps at 500 entries with a note", () => {
	const f = fixture();
	try {
		f.files.call("files_write", { path: "b/two.txt", content: "22" });
		f.files.call("files_write", { path: "a.txt", content: "1" });
		mkdirSync(join(f.workspace, "files/empty"));
		const all = f.files.call("files_list", {});
		expect(all.split("\n")).toEqual([
			"a.txt (1 bytes)",
			"b/two.txt (2 bytes)",
			"empty/",
		]);
		expect(f.files.call("files_list", { path: "b" })).toBe(
			"b/two.txt (2 bytes)",
		);
		expect(f.files.call("files_list", { path: "missing" })).toStartWith(
			"Error:",
		);
		for (let index = 0; index < 520; index++)
			writeFileSync(
				join(f.workspace, "files", `f${String(index).padStart(3, "0")}`),
				"x",
			);
		const capped = new WorkspaceFiles(f.workspace, FILES_DEFAULTS, 32_768).call(
			"files_list",
			{},
		);
		expect(
			capped.split("\n").filter((line) => !line.startsWith("[")).length,
		).toBe(500);
		expect(capped).toContain("more");
	} finally {
		f.cleanup();
	}
});

test("a listing also stops before it outgrows the result budget", () => {
	const f = fixture(FILES_DEFAULTS, 600);
	try {
		mkdirSync(join(f.workspace, "files"));
		for (let index = 0; index < 100; index++)
			writeFileSync(
				join(f.workspace, "files", `${"n".repeat(40)}${index}`),
				"x",
			);
		const listed = f.files.call("files_list", {});
		expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThanOrEqual(600);
		expect(listed).toContain("more");
	} finally {
		f.cleanup();
	}
});

test("read pages by character offset and names the next offset on the first line", () => {
	const f = fixture(FILES_DEFAULTS, 300);
	try {
		const text = "字".repeat(500);
		f.files.call("files_write", { path: "long.txt", content: text });
		let offset = 0;
		let rebuilt = "";
		let pages = 0;
		for (;;) {
			const page = f.files.call("files_read", { path: "long.txt", offset });
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(300);
			const [first = "", ...rest] = page.split("\n");
			const next = /^\[More: next offset (\d+)\]$/.exec(first);
			rebuilt += next ? rest.join("\n") : page;
			pages++;
			if (!next) break;
			expect(Number(next[1])).toBeGreaterThan(offset);
			offset = Number(next[1]);
		}
		expect(rebuilt).toBe(text);
		expect(pages).toBeGreaterThan(1);
		expect(
			f.files.call("files_read", { path: "long.txt", offset: 500 }),
		).toContain("end");
		expect(
			f.files.call("files_read", { path: "long.txt", offset: 501 }),
		).toStartWith("Error:");
		expect(
			f.files.call("files_read", { path: "long.txt", offset: -1 }),
		).toStartWith("Error:");
		expect(
			f.files.call("files_read", { path: "long.txt", offset: 1.5 }),
		).toStartWith("Error:");
		expect(f.files.call("files_read", { path: "nope.txt" })).toStartWith(
			"Error:",
		);
	} finally {
		f.cleanup();
	}
});

test("a page never splits a surrogate pair", () => {
	const f = fixture(FILES_DEFAULTS, 120);
	try {
		const text = "😀".repeat(100);
		f.files.call("files_write", { path: "e.txt", content: text });
		let offset = 0;
		let rebuilt = "";
		for (let guard = 0; guard < 200; guard++) {
			const page = f.files.call("files_read", { path: "e.txt", offset });
			const [first = "", ...rest] = page.split("\n");
			const next = /^\[More: next offset (\d+)\]$/.exec(first);
			const body = next ? rest.join("\n") : page;
			expect(body).toBe(body.toWellFormed());
			rebuilt += body;
			if (!next) break;
			offset = Number(next[1]);
		}
		expect(rebuilt).toBe(text);
	} finally {
		f.cleanup();
	}
});

test("delete removes a file or an empty directory and refuses a non-empty one and the root", () => {
	const f = fixture();
	try {
		f.files.call("files_write", { path: "d/x.txt", content: "x" });
		expect(f.files.call("files_delete", { path: "d" })).toStartWith("Error:");
		expect(f.files.call("files_delete", { path: "d/x.txt" })).toContain(
			"Deleted",
		);
		expect(f.files.call("files_delete", { path: "d" })).toContain("Deleted");
		expect(existsSync(join(f.workspace, "files/d"))).toBe(false);
		expect(f.files.call("files_delete", { path: "d" })).toStartWith("Error:");
		expect(existsSync(join(f.workspace, "files"))).toBe(true);
	} finally {
		f.cleanup();
	}
});

test("bad arguments come back as errors the model can read", () => {
	const f = fixture();
	try {
		expect(f.files.call("files_write", { path: "a", content: 3 })).toStartWith(
			"Error:",
		);
		expect(f.files.call("files_write", { path: 3, content: "x" })).toStartWith(
			"Error:",
		);
		expect(f.files.call("files_read", {})).toStartWith("Error:");
		expect(f.files.call("files_unknown", {})).toStartWith("Error:");
	} finally {
		f.cleanup();
	}
});

const turn: SandboxTurn = {
	text: "go",
	speaker: { id: "alice", name: "Alice" },
	model: "fake",
	prompt: "Be helpful",
	timeZone: "UTC",
	tools: [],
	mcp: [],
};

test("the worker offers file tools only when the turn enables them, and they run without the broker", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "sb-files-"));
	try {
		const routes: string[] = [];
		const offered: string[][] = [];
		let step = 0;
		const broker = async (route: string, body: Record<string, unknown>) => {
			routes.push(route);
			offered.push(
				(body.tools as { function: { name: string } }[]).map(
					(tool) => tool.function.name,
				),
			);
			step++;
			if (step === 1)
				return {
					choices: [
						{
							message: {
								tool_calls: [
									{
										id: "w",
										function: {
											name: "files_write",
											arguments: JSON.stringify({
												path: "hello.txt",
												content: "hi",
											}),
										},
									},
								],
							},
						},
					],
				};
			return { choices: [{ message: { content: "done" } }] };
		};
		await runWorkerTurn(
			{ ...turn, files: FILES_DEFAULTS },
			{ workspace, broker },
		);
		expect(routes).toEqual(["/model", "/model"]);
		expect(offered[0]).toContain("files_list");
		expect(readFileSync(join(workspace, "files/hello.txt"), "utf8")).toBe("hi");
		const plain = mkdtempSync(join(tmpdir(), "sb-files-"));
		await runWorkerTurn(turn, { workspace: plain, broker });
		expect(offered.at(-1)).not.toContain("files_list");
		rmSync(plain, { recursive: true, force: true });
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("the turn's files field is validated", () => {
	expect(isSandboxTurn({ ...turn, files: FILES_DEFAULTS })).toBe(true);
	expect(
		isSandboxTurn({ ...turn, files: { maxFileBytes: 0, maxTotalBytes: 10 } }),
	).toBe(false);
	expect(isSandboxTurn({ ...turn, files: { maxFileBytes: 10 } })).toBe(false);
	expect(isSandboxTurn({ ...turn, files: true })).toBe(false);
	expect(
		isSandboxTurn({ ...turn, files: { maxFileBytes: 20, maxTotalBytes: 10 } }),
	).toBe(false);
});
