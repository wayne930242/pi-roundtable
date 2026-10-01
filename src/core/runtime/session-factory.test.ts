import { describe, expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import type { LinkedSessions } from "../plugin.ts";
import type { PiAgentRuntimeOptions } from "./runtime-types.ts";
import { SessionFactory } from "./session-factory.ts";

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
