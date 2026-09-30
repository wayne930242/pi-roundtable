import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSessions } from "./session-archive.ts";

describe("archiveSessions", () => {
	test("moves the conversations out of the top level, keeping them", () => {
		const dir = mkdtempSync(join(tmpdir(), "roundtable-archive-"));
		writeFileSync(join(dir, "a.jsonl"), "{}\n");
		writeFileSync(join(dir, "notes.txt"), "stay");
		expect(archiveSessions(dir, new Date("2026-09-27T01:02:03Z"))).toBe(1);
		expect(readdirSync(dir).sort()).toEqual(["archive", "notes.txt"]);
		expect(
			readdirSync(join(dir, "archive", "2026-09-27T01-02-03.000Z")),
		).toEqual(["a.jsonl"]);
		expect(archiveSessions(dir)).toBe(0);
		expect(archiveSessions(join(dir, "missing"))).toBe(0);
	});
});
