import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ownerMemoryExtension } from "../../modules/memory/owner-memory.ts";
import type { MemoryStore, SpeakerMemory } from "../../services.ts";
import type { Speaker } from "../../speakers.ts";
import { TEST_OWNER as OWNER, OWNER_SPEAKER } from "../../testing/owner.ts";
import { agentPromptExtension } from "./agent-prompt.ts";
import { personaPromptExtension } from "./persona-prompt.ts";
import { surfaceFormattingExtension } from "./surface-formatting.ts";

const dir = mkdtempSync(join(tmpdir(), "session-prompt-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One speaker's memory with a single core fact; the prompt hook reads only `forPrompt`. */
function remembering(fact: string): SpeakerMemory {
	const unused = async (): Promise<never> => {
		throw new Error("the prompt hook reads only forPrompt");
	};
	return {
		forPrompt: async () => ({
			core: [{ id: 1, kind: "core", fact, eventDate: null }],
			events: [],
		}),
		list: unused,
		add: unused,
		search: unused,
		update: unused,
		removeById: unused,
		remove: unused,
	};
}

// The store of a host with one speaker: everyone reads the same memory.
const memory: MemoryStore = {
	forSpeaker: () => remembering("Drinks oolong tea"),
};

/** What a session appends to its system prompt for its next run, through the real Pi SDK. */
async function appendedPrompt(
	factories: { name: string; factory: ExtensionFactory }[],
	appendSystemPrompt: string[],
): Promise<string> {
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: factories,
		appendSystemPrompt,
	});
	await loader.reload();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
	});
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir),
	});
	// The SDK runs these handlers inside prompt(); calling them directly needs no model.
	// pi 1.2 takes (trigger, options) where earlier releases took (prompt, images, options).
	type Emitted = Promise<{
		systemPromptOptions: { appendSystemPrompt: string };
	}>;
	const internals = session as unknown as {
		_extensionRunner: {
			emitBeforeAgentStart: ((...args: unknown[]) => Emitted) & {
				length: number;
			};
		};
		_baseSystemPromptOptions: unknown;
	};
	try {
		const runner = internals._extensionRunner;
		const options = internals._baseSystemPromptOptions;
		const result =
			runner.emitBeforeAgentStart.length >= 3
				? await runner.emitBeforeAgentStart("hello", [], options)
				: await runner.emitBeforeAgentStart(
						{ messageType: "user", prompt: "hello", images: [] },
						options,
					);
		return result.systemPromptOptions.appendSystemPrompt;
	} finally {
		session.dispose();
	}
}

// A store with one memory per speaker: the owner's and one other's, told apart by their one fact.
function storeOf(facts: Record<string, string>): MemoryStore {
	return {
		forSpeaker: (id) => remembering(facts[id] ?? "nothing"),
	};
}

/** The memory extension of a session whose turns read `speaker`'s memory, the owner's principal "1". */
function memoryOf(store: MemoryStore, speaker: Speaker) {
	return ownerMemoryExtension(store, {
		ownerId: "1",
		addressee: OWNER,
		describesSpeakers: false,
		whose: () => ({ principalId: speaker.principalId, name: speaker.name }),
	});
}

describe("appended system prompt", () => {
	test("a speaker other than the owner gets their own memory, not the owner's", async () => {
		const owner = storeOf({ "1": "Drinks oolong tea", "2": "Prefers coffee" });
		const speaker = () => ({
			id: "2",
			name: "Ada",
			tier: "admin" as const,
			principalId: "2",
		});
		const prompt = await appendedPrompt(
			[
				{
					name: "owner-memory",
					factory: memoryOf(owner, speaker()),
				},
			],
			[],
		);
		expect(prompt).toContain("## Memory of Ada");
		expect(prompt).toContain("Prefers coffee");
		expect(prompt).not.toContain("oolong");
		expect(prompt).not.toContain("## Owner memory");
	});

	test("the owner speaking in a session of several speakers reads the owner memory", async () => {
		const owner = storeOf({ "1": "Drinks oolong tea" });
		const speaker = () => ({
			id: "1",
			name: "Riley",
			tier: "owner" as const,
			principalId: "1",
		});
		const prompt = await appendedPrompt(
			[
				{
					name: "owner-memory",
					factory: memoryOf(owner, speaker()),
				},
			],
			[],
		);
		expect(prompt).toContain("## Owner memory");
		expect(prompt).toContain("Drinks oolong tea");
	});

	test("an owner session carries the persona, then the owner memory", async () => {
		const prompt = await appendedPrompt(
			[
				{
					name: "owner-memory",
					factory: memoryOf(memory, OWNER_SPEAKER),
				},
			],
			["You are the assistant."],
		);
		expect(prompt.startsWith("You are the assistant.")).toBe(true);
		expect(prompt).toContain("## Owner memory");
		expect(prompt).toContain("Drinks oolong tea");
	});

	test("an agent session carries its own prompt first, then the owner memory", async () => {
		// The runtime's order: owner-memory registers before agent-prompt.
		const prompt = await appendedPrompt(
			[
				{
					name: "owner-memory",
					factory: memoryOf(memory, OWNER_SPEAKER),
				},
				{
					name: "agent-prompt",
					factory: agentPromptExtension(() => "You are Infra."),
				},
			],
			[],
		);
		expect(prompt.startsWith("You are Infra.\n\n## Owner memory")).toBe(true);
		expect(prompt).toContain("Drinks oolong tea");
	});

	test("an agent prompt stands alone when nothing was appended before it", async () => {
		const prompt = await appendedPrompt(
			[
				{
					name: "agent-prompt",
					factory: agentPromptExtension(() => "You are Infra."),
				},
			],
			[],
		);
		expect(prompt).toBe("You are Infra.");
	});

	test("a surface's guidance follows the persona and the owner memory", async () => {
		const prompt = await appendedPrompt(
			[
				{ name: "owner-memory", factory: memoryOf(memory, OWNER_SPEAKER) },
				{
					name: "surface-formatting",
					factory: surfaceFormattingExtension(() => "No tables here."),
				},
			],
			["You are the assistant."],
		);
		expect(prompt.startsWith("You are the assistant.\n\n## Owner memory")).toBe(
			true,
		);
		expect(prompt.endsWith("\n\nNo tables here.")).toBe(true);
	});

	test("an agent's guidance comes after its own prompt, wherever the extension loads", async () => {
		const prompt = await appendedPrompt(
			[
				{
					name: "agent-prompt",
					factory: agentPromptExtension(() => "You are Infra."),
				},
				{
					name: "surface-formatting",
					factory: surfaceFormattingExtension(() => "No tables here."),
				},
			],
			[],
		);
		expect(prompt).toBe("You are Infra.\n\nNo tables here.");
	});

	test("guidance stands alone when nothing was appended before it", async () => {
		const prompt = await appendedPrompt(
			[
				{
					name: "surface-formatting",
					factory: surfaceFormattingExtension(() => "No tables here."),
				},
			],
			[],
		);
		expect(prompt).toBe("No tables here.");
	});

	test("no guidance leaves the appended prompt as it was, and is asked again at each run", async () => {
		let guidance: string | undefined;
		const factories = [
			{
				name: "surface-formatting",
				factory: surfaceFormattingExtension(() => guidance),
			},
		];
		expect(await appendedPrompt(factories, ["You are the assistant."])).toBe(
			"You are the assistant.",
		);
		guidance = "Plain text.";
		expect(await appendedPrompt(factories, ["You are the assistant."])).toBe(
			"You are the assistant.\n\nPlain text.",
		);
	});

	test("blank guidance adds nothing, not a trailing blank paragraph", async () => {
		for (const blank of ["", "  \n"]) {
			const prompt = await appendedPrompt(
				[
					{
						name: "surface-formatting",
						factory: surfaceFormattingExtension(() => blank),
					},
				],
				["You are the assistant."],
			);
			expect(prompt).toBe("You are the assistant.");
		}
	});

	describe("a persona the owner edits", () => {
		test("a text that has not changed leaves the prompt as built", async () => {
			const prompt = await appendedPrompt(
				[
					{
						name: "persona-prompt",
						factory: personaPromptExtension(
							"You are the assistant.",
							() => "You are the assistant.",
						),
					},
					{
						name: "owner-memory",
						factory: memoryOf(memory, OWNER_SPEAKER),
					},
				],
				["You are the assistant."],
			);
			expect(
				prompt.startsWith("You are the assistant.\n\n## Owner memory"),
			).toBe(true);
		});

		test("the current text takes the place of the one the session was built with, before the memory", async () => {
			const prompt = await appendedPrompt(
				[
					{
						name: "persona-prompt",
						factory: personaPromptExtension(
							"You are the assistant.",
							() => "You are Merlin, edited.",
						),
					},
					{
						name: "owner-memory",
						factory: memoryOf(memory, OWNER_SPEAKER),
					},
				],
				["You are the assistant."],
			);
			expect(
				prompt.startsWith("You are Merlin, edited.\n\n## Owner memory"),
			).toBe(true);
			expect(prompt).not.toContain("You are the assistant.");
		});

		test("a replacement text with dollar signs is written as it is", async () => {
			const prompt = await appendedPrompt(
				[
					{
						name: "persona-prompt",
						factory: personaPromptExtension("Old.", () => "Costs $& and $1."),
					},
				],
				["Old."],
			);
			expect(prompt).toBe("Costs $& and $1.");
		});

		test("a persona that was empty when the session was built is added", async () => {
			const prompt = await appendedPrompt(
				[
					{
						name: "persona-prompt",
						factory: personaPromptExtension("", () => "Now there is one."),
					},
					{
						name: "owner-memory",
						factory: memoryOf(memory, OWNER_SPEAKER),
					},
				],
				[],
			);
			expect(prompt.startsWith("Now there is one.\n\n## Owner memory")).toBe(
				true,
			);
		});
	});
});
