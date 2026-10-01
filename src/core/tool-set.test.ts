import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeDb } from "./testing/database.ts";
import { hasWebAccess, type TestHost, testHost } from "./testing/test-host.ts";
import { captureToolSet } from "./testing/tool-set.ts";

// The tools each kind of session offers, and the tier each needs, under the default
// configuration. It records the behaviour the addons must keep while their tools move between
// plugins, so it names tools and tiers and not the extensions or plugins that supply them.
// Regenerate on purpose with UPDATE_TOOL_SET=1.
const SNAPSHOT = join(import.meta.dir, "tool-set.snapshot.json");

let host: TestHost | undefined;
afterEach(async () => {
	await host?.stop();
	host = undefined;
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set and the delegation worker can load.
(hasWebAccess() ? describeDb : describe.skip)(
	"the tool set under the default configuration",
	() => {
		test("the owner's session, an agent's session, and a group seat offer the recorded tools at the recorded tiers", async () => {
			host = await testHost();
			const actual = await captureToolSet(host);
			if (process.env.UPDATE_TOOL_SET === "1")
				writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, "\t")}\n`);
			if (!existsSync(SNAPSHOT))
				throw new Error(
					"tool-set.snapshot.json is missing; regenerate it with UPDATE_TOOL_SET=1",
				);
			expect(actual).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
		});
	},
);
