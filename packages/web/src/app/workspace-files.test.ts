import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingLogger } from "pi-roundtable/testing";
import {
	checkRoots,
	WorkspaceConflictError,
	WorkspaceFiles,
	WorkspaceRefusal,
	type WorkspaceRoot,
} from "./workspace-files.ts";

const hex = (data: ArrayBufferLike | Uint8Array): string =>
	Buffer.from(data as ArrayBuffer).toString("hex");
const sha = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");

/** A sandbox outside the repository: `base/root` is the workspace, `base/outside` is what must stay untouched. */
let base: string;
let root: string;
let outside: string;
let log: ReturnType<typeof recordingLogger>;
let hooks: { beforeReplace?: (tmp: string, target: string) => void };

const OWNER = "owner:1";

function files(extra: Partial<WorkspaceRoot>[] = []) {
	const roots: WorkspaceRoot[] = [
		{ id: "agents", label: "Agents", dir: root, writable: true },
		...extra.map(
			(part, index) =>
				({
					id: `extra${index}`,
					label: `Extra ${index}`,
					dir: join(base, `extra${index}`),
					writable: false,
					...part,
				}) satisfies WorkspaceRoot,
		),
	];
	return new WorkspaceFiles({ roots, logger: log.logger, hooks });
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "rt-workspace-"));
	root = join(base, "root");
	outside = join(base, "outside");
	mkdirSync(root);
	mkdirSync(outside);
	writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
	writeFileSync(join(base, "sibling.txt"), "SIBLING");
	log = recordingLogger();
	hooks = {};
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

/** The refusal a promise ends in, or a failing expectation. */
async function refused(promise: Promise<unknown>): Promise<WorkspaceRefusal> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(WorkspaceRefusal);
		return error as WorkspaceRefusal;
	}
	throw new Error("expected a refusal");
}

async function conflict(
	promise: Promise<unknown>,
): Promise<WorkspaceConflictError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(WorkspaceConflictError);
		return error as WorkspaceConflictError;
	}
	throw new Error("expected a conflict");
}

const untouched = () => {
	expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP SECRET");
	expect(readFileSync(join(base, "sibling.txt"), "utf8")).toBe("SIBLING");
	expect(readdirSync(outside)).toEqual(["secret.txt"]);
};

describe("the roots", () => {
	test("are listed by id, label and whether they can be written, never by path", () => {
		const view = files([{ writable: false }]).roots();
		expect(view).toEqual([
			{ id: "agents", label: "Agents", writable: true },
			{ id: "extra0", label: "Extra 0", writable: false },
		]);
		expect(JSON.stringify(view)).not.toContain(base);
	});

	test("an unknown id is refused", async () => {
		const refusal = await refused(files().list("nope", ""));
		expect(refusal.status).toBe(404);
		expect(refusal.reason).toBe("unknown-root");
	});

	test("a root that is, or contains, a protected directory is refused at the start", () => {
		const data = join(base, "root", "data");
		mkdirSync(data);
		const roots = (dir: string): WorkspaceRoot[] => [
			{ id: "a", label: "A", dir, writable: true },
		];
		expect(() => checkRoots(roots(data), [data])).toThrow(/data/);
		expect(() => checkRoots(roots(root), [data])).toThrow(/contains/);
		expect(() => checkRoots(roots(base), [data])).toThrow(/contains/);
		// A symlink to the protected directory is the same directory.
		const link = join(base, "link");
		symlinkSync(data, link);
		expect(() => checkRoots(roots(link), [data])).toThrow(/data/);
		// Beside it, or inside it, is fine.
		expect(() => checkRoots(roots(outside), [data])).not.toThrow();
		expect(() => checkRoots(roots(join(data, "work")), [data])).not.toThrow();
	});

	test("a duplicate id, an id that is not a word, or a relative directory is refused", () => {
		const dir = outside;
		expect(() =>
			checkRoots(
				[
					{ id: "a", label: "A", dir, writable: false },
					{ id: "a", label: "B", dir, writable: false },
				],
				[],
			),
		).toThrow(/twice/);
		expect(() =>
			checkRoots([{ id: "a/b", label: "A", dir, writable: false }], []),
		).toThrow(/id/);
		expect(() =>
			checkRoots(
				[{ id: "a", label: "A", dir: "relative", writable: false }],
				[],
			),
		).toThrow(/absolute/);
	});
});

describe("paths", () => {
	const bad = [
		"../sibling.txt",
		"a/../../sibling.txt",
		"/etc/passwd",
		"..",
		"a//b",
		"a/",
		"./a",
		"a/./b",
		"nul\0byte",
		`${"x".repeat(5000)}`,
		`${"é".repeat(2100)}`,
	];

	test("traversal, absolute, empty-segment and oversize paths are refused as bad, before the file system is asked", async () => {
		const service = files();
		for (const path of bad) {
			for (const call of [
				() => service.list("agents", path),
				() => service.read("agents", path),
				() => service.raw("agents", path, false),
				() =>
					service.save("agents", path, { text: "x", baseHash: sha("") }, OWNER),
				() => service.create("agents", path, { kind: "file" }, OWNER),
				() => service.remove("agents", path, OWNER),
			]) {
				const refusal = await refused(call());
				expect(refusal.status).toBe(400);
				expect(refusal.reason).toBe("bad-path");
			}
		}
		untouched();
	});

	test("a path is decoded once by the caller: a literal %2e%2e is just a name", async () => {
		const service = files();
		await service.create("agents", "%2e%2e", { kind: "dir" }, OWNER);
		expect(existsSync(join(root, "%2e%2e"))).toBe(true);
		untouched();
	});

	test("a missing root directory lists as empty and is never created", async () => {
		const service = files([{ dir: join(base, "later") }]);
		const view = await service.list("extra0", "");
		expect(view).toMatchObject({
			entries: [],
			truncated: false,
			missing: true,
		});
		expect(existsSync(join(base, "later"))).toBe(false);
	});

	test("a refused escape is logged as a warning without content", async () => {
		await refused(files().read("agents", "../sibling.txt"));
		const warn = log.lines.find((line) => line.level === "warn");
		expect(warn?.message).toBe("workspace path refused");
		expect(warn?.fields).toMatchObject({ root: "agents", reason: "bad-path" });
		expect(JSON.stringify(log.lines)).not.toContain("SIBLING");
	});
});

describe("symlinks", () => {
	beforeEach(() => {
		symlinkSync(join(outside, "secret.txt"), join(root, "out-file"));
		symlinkSync(outside, join(root, "out-dir"));
		writeFileSync(join(root, "real.txt"), "inside");
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "inner.txt"), "inner");
		symlinkSync(join(root, "real.txt"), join(root, "in-file"));
		symlinkSync(join(root, "sub"), join(root, "in-dir"));
	});

	test("are listed with where they point, and the outside ones are never opened", async () => {
		const view = await files().list("agents", "");
		const byName = Object.fromEntries(
			view.entries.map((entry) => [entry.name, entry]),
		);
		expect(byName["out-file"]).toMatchObject({
			kind: "symlink",
			inside: false,
		});
		expect(byName["out-dir"]).toMatchObject({ kind: "symlink", inside: false });
		expect(byName["in-file"]).toMatchObject({
			kind: "symlink",
			inside: true,
			target: "file",
		});
		expect(byName["in-dir"]).toMatchObject({
			kind: "symlink",
			inside: true,
			target: "dir",
		});
		expect(JSON.stringify(view)).not.toContain(outside);
	});

	test("read, list and write through an outside link or a link's directory are refused", async () => {
		const service = files();
		for (const call of [
			() => service.read("agents", "out-file"),
			() => service.raw("agents", "out-file", false),
			() => service.list("agents", "out-dir"),
			() => service.read("agents", "out-dir/secret.txt"),
			() =>
				service.save(
					"agents",
					"out-dir/secret.txt",
					{ text: "pwned", baseHash: sha("TOP SECRET") },
					OWNER,
				),
			() =>
				service.create("agents", "out-dir/new.txt", { kind: "file" }, OWNER),
			() => service.create("agents", "out-dir/new", { kind: "dir" }, OWNER),
			() => service.rename("agents", "real.txt", "out-dir/real.txt", OWNER),
			() => service.rename("agents", "out-dir/secret.txt", "moved.txt", OWNER),
			() => service.remove("agents", "out-dir/secret.txt", OWNER),
		]) {
			const refusal = await refused(call());
			expect(refusal.status).toBe(403);
			expect(refusal.reason).toBe("outside");
		}
		untouched();
	});

	test("a save never writes through a link, even one that points inside", async () => {
		const service = files();
		for (const path of ["out-file", "in-file"]) {
			const refusal = await refused(
				service.save(
					"agents",
					path,
					{ text: "pwned", baseHash: sha("TOP SECRET") },
					OWNER,
				),
			);
			expect(refusal.status).toBe(403);
		}
		expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("inside");
		untouched();
	});

	test("a link inside the root opens as its target", async () => {
		const service = files();
		const view = await service.read("agents", "in-file");
		expect(view.text).toBe("inside");
		expect(view.editable).toBe(false);
		expect(view.reason).toBe("symlink");
		const listed = await service.list("agents", "in-dir");
		expect(listed.entries.map((entry) => entry.name)).toEqual(["inner.txt"]);
		expect((await service.read("agents", "in-dir/inner.txt")).editable).toBe(
			true,
		);
	});

	test("a link whose directory is swapped in between the checks and the rename is refused, and the temporary file is emptied", async () => {
		const service = files();
		writeFileSync(join(root, "sub", "doc.txt"), "one");
		hooks.beforeReplace = () => {
			// The directory is replaced by a link to the outside while the temporary file is written.
			renameSync(join(root, "sub"), join(root, "sub-away"));
			symlinkSync(outside, join(root, "sub"));
		};
		const refusal = await refused(
			service.save(
				"agents",
				"sub/doc.txt",
				{ text: "two", baseHash: sha("one") },
				OWNER,
			),
		);
		expect(refusal.status).toBe(403);
		untouched();
		expect(readFileSync(join(root, "sub-away", "doc.txt"), "utf8")).toBe("one");
		// The directory was moved away, so the temporary file cannot be found to delete: it is emptied.
		const left = readdirSync(join(root, "sub-away")).filter((name) =>
			name.endsWith(".tmp"),
		);
		for (const name of left)
			expect(statSync(join(root, "sub-away", name)).size).toBe(0);
	});

	test("a file swapped for a link between the checks and the rename is refused", async () => {
		const service = files();
		writeFileSync(join(root, "doc.txt"), "one");
		hooks.beforeReplace = (_tmp, target) => {
			rmSync(target);
			symlinkSync(join(outside, "secret.txt"), target);
		};
		await refused(
			service.save(
				"agents",
				"doc.txt",
				{ text: "two", baseHash: sha("one") },
				OWNER,
			),
		);
		untouched();
		expect(lstatSync(join(root, "doc.txt")).isSymbolicLink()).toBe(true);
		expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual(
			[],
		);
	});
});

describe("special files", () => {
	test("a FIFO is listed as other and refused without blocking", async () => {
		const made = Bun.spawnSync(["mkfifo", join(root, "pipe")]);
		expect(made.exitCode).toBe(0);
		const service = files();
		const view = await service.list("agents", "");
		expect(view.entries.find((entry) => entry.name === "pipe")?.kind).toBe(
			"other",
		);
		for (const call of [
			() => service.read("agents", "pipe"),
			() => service.raw("agents", "pipe", true),
			() =>
				service.save("agents", "pipe", { text: "x", baseHash: sha("") }, OWNER),
		]) {
			const refusal = await refused(call());
			expect(refusal.status).toBe(403);
			expect(refusal.reason).toBe("special");
		}
		expect(log.lines.some((line) => line.level === "warn")).toBe(true);
	}, 1000);
});

describe("caps", () => {
	test("a directory lists its first 2,000 entries and says there are more", async () => {
		mkdirSync(join(root, "many"));
		for (let i = 0; i < 2001; i++)
			writeFileSync(join(root, "many", `f${i}`), "");
		const view = await files().list("agents", "many");
		expect(view.entries).toHaveLength(2000);
		expect(view.truncated).toBe(true);
		const exact = await files().list("agents", "");
		expect(exact.truncated).toBe(false);
	});

	test("listing puts folders first, then names with numbers in order", async () => {
		for (const name of ["a10", "a2", "B", "z"])
			writeFileSync(join(root, name), "");
		for (const name of ["zdir", "adir"]) mkdirSync(join(root, name));
		const names = (await files().list("agents", "")).entries.map(
			(entry) => entry.name,
		);
		expect(names).toEqual(["adir", "zdir", "a2", "a10", "B", "z"]);
	});

	test("a file over 2 MiB is metadata only; one over 1 MiB is shown but not edited", async () => {
		writeFileSync(join(root, "huge.txt"), "a".repeat(2 * 1024 * 1024 + 1));
		const huge = await files().read("agents", "huge.txt");
		expect(huge).toMatchObject({
			tooLarge: true,
			editable: false,
			reason: "too-large",
		});
		expect(huge.text).toBeUndefined();
		writeFileSync(join(root, "big.txt"), "a".repeat(1024 * 1024 + 1));
		const big = await files().read("agents", "big.txt");
		expect(big).toMatchObject({
			tooLarge: false,
			editable: false,
			reason: "too-large",
		});
		expect(big.text).toHaveLength(1024 * 1024 + 1);
		const refusal = await refused(
			files().save(
				"agents",
				"big.txt",
				{ text: "x", baseHash: big.hash },
				OWNER,
			),
		);
		expect(refusal.reason).toBe("too-large");
	});

	test("a text over 1 MiB is refused as too large to save, and nothing changes", async () => {
		writeFileSync(join(root, "doc.txt"), "one");
		const refusal = await refused(
			files().save(
				"agents",
				"doc.txt",
				{ text: "a".repeat(1024 * 1024 + 1), baseHash: sha("one") },
				OWNER,
			),
		);
		expect(refusal.status).toBe(413);
		expect(readFileSync(join(root, "doc.txt"), "utf8")).toBe("one");
		// A text of exactly 1 MiB is accepted.
		await files().save(
			"agents",
			"doc.txt",
			{ text: "a".repeat(1024 * 1024), baseHash: sha("one") },
			OWNER,
		);
	});

	test("the size is of bytes, not characters", async () => {
		writeFileSync(join(root, "doc.txt"), "one");
		const refusal = await refused(
			files().save(
				"agents",
				"doc.txt",
				{ text: "é".repeat(600 * 1024), baseHash: sha("one") },
				OWNER,
			),
		);
		expect(refusal.status).toBe(413);
	});
});

describe("binary and encoding", () => {
	test("a NUL byte makes a file binary; it is read-only and a save is refused", async () => {
		const bytes = Buffer.from([0x68, 0x69, 0x00, 0x21]);
		writeFileSync(join(root, "data.bin"), bytes);
		const view = await files().read("agents", "data.bin");
		expect(view).toMatchObject({
			binary: true,
			editable: false,
			reason: "binary",
		});
		expect(view.text).toBeUndefined();
		const refusal = await refused(
			files().save(
				"agents",
				"data.bin",
				{ text: "x", baseHash: sha(bytes) },
				OWNER,
			),
		);
		expect(refusal.status).toBe(403);
		expect(refusal.reason).toBe("binary");
		expect(readFileSync(join(root, "data.bin"))).toEqual(bytes);
	});

	test("invalid UTF-8 is read-only, not binary", async () => {
		const bytes = Buffer.from([0x68, 0xff, 0xfe, 0x69]);
		writeFileSync(join(root, "latin.txt"), bytes);
		const view = await files().read("agents", "latin.txt");
		expect(view).toMatchObject({ editable: false, reason: "not-utf8" });
		expect(view.text).toBeUndefined();
		const refusal = await refused(
			files().save(
				"agents",
				"latin.txt",
				{ text: "x", baseHash: sha(bytes) },
				OWNER,
			),
		);
		expect(refusal.reason).toBe("not-utf8");
	});

	test("an image is recognised by its bytes, and the language by the name", async () => {
		const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
		writeFileSync(join(root, "pic.dat"), png);
		expect((await files().read("agents", "pic.dat")).media).toBe("image");
		for (const [name, language] of [
			["a.ts", "typescript"],
			["a.tsx", "typescript"],
			["a.mjs", "javascript"],
			["a.py", "python"],
			["a.md", "markdown"],
			["a.yml", "yaml"],
			["a.yaml", "yaml"],
			["a.json", "json"],
			["a.sh", "shell"],
			[".bashrc", "shell"],
			["Dockerfile", "dockerfile"],
			["a.toml", "toml"],
			["a.unknown", "plain"],
			["noext", "plain"],
		] as const) {
			writeFileSync(join(root, name), "x");
			expect((await files().read("agents", name)).language).toBe(language);
		}
	});
});

describe("saving", () => {
	test("replaces the text when the hash matches, and answers the new hash", async () => {
		writeFileSync(join(root, "doc.txt"), "one\n");
		const service = files();
		const view = await service.read("agents", "doc.txt");
		expect(view).toMatchObject({
			text: "one\n",
			hash: sha("one\n"),
			editable: true,
			eol: "\n",
			bom: false,
		});
		const saved = await service.save(
			"agents",
			"doc.txt",
			{ text: "two\n", baseHash: view.hash },
			OWNER,
		);
		expect(saved.hash).toBe(sha("two\n"));
		expect(saved.size).toBe(4);
		expect(readFileSync(join(root, "doc.txt"), "utf8")).toBe("two\n");
		expect(readdirSync(root)).toEqual(["doc.txt"]);
	});

	test("keeps the mode, a CRLF separator, a byte order mark and a missing final newline", async () => {
		const original = Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from("a\r\nb\r\nc"),
		]);
		writeFileSync(join(root, "win.txt"), original);
		chmodSync(join(root, "win.txt"), 0o754);
		const service = files();
		const view = await service.read("agents", "win.txt");
		expect(view).toMatchObject({ bom: true, eol: "\r\n", text: "a\r\nb\r\nc" });
		const saved = await service.save(
			"agents",
			"win.txt",
			{ text: "a\r\nB\r\nc", baseHash: view.hash },
			OWNER,
		);
		const after = readFileSync(join(root, "win.txt"));
		expect(after).toEqual(
			Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				Buffer.from("a\r\nB\r\nc"),
			]),
		);
		expect(saved.hash).toBe(sha(after));
		expect(statSync(join(root, "win.txt")).mode & 0o777).toBe(0o754);
		expect(readdirSync(root)).toEqual(["win.txt"]);
	});

	test("a changed file is a conflict that names the file as it is now; nothing is written", async () => {
		writeFileSync(join(root, "doc.txt"), "one");
		const service = files();
		const view = await service.read("agents", "doc.txt");
		writeFileSync(join(root, "doc.txt"), "an agent was here");
		const error = await conflict(
			service.save(
				"agents",
				"doc.txt",
				{ text: "mine", baseHash: view.hash },
				OWNER,
			),
		);
		expect(error.conflict).toBe("changed");
		expect(error.current?.hash).toBe(sha("an agent was here"));
		expect(error.current?.size).toBe(17);
		expect(readFileSync(join(root, "doc.txt"), "utf8")).toBe(
			"an agent was here",
		);
		expect(readdirSync(root)).toEqual(["doc.txt"]);
	});

	test("a file changed after the temporary file was written is still a conflict", async () => {
		writeFileSync(join(root, "doc.txt"), "one");
		hooks.beforeReplace = (_tmp, target) => writeFileSync(target, "late agent");
		const error = await conflict(
			files().save(
				"agents",
				"doc.txt",
				{ text: "mine", baseHash: sha("one") },
				OWNER,
			),
		);
		expect(error.conflict).toBe("changed");
		expect(readFileSync(join(root, "doc.txt"), "utf8")).toBe("late agent");
		expect(readdirSync(root)).toEqual(["doc.txt"]);
	});

	test("a deleted file is a conflict of its own and is not recreated", async () => {
		const error = await conflict(
			files().save(
				"agents",
				"gone.txt",
				{ text: "x", baseHash: sha("") },
				OWNER,
			),
		);
		expect(error.conflict).toBe("gone");
		expect(existsSync(join(root, "gone.txt"))).toBe(false);
	});

	test("a failed write removes its temporary file", async () => {
		writeFileSync(join(root, "doc.txt"), "one");
		hooks.beforeReplace = () => {
			throw new Error("disk on fire");
		};
		await expect(
			files().save(
				"agents",
				"doc.txt",
				{ text: "two", baseHash: sha("one") },
				OWNER,
			),
		).rejects.toThrow("disk on fire");
		expect(readdirSync(root)).toEqual(["doc.txt"]);
		expect(readFileSync(join(root, "doc.txt"), "utf8")).toBe("one");
	});

	test("logs who saved what, with short hashes and no content", async () => {
		writeFileSync(join(root, "doc.txt"), "one");
		await files().save(
			"agents",
			"doc.txt",
			{ text: "SECRET-two", baseHash: sha("one") },
			OWNER,
		);
		const line = log.lines.find((entry) => entry.level === "info");
		expect(line?.message).toBe("workspace file saved by an owner");
		expect(line?.fields).toEqual({
			by: OWNER,
			root: "agents",
			path: "doc.txt",
			bytes: 10,
			from: sha("one").slice(0, 12),
			to: sha("SECRET-two").slice(0, 12),
		});
		expect(JSON.stringify(log.lines)).not.toContain("SECRET-two");
	});
});

describe("places that are read-only", () => {
	test(".git is readable and never written, at any depth, or through a link", async () => {
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, ".git", "config"), "[core]");
		mkdirSync(join(root, "repos", "x", ".git"), { recursive: true });
		writeFileSync(join(root, "repos", "x", ".git", "HEAD"), "ref");
		symlinkSync(join(root, ".git"), join(root, "gitlink"));
		const service = files();
		const view = await service.read("agents", ".git/config");
		expect(view).toMatchObject({
			editable: false,
			reason: "git-dir",
			text: "[core]",
		});
		for (const path of [".git/config", "repos/x/.git/HEAD", "gitlink/config"]) {
			const refusal = await refused(
				service.save("agents", path, { text: "x", baseHash: sha("") }, OWNER),
			);
			expect(refusal.status).toBe(403);
			expect(refusal.reason).toBe("git-dir");
		}
		for (const call of [
			() => service.create("agents", ".git/hooks", { kind: "dir" }, OWNER),
			() => service.create("agents", ".git/new", { kind: "file" }, OWNER),
			() => service.rename("agents", ".git/config", "config2", OWNER),
			() => service.rename("agents", "repos", ".git/repos", OWNER),
			() => service.remove("agents", ".git/config", OWNER),
			() => service.remove("agents", ".git", OWNER),
		])
			expect((await refused(call())).reason).toBe("git-dir");
		expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("[core]");
	});

	test("a read-only root can be read and listed, and nothing in it can change", async () => {
		const dir = join(base, "ro");
		mkdirSync(dir);
		writeFileSync(join(dir, "a.txt"), "a");
		const service = files([{ dir, writable: false }]);
		const view = await service.read("extra0", "a.txt");
		expect(view).toMatchObject({ editable: false, reason: "read-only-root" });
		for (const call of [
			() =>
				service.save(
					"extra0",
					"a.txt",
					{ text: "x", baseHash: view.hash },
					OWNER,
				),
			() => service.create("extra0", "b.txt", { kind: "file" }, OWNER),
			() => service.rename("extra0", "a.txt", "b.txt", OWNER),
			() => service.remove("extra0", "a.txt", OWNER),
			() => service.restore("extra0", "abc", OWNER),
		]) {
			const refusal = await refused(call());
			expect(refusal.status).toBe(403);
			expect(refusal.reason).toBe("read-only-root");
		}
		expect(readdirSync(dir)).toEqual(["a.txt"]);
	});
});

describe("raw downloads", () => {
	test("text is plain, an image is inline, anything that could run in a browser is a download", async () => {
		writeFileSync(join(root, "a.txt"), "hello");
		writeFileSync(join(root, "p.html"), "<script>alert(1)</script>");
		writeFileSync(
			join(root, "p.png"),
			Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
		);
		writeFileSync(join(root, "p.bin"), Buffer.from([1, 2, 0, 3]));
		const service = files();
		const text = await service.raw("agents", "a.txt", false);
		expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(text.headers.get("content-disposition")).toStartWith("inline");
		expect(text.headers.get("cache-control")).toBe("no-store");
		expect(text.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await text.text()).toBe("hello");
		for (const name of ["p.html", "p.bin"]) {
			const response = await service.raw("agents", name, false);
			expect(response.headers.get("content-disposition")).toStartWith(
				"attachment",
			);
			expect(response.headers.get("content-type")).not.toContain("html");
			expect(response.headers.get("content-type")).not.toContain("svg");
			await response.arrayBuffer();
		}
		const png = await service.raw("agents", "p.png", false);
		expect(png.headers.get("content-type")).toBe("image/png");
		expect(png.headers.get("content-disposition")).toStartWith("inline");
		await png.arrayBuffer();
		const forced = await service.raw("agents", "a.txt", true);
		expect(forced.headers.get("content-disposition")).toStartWith(
			"attachment; filename*=UTF-8''a.txt",
		);
		await forced.text();
	});

	test("an empty file downloads as an empty body, and the body is never longer than the size read", async () => {
		writeFileSync(join(root, "empty.txt"), "");
		const empty = await files().raw("agents", "empty.txt", true);
		expect(empty.headers.get("content-length")).toBe("0");
		expect(await empty.text()).toBe("");
		writeFileSync(join(root, "grow.txt"), "12345");
		const response = await files().raw("agents", "grow.txt", true);
		// The file grows after the headers were decided.
		writeFileSync(join(root, "grow.txt"), "1234567890");
		expect(response.headers.get("content-length")).toBe("5");
		expect(await response.text()).toBe("12345");
	});

	test("a file over 50 MiB is refused", async () => {
		const path = join(root, "big.bin");
		writeFileSync(path, "");
		Bun.spawnSync(["truncate", "-s", String(50 * 1024 * 1024 + 1), path]);
		const refusal = await refused(files().raw("agents", "big.bin", true));
		expect(refusal.status).toBe(413);
	});
});

describe("new, rename, delete and the trash", () => {
	test("creates a file or a folder, and refuses to replace one that exists", async () => {
		const service = files();
		await service.create(
			"agents",
			"a.txt",
			{ kind: "file", text: "hi" },
			OWNER,
		);
		await service.create("agents", "dir", { kind: "dir" }, OWNER);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hi");
		expect(statSync(join(root, "dir")).isDirectory()).toBe(true);
		for (const [path, kind] of [
			["a.txt", "file"],
			["dir", "dir"],
			["dir", "file"],
		] as const)
			expect(
				(await conflict(service.create("agents", path, { kind }, OWNER)))
					.conflict,
			).toBe("exists");
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hi");
		// The parent must exist: nothing is created on the way.
		expect(
			(
				await refused(
					service.create("agents", "x/y/z.txt", { kind: "file" }, OWNER),
				)
			).status,
		).toBe(404);
		expect(existsSync(join(root, "x"))).toBe(false);
	});

	test("renames a file or a folder inside the root and never over something", async () => {
		writeFileSync(join(root, "a.txt"), "a");
		writeFileSync(join(root, "b.txt"), "b");
		mkdirSync(join(root, "dir"));
		const service = files();
		await service.rename("agents", "a.txt", "dir/c.txt", OWNER);
		expect(readFileSync(join(root, "dir", "c.txt"), "utf8")).toBe("a");
		expect(existsSync(join(root, "a.txt"))).toBe(false);
		expect(
			(await conflict(service.rename("agents", "b.txt", "dir/c.txt", OWNER)))
				.conflict,
		).toBe("exists");
		expect(readFileSync(join(root, "dir", "c.txt"), "utf8")).toBe("a");
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b");
		await service.rename("agents", "dir", "folder", OWNER);
		expect(existsSync(join(root, "folder", "c.txt"))).toBe(true);
		// A folder cannot move into itself, and a missing source is a 404.
		expect(
			(await refused(service.rename("agents", "folder", "folder/in", OWNER)))
				.status,
		).toBe(400);
		expect(
			(await refused(service.rename("agents", "nope", "other", OWNER))).status,
		).toBe(404);
		expect(log.lines.filter((line) => line.level === "info")).toHaveLength(2);
	});

	test("delete moves to the trash inside the root, and restore brings it back", async () => {
		writeFileSync(join(root, "a.txt"), "keep me");
		mkdirSync(join(root, "dir"));
		writeFileSync(join(root, "dir", "inner.txt"), "inner");
		const service = files();
		const first = await service.remove("agents", "a.txt", OWNER);
		const second = await service.remove("agents", "dir", OWNER);
		expect(existsSync(join(root, "a.txt"))).toBe(false);
		expect(existsSync(join(root, "dir"))).toBe(false);
		// The trash is not listed among the files.
		expect(
			(await service.list("agents", "")).entries.map((entry) => entry.name),
		).toEqual([]);
		const trash = await service.trash("agents");
		expect(trash.items.map((item) => item.path).sort()).toEqual([
			"a.txt",
			"dir",
		]);
		expect(trash.items.find((item) => item.id === first.id)).toMatchObject({
			name: "a.txt",
			kind: "file",
			size: 7,
		});
		// A file with the same name now exists: the restore does not overwrite it.
		writeFileSync(join(root, "a.txt"), "new");
		expect(
			(await conflict(service.restore("agents", first.id, OWNER))).conflict,
		).toBe("exists");
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new");
		rmSync(join(root, "a.txt"));
		await service.restore("agents", first.id, OWNER);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("keep me");
		await service.restore("agents", second.id, OWNER);
		expect(readFileSync(join(root, "dir", "inner.txt"), "utf8")).toBe("inner");
		expect((await service.trash("agents")).items).toEqual([]);
	});

	test("purging removes one trashed item for good, and only from the trash", async () => {
		writeFileSync(join(root, "a.txt"), "a");
		writeFileSync(join(root, "keep.txt"), "k");
		const service = files();
		const trashed = await service.remove("agents", "a.txt", OWNER);
		await service.purge("agents", trashed.id, OWNER);
		expect((await service.trash("agents")).items).toEqual([]);
		expect(existsSync(join(root, "keep.txt"))).toBe(true);
		for (const id of ["../keep.txt", "..", "", "a/b", "not-an-id"])
			expect((await refused(service.purge("agents", id, OWNER))).status).toBe(
				400,
			);
		expect(existsSync(join(root, "keep.txt"))).toBe(true);
	});

	test("a trash entry whose recorded path is forged cannot restore outside the root", async () => {
		writeFileSync(join(root, "a.txt"), "a");
		const service = files();
		const trashed = await service.remove("agents", "a.txt", OWNER);
		const meta = join(root, ".rt-trash", trashed.id, "meta.json");
		const recorded = JSON.parse(readFileSync(meta, "utf8"));
		symlinkSync(outside, join(root, "out"));
		for (const path of ["../sibling-copy.txt", "/tmp/evil.txt", "out/x"]) {
			writeFileSync(meta, JSON.stringify({ ...recorded, path }));
			await refused(service.restore("agents", trashed.id, OWNER));
		}
		untouched();
		expect(existsSync(join(base, "sibling-copy.txt"))).toBe(false);
	});

	test("the trash itself cannot be edited, renamed, deleted or read through the file routes", async () => {
		writeFileSync(join(root, "a.txt"), "a");
		const service = files();
		const trashed = await service.remove("agents", "a.txt", OWNER);
		const inside = `.rt-trash/${trashed.id}/item`;
		for (const call of [
			() =>
				service.save(
					"agents",
					inside,
					{ text: "x", baseHash: sha("a") },
					OWNER,
				),
			() => service.remove("agents", ".rt-trash", OWNER),
			() => service.rename("agents", inside, "back.txt", OWNER),
			() => service.create("agents", ".rt-trash/new", { kind: "file" }, OWNER),
		])
			expect((await refused(call())).reason).toBe("trash-dir");
		expect(existsSync(join(root, "back.txt"))).toBe(false);
	});

	test("a link is deleted as a link, not as what it points to", async () => {
		symlinkSync(join(outside, "secret.txt"), join(root, "out-file"));
		const service = files();
		const trashed = await service.remove("agents", "out-file", OWNER);
		expect(trashed.kind).toBe("symlink");
		untouched();
		await service.restore("agents", trashed.id, OWNER);
		expect(lstatSync(join(root, "out-file")).isSymbolicLink()).toBe(true);
		untouched();
	});

	test("the root itself cannot be renamed or deleted", async () => {
		const service = files();
		expect((await refused(service.remove("agents", "", OWNER))).status).toBe(
			400,
		);
		expect(
			(await refused(service.rename("agents", "", "x", OWNER))).status,
		).toBe(400);
		expect(existsSync(root)).toBe(true);
	});
});

describe("what the review found", () => {
	test("a root replaced by a link after the host started is refused, not followed", async () => {
		mkdirSync(join(base, "second"));
		writeFileSync(join(base, "second", "a.txt"), "a");
		const service = files([
			{ id: "second", dir: join(base, "second"), writable: true },
		]);
		expect((await service.read("second", "a.txt")).text).toBe("a");
		rmSync(join(base, "second"), { recursive: true });
		symlinkSync(outside, join(base, "second"));
		for (const call of [
			() => service.read("second", "secret.txt"),
			() => service.list("second", ""),
			() =>
				service.save(
					"second",
					"secret.txt",
					{ text: "pwned", baseHash: sha("TOP SECRET") },
					OWNER,
				),
			() => service.create("second", "new.txt", { kind: "file" }, OWNER),
		])
			expect((await refused(call())).reason).toBe("outside");
		untouched();
	});

	test("a root that did not exist at the start is pinned where it first appears", async () => {
		const service = files([
			{ id: "late", dir: join(base, "late"), writable: true },
		]);
		expect((await service.list("late", "")).entries).toEqual([]);
		mkdirSync(join(base, "late"));
		writeFileSync(join(base, "late", "a.txt"), "a");
		expect((await service.read("late", "a.txt")).text).toBe("a");
		rmSync(join(base, "late"), { recursive: true });
		symlinkSync(outside, join(base, "late"));
		expect((await refused(service.read("late", "secret.txt"))).reason).toBe(
			"outside",
		);
		untouched();
	});

	test("the .git and trash guards ignore case, as a case-insensitive volume does", async () => {
		mkdirSync(join(root, "repo"));
		writeFileSync(join(root, "x.txt"), "x");
		const service = files();
		for (const call of [
			() => service.create("agents", "repo/.GIT", { kind: "dir" }, OWNER),
			() => service.rename("agents", "x.txt", "repo/.GIT", OWNER),
			() => service.remove("agents", "repo/.GIT", OWNER),
			() => service.rename("agents", ".RT-Trash", "gone", OWNER),
			() => service.rename("agents", "x.txt", ".RT-TRASH", OWNER),
		]) {
			const refusal = await refused(call());
			expect(["git-dir", "trash-dir"]).toContain(refusal.reason);
		}
		expect(readdirSync(join(root, "repo"))).toEqual([]);
	});

	test("a trashed item whose folder was replaced by a link is not restored", async () => {
		const service = files();
		writeFileSync(join(root, "a.txt"), "a");
		const trashed = await service.remove("agents", "a.txt", OWNER);
		const itemDir = join(root, ".rt-trash", trashed.id);
		mkdirSync(join(outside, "planted"));
		writeFileSync(join(outside, "planted", "item"), "FROM OUTSIDE");
		writeFileSync(
			join(outside, "planted", "meta.json"),
			JSON.stringify({ v: 1, path: "b.txt" }),
		);
		rmSync(itemDir, { recursive: true });
		symlinkSync(join(outside, "planted"), itemDir);
		await refused(service.restore("agents", trashed.id, OWNER));
		expect(existsSync(join(root, "b.txt"))).toBe(false);
		expect(readFileSync(join(outside, "planted", "item"), "utf8")).toBe(
			"FROM OUTSIDE",
		);
	});

	test("a file that starts with two byte order marks keeps the second as text", async () => {
		writeFileSync(
			join(root, "bom.txt"),
			Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61]),
		);
		const view = await files().read("agents", "bom.txt");
		expect(view.bom).toBe(true);
		expect(view.text).toBe("\uFEFFa");
	});

	test("a refusal is logged with who asked", async () => {
		const service = files();
		await service.speaking(OWNER, async () => {
			await refused(service.read("agents", "../outside/secret.txt"));
		});
		const line = log.lines.find(
			(entry) => entry.message === "workspace path refused",
		);
		expect(line?.fields).toMatchObject({ by: OWNER, root: "agents" });
	});
});

const bytesOf = (...parts: (number[] | string)[]): Buffer =>
	Buffer.concat(
		parts.map((part) =>
			typeof part === "string"
				? Buffer.from(part, "latin1")
				: Buffer.from(part),
		),
	);
const PAD = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** One small file of each kind a preview shows, with the bytes that kind starts with. */
const SAMPLES: Record<string, { bytes: Buffer; type: string; kind: string }> = {
	"a.png": {
		bytes: bytesOf([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], PAD),
		type: "image/png",
		kind: "image",
	},
	"a.jpg": {
		bytes: bytesOf([0xff, 0xd8, 0xff, 0xe0], PAD),
		type: "image/jpeg",
		kind: "image",
	},
	"a.jpeg": {
		bytes: bytesOf([0xff, 0xd8, 0xff, 0xe0], PAD),
		type: "image/jpeg",
		kind: "image",
	},
	"a.gif": { bytes: bytesOf("GIF89a", PAD), type: "image/gif", kind: "image" },
	"a.webp": {
		bytes: bytesOf("RIFF", [1, 0, 0, 0], "WEBPVP8 ", PAD),
		type: "image/webp",
		kind: "image",
	},
	"a.avif": {
		bytes: bytesOf([0, 0, 0, 0x1c], "ftypavif", PAD),
		type: "image/avif",
		kind: "image",
	},
	"a.bmp": { bytes: bytesOf("BM", PAD), type: "image/bmp", kind: "image" },
	"a.ico": {
		bytes: bytesOf([0, 0, 1, 0, 1, 0], PAD),
		type: "image/x-icon",
		kind: "image",
	},
	"a.svg": {
		bytes: bytesOf(
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
		),
		type: "image/svg+xml",
		kind: "image",
	},
	"a.pdf": {
		bytes: bytesOf("%PDF-1.7\n", PAD),
		type: "application/pdf",
		kind: "pdf",
	},
	"a.mp3": {
		bytes: bytesOf("ID3", [3, 0, 0, 0, 0, 0, 0], PAD),
		type: "audio/mpeg",
		kind: "audio",
	},
	"a.m4a": {
		bytes: bytesOf([0, 0, 0, 0x20], "ftypM4A ", PAD),
		type: "audio/mp4",
		kind: "audio",
	},
	"a.aac": {
		bytes: bytesOf([0xff, 0xf1, 0x50, 0x80], PAD),
		type: "audio/aac",
		kind: "audio",
	},
	"a.ogg": { bytes: bytesOf("OggS", PAD), type: "audio/ogg", kind: "audio" },
	"a.opus": { bytes: bytesOf("OggS", PAD), type: "audio/ogg", kind: "audio" },
	"a.wav": {
		bytes: bytesOf("RIFF", [1, 0, 0, 0], "WAVEfmt ", PAD),
		type: "audio/wav",
		kind: "audio",
	},
	"a.flac": { bytes: bytesOf("fLaC", PAD), type: "audio/flac", kind: "audio" },
	"a.weba": {
		bytes: bytesOf([0x1a, 0x45, 0xdf, 0xa3], PAD),
		type: "audio/webm",
		kind: "audio",
	},
	"a.mp4": {
		bytes: bytesOf([0, 0, 0, 0x20], "ftypisom", PAD),
		type: "video/mp4",
		kind: "video",
	},
	"a.m4v": {
		bytes: bytesOf([0, 0, 0, 0x20], "ftypM4V ", PAD),
		type: "video/mp4",
		kind: "video",
	},
	"a.mov": {
		bytes: bytesOf([0, 0, 0, 0x14], "ftypqt  ", PAD),
		type: "video/quicktime",
		kind: "video",
	},
	"a.webm": {
		bytes: bytesOf([0x1a, 0x45, 0xdf, 0xa3], PAD),
		type: "video/webm",
		kind: "video",
	},
};

describe("previews of media", () => {
	test("each kind is served with the type the allowlist gives it, inline, and never as something a browser runs", async () => {
		const service = files();
		for (const [name, sample] of Object.entries(SAMPLES)) {
			writeFileSync(join(root, name), sample.bytes);
			const view = await service.read("agents", name);
			expect([name, view.media]).toEqual([name, sample.kind]);
			const response = await service.raw("agents", name, false);
			expect([name, response.headers.get("content-type")]).toEqual([
				name,
				sample.type,
			]);
			expect(response.headers.get("content-disposition")).toBe("inline");
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(response.headers.get("accept-ranges")).toBe("bytes");
			const policy = response.headers.get("content-security-policy") ?? "";
			expect(policy).toContain("default-src 'none'");
			// A PDF is shown by the browser's own viewer, which a sandboxed response would block.
			if (sample.kind === "pdf") expect(policy).not.toContain("sandbox");
			else expect(policy).toStartWith("sandbox;");
			expect(response.headers.get("etag")).toBeTruthy();
			expect(response.headers.get("last-modified")).toBeTruthy();
			expect(Buffer.from(await response.arrayBuffer()).toString("hex")).toBe(
				sample.bytes.toString("hex"),
			);
		}
	});

	test("a script, a page or a style sheet is a download whatever its bytes say, and an extension is not enough", async () => {
		const service = files();
		for (const name of [
			"p.html",
			"p.htm",
			"p.xhtml",
			"p.xml",
			"p.xsl",
			"p.mht",
			"p.js",
			"p.css",
			"p.mjs",
		]) {
			writeFileSync(join(root, name), "<script>alert(1)</script>");
			const response = await service.raw("agents", name, false);
			const type = response.headers.get("content-type") ?? "";
			expect([name, /html|xml|javascript|css|svg/.test(type)]).toEqual([
				name,
				false,
			]);
			expect(response.headers.get("content-disposition")).toStartWith(
				name.endsWith(".js") || name.endsWith(".css") || name.endsWith(".mjs")
					? "inline"
					: "attachment",
			);
			await response.arrayBuffer();
		}
		// A name that claims a type its bytes are not is no preview: the page text it holds is text.
		writeFileSync(join(root, "lie.png"), "<html><script>alert(1)</script>");
		writeFileSync(join(root, "lie.pdf"), "<html>");
		writeFileSync(join(root, "lie.mp4"), "<html>");
		for (const name of ["lie.png", "lie.pdf", "lie.mp4"]) {
			expect((await service.read("agents", name)).media).toBeUndefined();
			const response = await service.raw("agents", name, false);
			expect(response.headers.get("content-type")).toBe(
				"text/plain; charset=utf-8",
			);
			await response.arrayBuffer();
		}
	});

	test("a svg is a picture for <img>, behind a sandbox, and still text to edit", async () => {
		writeFileSync(join(root, "p.svg"), SAMPLES["a.svg"]?.bytes ?? "");
		const service = files();
		const view = await service.read("agents", "p.svg");
		expect(view).toMatchObject({ media: "image", editable: true });
		expect(view.text).toContain("<svg");
		const response = await service.raw("agents", "p.svg", false);
		expect(response.headers.get("content-security-policy")).toContain(
			"sandbox;",
		);
		await response.arrayBuffer();
		const forced = await service.raw("agents", "p.svg", true);
		expect(forced.headers.get("content-disposition")).toStartWith("attachment");
		await forced.arrayBuffer();
	});

	test("a download is an attachment even for a kind that previews", async () => {
		writeFileSync(join(root, "a.mp3"), SAMPLES["a.mp3"]?.bytes ?? "");
		const response = await files().raw("agents", "a.mp3", true);
		expect(response.headers.get("content-disposition")).toStartWith(
			"attachment; filename*=UTF-8''a.mp3",
		);
		await response.arrayBuffer();
	});

	test("a range is answered with 206 and the bytes asked for, or 416 when it starts past the end", async () => {
		const body = bytesOf("ID3", [3, 0, 0, 0, 0, 0, 0], "0123456789");
		writeFileSync(join(root, "a.mp3"), body);
		const service = files();
		const range = async (header: string | undefined) =>
			service.raw("agents", "a.mp3", false, header ? { range: header } : {});
		const first = await range("bytes=0-3");
		expect(first.status).toBe(206);
		expect(first.headers.get("content-range")).toBe(`bytes 0-3/${body.length}`);
		expect(first.headers.get("content-length")).toBe("4");
		expect(hex(await first.arrayBuffer())).toBe(hex(body.subarray(0, 4)));
		const open = await range("bytes=10-");
		expect(open.status).toBe(206);
		expect(open.headers.get("content-range")).toBe(
			`bytes 10-${body.length - 1}/${body.length}`,
		);
		expect(hex(await open.arrayBuffer())).toBe(hex(body.subarray(10)));
		const tail = await range("bytes=-5");
		expect(tail.status).toBe(206);
		expect(hex(await tail.arrayBuffer())).toBe(hex(body.subarray(-5)));
		const clamped = await range(`bytes=5-${body.length + 100}`);
		expect(clamped.headers.get("content-range")).toBe(
			`bytes 5-${body.length - 1}/${body.length}`,
		);
		await clamped.arrayBuffer();
		const past = await range(`bytes=${body.length}-`);
		expect(past.status).toBe(416);
		expect(past.headers.get("content-range")).toBe(`bytes */${body.length}`);
		await past.arrayBuffer();
		// What is not one plain range is ignored: the whole file, as a server may answer.
		for (const odd of [
			"bytes=0-1,4-5",
			"items=0-1",
			"bytes=5-2",
			"bytes=a-b",
			"bytes=-",
		]) {
			const whole = await range(odd);
			expect([odd, whole.status]).toEqual([odd, 200]);
			expect(hex(await whole.arrayBuffer())).toBe(hex(body));
		}
	});

	test("an unchanged file answers 304 to its ETag, and a range is dropped when If-Range names another version", async () => {
		const body = bytesOf("ID3", [3, 0, 0, 0, 0, 0, 0], "0123456789");
		writeFileSync(join(root, "a.mp3"), body);
		const service = files();
		const first = await service.raw("agents", "a.mp3", false);
		const etag = first.headers.get("etag") ?? "";
		await first.arrayBuffer();
		const same = await service.raw("agents", "a.mp3", false, {
			ifNoneMatch: etag,
		});
		expect(same.status).toBe(304);
		expect(await same.text()).toBe("");
		const star = await service.raw("agents", "a.mp3", false, {
			ifNoneMatch: "*",
		});
		expect(star.status).toBe(304);
		const other = await service.raw("agents", "a.mp3", false, {
			ifNoneMatch: '"nope"',
		});
		expect(other.status).toBe(200);
		await other.arrayBuffer();
		const kept = await service.raw("agents", "a.mp3", false, {
			range: "bytes=0-1",
			ifRange: etag,
		});
		expect(kept.status).toBe(206);
		await kept.arrayBuffer();
		const dropped = await service.raw("agents", "a.mp3", false, {
			range: "bytes=0-1",
			ifRange: '"stale"',
		});
		expect(dropped.status).toBe(200);
		await dropped.arrayBuffer();
	});

	test("If-Range matches a strong ETag only, and the raw headers forbid framing and caching", async () => {
		writeFileSync(
			join(root, "a.mp3"),
			bytesOf("ID3", [3, 0, 0, 0, 0, 0, 0], "0123456789"),
		);
		const service = files();
		const first = await service.raw("agents", "a.mp3", false);
		const etag = first.headers.get("etag") ?? "";
		expect(etag).not.toStartWith("W/");
		expect(first.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'self'",
		);
		expect(first.headers.get("cache-control")).toBe("no-store");
		await first.arrayBuffer();
		const weak = await service.raw("agents", "a.mp3", false, {
			range: "bytes=0-1",
			ifRange: `W/${etag}`,
		});
		expect(weak.status).toBe(200);
		await weak.arrayBuffer();
	});

	test("the guards see ſ as s: .rt-traſh is the trash", async () => {
		writeFileSync(join(root, "a.txt"), "a");
		const service = files();
		await service.remove("agents", "a.txt", OWNER);
		writeFileSync(join(root, "b.txt"), "b");
		expect(
			(await refused(service.rename("agents", "b.txt", ".rt-traſh", OWNER)))
				.reason,
		).toBe("trash-dir");
	});

	test("a root missing at the start that appears as a link to the data directory is refused", async () => {
		const data = join(base, "data");
		mkdirSync(data);
		writeFileSync(join(data, "auth.json"), "SECRET");
		const later = join(base, "later");
		const service = new WorkspaceFiles({
			roots: [{ id: "scratch", label: "S", dir: later, writable: true }],
			logger: log.logger,
			protectedDirs: [data],
		});
		symlinkSync(data, later);
		expect((await refused(service.read("scratch", "auth.json"))).reason).toBe(
			"outside",
		);
		expect(
			(
				await refused(
					service.save(
						"scratch",
						"auth.json",
						{ text: "x", baseHash: sha("SECRET") },
						OWNER,
					),
				)
			).reason,
		).toBe("outside");
		expect(readFileSync(join(data, "auth.json"), "utf8")).toBe("SECRET");
	});

	test("the raw route has the read route's refusals: traversal, a link out of the place, a pipe, a folder", async () => {
		symlinkSync(join(outside, "secret.txt"), join(root, "out.mp3"));
		mkdirSync(join(root, "dir"));
		const service = files();
		for (const path of [
			"../outside/secret.txt",
			"/etc/hosts",
			"a/../../outside/secret.txt",
			"out.mp3",
			"dir",
			"x\0y",
		]) {
			await refused(service.raw("agents", path, false));
			await refused(service.raw("agents", path, false, { range: "bytes=0-3" }));
		}
		untouched();
	});

	test("a file over the download cap is refused for a preview too", async () => {
		const path = join(root, "big.mp4");
		writeFileSync(path, SAMPLES["a.mp4"]?.bytes ?? "");
		Bun.spawnSync(["truncate", "-s", String(50 * 1024 * 1024 + 1), path]);
		expect(
			(await refused(files().raw("agents", "big.mp4", false))).status,
		).toBe(413);
	});
});
