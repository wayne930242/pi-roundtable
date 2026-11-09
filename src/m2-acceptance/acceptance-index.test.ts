import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ITEMS_1 } from "./acceptance-items-1.ts";
import { ITEMS_2 } from "./acceptance-items-2.ts";
import type { Item, Listed } from "./acceptance-types.ts";

// The M2 acceptance index (T2.16): each item of the plan's test strategy (§6, principals and
// identity), with the tests that check it. A test is named as `bun test` prints it, its describe
// blocks and its name joined by " > "; `source` gives the text the file writes instead, for a
// name built from a template. The test below reads every listed file and fails when a listed name
// is no longer in it, so the index cannot point at a test that was renamed or removed. The tests
// this directory adds for items no other test covered are migration.test.ts (§6.1),
// isolation.test.ts (§6.2), and compatibility.test.ts (§6.4).

const ROOT = resolve(import.meta.dir, "../..");

const ACCEPTANCE: readonly Item[] = [...ITEMS_1, ...ITEMS_2];

/** A listed test's describe blocks and name, as the file writes them. */
const partsOf = (listed: Listed): readonly string[] =>
	listed.source ?? listed.test.split(" > ");

describe("the M2 acceptance index", () => {
	test("lists every section of §6, each item with its tests or a note saying where it is checked", () => {
		expect(new Set(ACCEPTANCE.map((item) => item.section))).toEqual(
			new Set(["6.1", "6.2", "6.3", "6.4", "6.5"]),
		);
		for (const item of ACCEPTANCE)
			expect({
				item: item.item,
				checked: item.tests.length > 0 || !!item.note,
			}).toEqual({ item: item.item, checked: true });
	});

	test("names only tests that are in their files", () => {
		const missing: string[] = [];
		for (const item of ACCEPTANCE)
			for (const listed of item.tests) {
				const path = join(ROOT, listed.file);
				if (!existsSync(path)) {
					missing.push(`${listed.file}: no such file`);
					continue;
				}
				const text = readFileSync(path, "utf8");
				for (const part of partsOf(listed))
					if (!text.includes(part))
						missing.push(`${listed.file}: ${JSON.stringify(part)}`);
			}
		expect(missing).toEqual([]);
	});
});
