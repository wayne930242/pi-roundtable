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
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { agentPromptExtension } from "./agent-prompt.ts";

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
	const internals = session as unknown as {
		_extensionRunner: {
			emitBeforeAgentStart(
				prompt: string,
				images: unknown[],
				options: unknown,
			): Promise<{ systemPromptOptions: { appendSystemPrompt: string } }>;
		};
		_baseSystemPromptOptions: unknown;
	};
	try {
		const result = await internals._extensionRunner.emitBeforeAgentStart(
			"hello",
			[],
			internals._baseSystemPromptOptions,
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

describe("appended system prompt", () => {
	test("a speaker other than the owner gets their own memory, not the owner's", async () => {
		const owner = storeOf({ "1": "Drinks oolong tea", "2": "Prefers coffee" });
		const speaker = () => ({ id: "2", name: "Ada", tier: "admin" as const });
		const prompt = await appendedPrompt(
			[
				{
					name: "owner-memory",
					factory: ownerMemoryExtension(owner, "1", OWNER, speaker),
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
		});
		const prompt = await appendedPrompt(
			[
				{
					name: "owner-memory",
					factory: ownerMemoryExtension(owner, "1", OWNER, speaker),
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
					factory: ownerMemoryExtension(memory, "1", OWNER),
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
					factory: ownerMemoryExtension(memory, "1", OWNER),
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
});
