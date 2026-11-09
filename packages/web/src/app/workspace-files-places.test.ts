import { describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	base,
	conflict,
	files,
	log,
	OWNER,
	outside,
	refused,
	root,
	sandboxPerTest,
	sha,
	untouched,
} from "../testing/workspace-sandbox.ts";

sandboxPerTest();

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
