import { beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	base,
	files,
	hooks,
	log,
	OWNER,
	outside,
	refused,
	root,
	sandboxPerTest,
	sha,
	untouched,
} from "../testing/workspace-sandbox.ts";
import { checkRoots, type WorkspaceRoot } from "./workspace-files.ts";

sandboxPerTest();

describe("the roots", () => {
	test("are listed by id, label and whether they can be written, never by path", () => {
		const view = files([{ writable: false }]).roots();
		expect(view).toEqual([
			{ id: "agents", label: "Knights", writable: true },
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
