import { expect, test } from "bun:test";
import type { InterimPosts } from "../domain/interim.ts";
import type { Logger } from "../log.ts";
import {
	InterimPoster,
	isPrimaryText,
	PRIMARY_CHARS,
	progressText,
} from "./interim-text.ts";

const quiet = { warn: () => undefined } as unknown as Logger;

/** Posts that record every message and each edit, in order. */
function recording(fail = false) {
	const log: string[] = [];
	const shown: string[] = [];
	const posts: InterimPosts = {
		post: async (text) => {
			if (fail) throw new Error("Discord is down");
			const index = shown.push(text) - 1;
			log.push(`post ${index}`);
			return {
				edit: async (change) => {
					shown[index] = change;
					log.push(`edit ${index}`);
				},
			};
		},
	};
	return { log, shown, posts };
}

const toolUse = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "toolUse",
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("a long or structured text is primary; a short line is not", () => {
	expect(isPrimaryText("checking the logs…")).toBe(false);
	expect(isPrimaryText("x".repeat(PRIMARY_CHARS))).toBe(true);
	expect(isPrimaryText("Plan:\n- one\n- two")).toBe(true);
	expect(isPrimaryText("## Proposal\nshort")).toBe(true);
	expect(isPrimaryText("```ts\nx\n```")).toBe(true);
	expect(isPrimaryText("| a | b |\n| - | - |")).toBe(true);
	expect(isPrimaryText("a bit longer", 5)).toBe(true);
});

test("consecutive short texts share one progress message with a merged tool line", async () => {
	const { log, shown, posts } = recording();
	const poster = new InterimPoster(posts, {
		logger: quiet,
		channel: "fake:room",
		editMs: 0,
	});
	poster.messageEnd(toolUse("checking the logs"));
	poster.toolStart("bash");
	poster.messageEnd(toolUse("reading the config"));
	poster.toolStart("read");
	poster.messageEnd(toolUse("one more look"));
	poster.toolStart("bash");
	await poster.flush();
	expect(shown).toEqual([
		"-# checking the logs\n-# reading the config\n-# one more look\n-# bash ×2 · read",
	]);
	expect(log[0]).toBe("post 0");
	expect(log.slice(1).every((entry) => entry === "edit 0")).toBe(true);
	expect(log.length).toBeGreaterThan(1);

	// A primary post starts a new progress message.
	poster.messageEnd(toolUse(`## Proposal\n${"a".repeat(500)}`));
	poster.toolStart("ask_user");
	poster.messageEnd(toolUse("waiting"));
	await poster.flush();
	expect(shown.slice(1)).toEqual([
		`## Proposal\n${"a".repeat(500)}`,
		"-# waiting\n-# ask_user",
	]);
});

test("only tool-calling assistant messages are posted", async () => {
	const { shown, posts } = recording();
	const poster = new InterimPoster(posts, { logger: quiet, channel: "c" });
	poster.messageEnd({
		role: "assistant",
		content: "final",
		stopReason: "stop",
	});
	poster.messageEnd({ role: "user", content: "hi" });
	poster.messageEnd(toolUse("   "));
	await poster.flush();
	expect(shown).toEqual([]);
});

test("edits are throttled and the last state lands", async () => {
	const { log, shown, posts } = recording();
	const poster = new InterimPoster(posts, {
		logger: quiet,
		channel: "c",
		editMs: 40,
	});
	for (let i = 0; i < 5; i++) poster.toolStart("bash");
	await sleep(5);
	expect(log).toEqual(["post 0"]);
	expect(shown).toEqual(["-# bash"]);
	await sleep(60);
	expect(log).toEqual(["post 0", "edit 0"]);
	expect(shown).toEqual(["-# bash ×5"]);
	poster.toolStart("read");
	await poster.flush();
	expect(shown).toEqual(["-# bash ×5 · read"]);
});

test("the progress message stays within 2000 characters, dropping the oldest lines", () => {
	const lines = Array.from(
		{ length: 40 },
		(_, i) => `step ${i} ${"x".repeat(80)}`,
	);
	const text = progressText(lines, new Map([["bash", 40]]));
	expect(text.length).toBeLessThanOrEqual(2000);
	expect(text.startsWith("-# …\n")).toBe(true);
	expect(text).toContain("step 39");
	expect(text).not.toContain("step 0 ");
	expect(text.endsWith("-# bash ×40")).toBe(true);
	const one = progressText(["y".repeat(3000)], new Map());
	expect(one.length).toBeLessThanOrEqual(2000);
});

test("a failing post is logged and never thrown", async () => {
	const warnings: string[] = [];
	const logger = {
		warn: (_: unknown, message: string) => void warnings.push(message),
	} as unknown as Logger;
	const { posts } = recording(true);
	const poster = new InterimPoster(posts, { logger, channel: "c" });
	poster.messageEnd(toolUse("x".repeat(500)));
	poster.toolStart("bash");
	await poster.flush();
	expect([...new Set(warnings)]).toEqual([
		"interim text not posted",
		"progress message not posted",
	]);
});
