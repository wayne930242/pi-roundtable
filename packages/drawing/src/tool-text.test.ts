import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { testPlugin } from "pi-roundtable/testing";
import { drawing } from "./plugin.ts";
import { RecordingSurface } from "./testing/fake-surface.ts";
import { writeTestDecks } from "./testing/test-deck.ts";
import {
	DEFAULT_DRAWING_TOOL_TEXT,
	DRAW_CARDS_ARGUMENTS,
} from "./tool-text.ts";

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

	test("a name Object.prototype has is no tool", async () => {
		for (const name of ["toString", "constructor", "hasOwnProperty"])
			await expect(
				open({ toolText: { [name]: { description: "x" } } as never }),
			).rejects.toThrow(`toolText has no tool "${name}"`);
	});

	test("an argument typo of draw_cards stops the start when the host has no decks too", async () => {
		await expect(
			open({
				deckDir: undefined,
				toolText: { draw_cards: { parameters: { decck: "x" } } },
			}),
		).rejects.toThrow('toolText.draw_cards has no argument "decck"');
		// A real argument is fine without decks, and the check is the same one the built tool makes.
		const { harness, tools } = await open({
			deckDir: undefined,
			toolText: { draw_cards: { parameters: { "spread.label": "x" } } },
		});
		expect(tools.draw_cards).toBeUndefined();
		await harness.stop();
	});

	test("the static list of draw_cards arguments is the one the built tool asks for", async () => {
		const { harness, tools } = await open();
		const asked = new Set(DRAW_CARDS_ARGUMENTS);
		const properties = Object.keys(
			tools.draw_cards?.parameters.properties ?? {},
		);
		for (const name of properties) expect(asked.has(name)).toBe(true);
		const all = Object.fromEntries(DRAW_CARDS_ARGUMENTS.map((p) => [p, "x"]));
		const full = await open({ toolText: { draw_cards: { parameters: all } } });
		for (const path of DRAW_CARDS_ARGUMENTS)
			expect(
				at(full.tools.draw_cards?.parameters ?? {}, path)?.description,
			).toBe("x");
		await full.harness.stop();
		await harness.stop();
	});

	test("the defaults cannot be written into, at any depth", () => {
		expect(Object.isFrozen(DEFAULT_DRAWING_TOOL_TEXT)).toBe(true);
		for (const text of Object.values(DEFAULT_DRAWING_TOOL_TEXT)) {
			expect(Object.isFrozen(text)).toBe(true);
			expect(Object.isFrozen(text.parameters)).toBe(true);
		}
		expect(() => {
			(
				DEFAULT_DRAWING_TOOL_TEXT.sigil_generate.parameters as Record<
					string,
					string
				>
			).background = "x";
		}).toThrow();
		// A host's spread of one tool's text still composes.
		const own = {
			...DEFAULT_DRAWING_TOOL_TEXT.sigil_generate,
			parameters: { ...DEFAULT_DRAWING_TOOL_TEXT.sigil_generate.parameters },
		};
		own.parameters.background = "Light.";
		expect(own.parameters.background).toBe("Light.");
	});
});
