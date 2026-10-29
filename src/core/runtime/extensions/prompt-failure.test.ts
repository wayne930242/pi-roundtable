import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Logger, silentLogger } from "../../log.ts";
import { agentPromptExtension } from "./agent-prompt.ts";
import { personaPromptExtension } from "./persona-prompt.ts";

type Handler = (
	event: { systemPromptOptions: { appendSystemPrompt?: string } },
	ctx: { abort(): void },
) => void;

/** Runs the before-agent-start handler an extension registers, as pi does, and tells what happened. */
function run(
	factory: (pi: ExtensionAPI) => void,
	appended: string | undefined,
) {
	let handler: Handler | undefined;
	factory({
		on: (name: string, one: Handler) => {
			if (name === "before_agent_start") handler = one;
		},
	} as unknown as ExtensionAPI);
	const event = {
		systemPromptOptions: {
			...(appended === undefined ? {} : { appendSystemPrompt: appended }),
		},
	};
	let aborted = 0;
	handler?.(event, { abort: () => aborted++ });
	return { appended: event.systemPromptOptions.appendSystemPrompt, aborted };
}

function recording() {
	const errors: { fields: Record<string, unknown>; message: string }[] = [];
	const logger = {
		...silentLogger(),
		error: (fields: Record<string, unknown>, message: string) =>
			errors.push({ fields, message }),
	} as unknown as Logger;
	return { logger, errors };
}

const broken = () => {
	throw new Error('The file version of the prompt document "shared" is gone.');
};

describe("a prompt that cannot be read when a run starts", () => {
	test("a persona that cannot be read is logged as an error and the run is stopped, not run with the old text", () => {
		const { logger, errors } = recording();
		const result = run(
			personaPromptExtension("You are Aria.", broken, logger, "owner"),
			"You are Aria.",
		);
		expect(result.aborted).toBe(1);
		expect(result.appended).toBe("You are Aria.");
		expect(errors).toHaveLength(1);
		const [logged] = errors;
		expect(logged?.message).toContain('persona of the "owner"');
		expect(String(logged?.fields.err)).toContain('prompt document "shared"');
	});

	test("an agent's prompt that cannot be read is logged as an error and the run is stopped, not run without it", () => {
		const { logger, errors } = recording();
		const result = run(
			agentPromptExtension(broken, logger, "infra"),
			undefined,
		);
		expect(result.aborted).toBe(1);
		expect(result.appended).toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain('agent "infra"');
	});

	test("a prompt that reads does not stop the run or log", () => {
		const { logger, errors } = recording();
		const persona = run(
			personaPromptExtension("Old.", () => "New.", logger, "owner"),
			"Old.",
		);
		const agent = run(
			agentPromptExtension(() => "You are Infra.", logger, "infra"),
			undefined,
		);
		expect([persona.appended, persona.aborted]).toEqual(["New.", 0]);
		expect([agent.appended, agent.aborted]).toEqual(["You are Infra.", 0]);
		expect(errors).toEqual([]);
	});
});
