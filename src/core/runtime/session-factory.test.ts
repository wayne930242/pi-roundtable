import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureScratchDir } from "../builtin/agent-server.ts";
import { ConfigError } from "../domain/errors.ts";
import type { LinkedSessions } from "../plugin.ts";
import type { PiAgentRuntimeOptions } from "./runtime-types.ts";
import { SessionFactory, scratchBash } from "./session-factory.ts";

/** A factory over the part `personaOf` reads: the plugins' personas. */
function factory(personas: Record<string, string>): SessionFactory {
	// SAFETY: personaOf reads only the linked `persona` lookup.
	const options = {
		sessions: () =>
			({
				piPackages: [],
				persona: (kind: string) => personas[kind],
			}) as unknown as LinkedSessions,
	} as unknown as PiAgentRuntimeOptions;
	return new SessionFactory(options, {
		speaker: () => undefined,
		runTask: async () => "",
	});
}

describe("the persona of a conversation kind", () => {
	test("a plugin's persona is the prompt of its kind", () => {
		const sessions = factory({ study: "You are a tutor." });
		expect(sessions.personaOf("study")).toBe("You are a tutor.");
	});

	test("the owner's conversations use the persona a plugin contributes for the owner kind", () => {
		expect(factory({ owner: "Be kind." }).personaOf("owner")).toBe("Be kind.");
	});

	test("the owner's conversations start with an empty prompt when no plugin contributes one", () => {
		expect(factory({ study: "You are a tutor." }).personaOf("owner")).toBe("");
	});

	test("a kind nobody wrote a persona for is refused, never given the owner's", () => {
		const sessions = factory({ study: "You are a tutor." });
		const error = (() => {
			try {
				return sessions.personaOf("quiz");
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as Error).message).toContain(
			'no persona is registered for the conversation kind "quiz"',
		);
		expect((error as Error).message).toContain("personas");
	});
});

describe("the tools of a selection", () => {
	test("a tool's name before 0.9, such as notify_owner, selects the tool by its new name", () => {
		// SAFETY: toolsFor reads only the linked plan.
		const options = {
			sessions: () =>
				({
					piPackages: [],
					plan: { tools: [], mcp: [] },
				}) as unknown as LinkedSessions,
		} as unknown as PiAgentRuntimeOptions;
		const tools = new SessionFactory(options, {
			speaker: () => undefined,
			runTask: async () => "",
		}).toolsFor({
			tools: ["memory_add", "notify_owner", "notify"],
			groups: [],
		});
		expect(tools.filter((tool) => tool.startsWith("notify"))).toEqual([
			"notify",
		]);
		expect(tools).toContain("memory_add");
	});
});

describe("the agents' scratch dir", () => {
	test("the agents' bash runs with TMPDIR at the scratch dir", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scratch-bash-")));
		try {
			const scratch = ensureScratchDir(join(root, "roundtable-scratch"));
			expect(statSync(scratch).mode & 0o777).toBe(0o700);
			const bash = scratchBash(root, scratch);
			expect(bash.name).toBe("bash");
			// SAFETY: the bash tool reads no context.
			const result = await bash.execute(
				"call",
				{ command: "echo $TMPDIR; mktemp" },
				undefined,
				undefined,
				undefined as never,
			);
			const text = result.content
				.map((part) => ("text" in part ? part.text : ""))
				.join("");
			expect(text.split("\n")[0]).toBe(scratch);
			expect(text.split("\n")[1]).toStartWith(`${scratch}/`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a symlink in the scratch dir's place is refused", () => {
		const root = mkdtempSync(join(tmpdir(), "scratch-link-"));
		try {
			symlinkSync(root, join(root, "link"));
			expect(() => ensureScratchDir(join(root, "link"))).toThrow(ConfigError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
