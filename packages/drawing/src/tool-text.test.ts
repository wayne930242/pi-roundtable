import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { testPlugin } from "pi-roundtable/testing";
import { drawing } from "./plugin.ts";
import { RecordingSurface } from "./testing/fake-surface.ts";
import { writeTestDecks } from "./testing/test-deck.ts";
import { DEFAULT_DRAWING_TOOL_TEXT } from "./tool-text.ts";

let deckDir = "";
beforeAll(() => {
	deckDir = writeTestDecks();
});
afterAll(() => rmSync(deckDir, { recursive: true, force: true }));

interface Schema {
	description?: string;
	properties?: Record<string, Schema>;
	items?: Schema;
	anyOf?: unknown[];
}
interface Registered {
	description: string;
	parameters: Schema;
}
async function open(options: Parameters<typeof drawing>[0] = {}) {
	const harness = await testPlugin(drawing({ deckDir, ...options }), {
		surfaces: [new RecordingSurface()],
	});
	const found: Record<string, Registered> = {};
	for (const tool of harness.contribution.tools ?? []) {
		const factory = tool.session.snapshot().factory({
			kind: "agent",
			homeChannel: "test:1",
			turnChannel: "test:1",
			compaction: { wrap: (item: unknown) => item },
			speaker: () => undefined,
			runTask: async () => "",
		} as never);
		factory?.({
			registerTool: (definition: Registered & { name: string }) => {
				found[definition.name] = definition;
			},
		} as never);
	}
	return { harness, tools: found };
}
/** The schema at an argument path; arrays are transparent, as in the text keys. */
function at(root: Schema, path: string): Schema | undefined {
	let node: Schema | undefined = root;
	for (const name of path.split(".")) {
		node = node?.items ?? node;
		node = node?.properties?.[name];
	}
	return node;
}

describe("drawing tool text", () => {
	test("the defaults are what every tool shows without an override", async () => {
		const { harness, tools } = await open();
		for (const [name, text] of Object.entries(DEFAULT_DRAWING_TOOL_TEXT)) {
			expect(tools[name]?.description).toStartWith(text.description);
			for (const [path, description] of Object.entries(text.parameters))
				expect(at(tools[name]?.parameters ?? {}, path)?.description).toBe(
					description,
				);
		}
		expect(tools.draw_cards?.description).toContain("test-poker");
		await harness.stop();
	});

	test("an override replaces the description and the named arguments, and keeps each schema", async () => {
		const plain = await open();
		const { harness, tools } = await open({
			toolText: {
				relationship_map: {
					description: "A map.",
					parameters: { "nodes.id": "A name.", title: "The heading." },
				},
				draw_cards: { description: "Draw." },
			},
		});
		const map = tools.relationship_map;
		expect(map?.description).toBe("A map.");
		expect(at(map?.parameters ?? {}, "nodes.id")?.description).toBe("A name.");
		expect(at(map?.parameters ?? {}, "title")?.description).toBe(
			"The heading.",
		);
		// Unset arguments keep the package text.
		expect(at(map?.parameters ?? {}, "nodes.label")?.description).toBe(
			DEFAULT_DRAWING_TOOL_TEXT.relationship_map.parameters["nodes.label"],
		);
		// The description is the host's whole text: no deck list is appended to it.
		expect(tools.draw_cards?.description).toBe("Draw.");
		// Only text changed.
		const strip = (schema: Schema | undefined): unknown =>
			JSON.parse(JSON.stringify(schema), (key, value) =>
				key === "description" ? undefined : value,
			);
		expect(strip(map?.parameters)).toEqual(
			strip(plain.tools.relationship_map?.parameters),
		);
		expect(tools.sigil_generate?.description).toBe(
			plain.tools.sigil_generate?.description,
		);
		await harness.stop();
		await plain.harness.stop();
	});

	test("a host composes on the defaults to add to them", async () => {
		const { harness, tools } = await open({
			toolText: {
				sigil_generate: {
					description: `${DEFAULT_DRAWING_TOOL_TEXT.sigil_generate.description} In the owner's tongue.`,
				},
			},
		});
		expect(tools.sigil_generate?.description).toBe(
			`${DEFAULT_DRAWING_TOOL_TEXT.sigil_generate.description} In the owner's tongue.`,
		);
		await harness.stop();
	});

	test("a tool or argument the package does not have stops the start", async () => {
		await expect(
			open({ toolText: { sigil: { description: "x" } } as never }),
		).rejects.toThrow('toolText has no tool "sigil"');
		await expect(
			open({
				toolText: { relationship_map: { parameters: { nodez: "x" } } },
			}),
		).rejects.toThrow('toolText.relationship_map has no argument "nodez"');
	});
});
