import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	conflict,
	files,
	hooks,
	log,
	OWNER,
	refused,
	root,
	sandboxPerTest,
	sha,
} from "../testing/workspace-sandbox.ts";

sandboxPerTest();

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
