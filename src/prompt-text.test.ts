import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeDb } from "./core/testing/database.ts";
import { capturePrompts } from "./core/testing/prompt-capture.ts";
import { hasWebAccess } from "./core/testing/test-host.ts";

// The system prompt and every tool's name, description, and parameters that the model receives,
// for each kind of session a single-owner host runs, recorded on 0.8.0. The principal work of
// 0.9 must keep these texts, so a change here is a change in what the assistant is told: review
// it, and regenerate on purpose with UPDATE_PROMPT_TEXT=1. One change is intended: (e), a turn
// run without a speaker, which 0.8 ran as the owner's, is refused in 0.9 before the model is
// asked, so its entry records the refusal instead of a prompt.
const SNAPSHOT = join(import.meta.dir, "prompt-text.snapshot.json");

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set and the delegation worker can load.
(hasWebAccess() ? describeDb : describeDb.skip)(
	"the prompt text of a single-owner host",
	() => {
		test("every session kind sends the model the recorded prompt and tool definitions", async () => {
			const actual = await capturePrompts();
			if (process.env.UPDATE_PROMPT_TEXT === "1")
				writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, "\t")}\n`);
			if (!existsSync(SNAPSHOT))
				throw new Error(
					"prompt-text.snapshot.json is missing; regenerate it with UPDATE_PROMPT_TEXT=1",
				);
			expect(actual).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
		}, 60_000);

		test("the same owner written in access sends the model the same text", async () => {
			expect(await capturePrompts("access")).toEqual(
				JSON.parse(readFileSync(SNAPSHOT, "utf8")),
			);
		}, 60_000);
	},
);
