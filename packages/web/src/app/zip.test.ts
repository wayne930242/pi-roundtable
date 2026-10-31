import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipName } from "./routes.ts";
import { uniqueNames, zipStore } from "./zip.ts";

const text = (value: string) => new TextEncoder().encode(value);
/** unzip in a UTF-8 locale, so it prints the names as stored. */
const unzip = (...args: string[]) =>
	Bun.spawnSync(["unzip", ...args], {
		env: { ...process.env, LC_ALL: "C.UTF-8" },
	});

test.skipIf(!Bun.which("unzip"))(
	"a zip lists every file under its UTF-8 name, and unzip reads each back unchanged",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "web-zip-"));
		try {
			const path = join(dir, "out.zip");
			const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
			writeFileSync(
				path,
				zipStore(
					[
						{ name: "notes.md", data: text("# hello\n") },
						{ name: "報告.pdf", data: bytes },
						{ name: "empty.txt", data: new Uint8Array() },
					],
					new Date("2026-10-31T09:30:00Z"),
				),
			);
			const listed = unzip("-Z1", path).stdout.toString();
			expect(listed.trim().split("\n")).toEqual([
				"notes.md",
				"報告.pdf",
				"empty.txt",
			]);
			const tested = unzip("-t", path);
			expect(tested.exitCode).toBe(0);
			expect(unzip("-p", path, "notes.md").stdout.toString()).toBe("# hello\n");
			const read = unzip("-p", path, "報告.pdf").stdout;
			expect(new Uint8Array(read)).toEqual(bytes);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("the central directory names each entry, flagged UTF-8, at its local header", () => {
	const zip = zipStore([
		{ name: "a.txt", data: text("one") },
		{ name: "ü.txt", data: text("two") },
	]);
	const view = new DataView(zip.buffer);
	const end = zip.byteLength - 22;
	expect(view.getUint32(end, true)).toBe(0x06054b50);
	expect(view.getUint16(end + 10, true)).toBe(2);
	let at = view.getUint32(end + 16, true);
	const names: string[] = [];
	for (let i = 0; i < 2; i++) {
		expect(view.getUint32(at, true)).toBe(0x02014b50);
		expect(view.getUint16(at + 8, true) & 0x0800).toBe(0x0800);
		const length = view.getUint16(at + 28, true);
		expect(view.getUint32(view.getUint32(at + 42, true), true)).toBe(
			0x04034b50,
		);
		names.push(
			new TextDecoder().decode(zip.subarray(at + 46, at + 46 + length)),
		);
		at += 46 + length;
	}
	expect(names).toEqual(["a.txt", "ü.txt"]);
});

test("repeated names get -2, -3 before the extension", () => {
	expect(
		uniqueNames(["a.pdf", "a.pdf", "b", "a.pdf", "B", ".env", ".env"]),
	).toEqual(["a.pdf", "a-2.pdf", "b", "a-3.pdf", "B-2", ".env", ".env-2"]);
});

test("a message's zip is named after when it was sent, on the host's clock", () => {
	const at = new Date("2026-10-31T12:28:40Z");
	expect(zipName(at, "Asia/Taipei")).toBe("attachments-20261031-2028.zip");
	expect(zipName(at)).toBe("attachments-20261031-1228.zip");
	expect(zipName(new Date("2026-10-31T16:05:00Z"), "Asia/Taipei")).toBe(
		"attachments-20261101-0005.zip",
	);
	expect(zipName(new Date(Number.NaN))).toBe("attachments.zip");
});
