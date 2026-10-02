import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { PluginError } from "pi-roundtable";
import { testPlugin } from "pi-roundtable/testing";
import { drawing } from "./plugin.ts";
import { seededRandom } from "./random.ts";
import { pngSize, RecordingSurface } from "./testing/fake-surface.ts";
import { borderInk, countInk, inkOf } from "./testing/ink.ts";
import { writeTestDecks } from "./testing/test-deck.ts";

let deckDir = "";
beforeAll(() => {
	deckDir = writeTestDecks();
});
afterAll(() => rmSync(deckDir, { recursive: true, force: true }));

/** The plugin under test with a recording surface, which keeps what the tools post. */
async function open(options: Parameters<typeof drawing>[0] = {}) {
	const surface = new RecordingSurface();
	const harness = await testPlugin(drawing(options), { surfaces: [surface] });
	return { harness, surface };
}

const MAP = {
	title: "The Harbour",
	nodes: [
		{ id: "Ada", type: "pc", label: "captain" },
		{ id: "Bram", type: "npc" },
		{ id: "Guild", type: "faction" },
	],
	edges: [
		{ from: "Ada", to: "Bram", type: "romantic", label: "loves" },
		{ from: "Bram", to: "Guild", type: "faction" },
		{ from: "Ada", to: "Guild", type: "hostile" },
	],
};

describe("tools", () => {
	test("without a deck directory the plugin offers the four drawing tools", async () => {
		const { harness } = await open();
		expect(harness.tools).toEqual([
			"relationship_map",
			"magic_circle_generate",
			"sigil_generate",
			"sacred_geometry_generate",
		]);
		for (const name of harness.tools)
			expect(harness.tiers.minTier(name)).toBe("member");
		await harness.stop();
	});

	test("a deck directory adds draw_cards, and minTier sets every tool's tier", async () => {
		const { harness } = await open({ deckDir, minTier: "admin" });
		expect(harness.tools).toContain("draw_cards");
		for (const name of harness.tools)
			expect(harness.tiers.minTier(name)).toBe("admin");
		await harness.stop();
	});
});

describe("images", () => {
	test("relationship_map posts a PNG to the channel of the turn", async () => {
		const { harness, surface } = await open({ random: seededRandom(1) });
		const text = await harness.runTool("relationship_map", MAP, {
			channel: "test:42",
		});
		expect(text).toBe(
			"The relationship map is posted to the channel as relationship-map.png.",
		);
		expect(surface.replies).toHaveLength(1);
		expect(surface.replies[0]?.channel).toBe("test:42");
		const [file] = surface.files;
		expect(file?.name).toBe("relationship-map.png");
		const size = pngSize(file?.data ?? new Uint8Array());
		expect(size).toBeDefined();
		// The picture is as big as its content, with a floor of 400 by 300.
		expect(size?.width).toBeGreaterThanOrEqual(400);
		expect(size?.height).toBeGreaterThanOrEqual(300);
		await harness.stop();
	});

	test("the same seed draws the same map and another seed draws another", async () => {
		const draw = async (seed: number) => {
			const { harness, surface } = await open({ random: seededRandom(seed) });
			await harness.runTool("relationship_map", MAP);
			await harness.stop();
			return Buffer.from(surface.files[0]?.data ?? []);
		};
		const [a, b, c] = [await draw(5), await draw(5), await draw(6)];
		expect(a.length).toBeGreaterThan(1000);
		expect(a.equals(b)).toBe(true);
		expect(a.equals(c)).toBe(false);
	});

	test("a map takes names in any script", async () => {
		const { harness, surface } = await open({ random: seededRandom(2) });
		await harness.runTool("relationship_map", {
			nodes: [
				{ id: "\u963f\u8c6a", type: "pc" },
				{ id: "\u5c0f\u7f8e", type: "npc" },
			],
			edges: [{ from: "\u963f\u8c6a", to: "\u5c0f\u7f8e", type: "bond" }],
		});
		expect(pngSize(surface.files[0]?.data ?? new Uint8Array())).toBeDefined();
		await harness.stop();
	});

	test.each([
		["small", 512],
		["medium", 1024],
		["large", 2048],
	])("magic_circle_generate draws a %s circle of %d px", async (size, px) => {
		const { harness, surface } = await open();
		const text = await harness.runTool("magic_circle_generate", {
			type: "pentagram",
			size,
			elements: ["fire", "air", "water", "earth"],
			text: "Ad astra",
		});
		expect(text).toBe(
			"The magic circle is posted to the channel as magic-circle.png.",
		);
		expect(pngSize(surface.files[0]?.data ?? new Uint8Array())).toEqual({
			width: px,
			height: px,
		});
		await harness.stop();
	});

	test("every circle type, background, and style draws, and drawing is deterministic", async () => {
		const { harness, surface } = await open();
		for (const type of ["pentagram", "hexagram", "tree_of_life", "custom"])
			for (const background of ["dark", "white", "transparent"])
				await harness.runTool("magic_circle_generate", {
					type,
					background,
					style: "modern",
					size: "small",
				});
		expect(surface.files).toHaveLength(12);
		for (const file of surface.files)
			expect(pngSize(file.data)).toEqual({ width: 512, height: 512 });
		await harness.runTool("magic_circle_generate", { type: "hexagram" });
		await harness.runTool("magic_circle_generate", { type: "hexagram" });
		const [a, b] = surface.files.slice(-2);
		expect(Buffer.from(a?.data ?? []).equals(Buffer.from(b?.data ?? []))).toBe(
			true,
		);
		await harness.stop();
	});

	test.each(["chaos", "rose_cross", "planetary", "geometric"])(
		"sigil_generate draws by the %s method",
		async (method) => {
			const { harness, surface } = await open();
			const text = await harness.runTool("sigil_generate", {
				intention: "find the way home",
				method,
			});
			expect(text).toBe("The sigil is posted to the channel as sigil.png.");
			expect(pngSize(surface.files[0]?.data ?? new Uint8Array())).toEqual({
				width: 512,
				height: 512,
			});
			await harness.stop();
		},
	);

	test.each(["flower_of_life", "metatron", "sri_yantra", "vesica_pisces"])(
		"sacred_geometry_generate draws the %s pattern",
		async (pattern) => {
			const { harness, surface } = await open();
			const text = await harness.runTool("sacred_geometry_generate", {
				pattern,
				layers: 4,
				rotation: 15,
				colors: ["gold", "#5fc4b8"],
			});
			expect(text).toBe(
				"The sacred geometry is posted to the channel as sacred-geometry.png.",
			);
			expect(pngSize(surface.files[0]?.data ?? new Uint8Array())).toEqual({
				width: 1024,
				height: 1024,
			});
			await harness.stop();
		},
	);
});

describe("refusals", () => {
	const refused = async (
		tool: string,
		args: Record<string, unknown>,
		expected: string | RegExp,
	) => {
		const { harness, surface } = await open();
		const text = await harness.runTool(tool, args);
		expect(text).toMatch(expected);
		// A refused call posts nothing.
		expect(surface.replies).toHaveLength(0);
		await harness.stop();
	};

	test("a map with no nodes", () =>
		refused("relationship_map", { nodes: [], edges: [] }, /nodes/));

	test("an edge to a node that is not there", () =>
		refused(
			"relationship_map",
			{
				nodes: [{ id: "Ada", type: "pc" }],
				edges: [{ from: "Ada", to: "Ghost", type: "bond" }],
			},
			'An edge references the unknown node "Ghost". Add it to nodes or fix the edge.',
		));

	test("two nodes with one id", () =>
		refused(
			"relationship_map",
			{
				nodes: [
					{ id: "Ada", type: "pc" },
					{ id: "Ada", type: "npc" },
				],
				edges: [],
			},
			'Two nodes share the id "Ada". Node ids must be unique.',
		));

	test("an edge from a node to itself", () =>
		refused(
			"relationship_map",
			{
				nodes: [{ id: "Ada", type: "pc" }],
				edges: [{ from: "Ada", to: "Ada", type: "bond" }],
			},
			/to itself/,
		));

	test("a node type that does not exist is caught by the schema", () =>
		refused(
			"relationship_map",
			{ nodes: [{ id: "Ada", type: "dragon" }], edges: [] },
			/The arguments are not valid/,
		));

	test("more nodes than the limit", () =>
		refused(
			"relationship_map",
			{
				nodes: Array.from({ length: 41 }, (_, i) => ({
					id: `n${i}`,
					type: "npc",
				})),
				edges: [],
			},
			/The arguments are not valid/,
		));

	test("rim text over the limit", () =>
		refused(
			"magic_circle_generate",
			{ type: "pentagram", text: "x".repeat(61) },
			/The arguments are not valid/,
		));

	test("an unknown element", () =>
		refused(
			"magic_circle_generate",
			{ type: "pentagram", elements: ["aether"] },
			/The arguments are not valid/,
		));

	test("a sigil of an intention with no letters", () =>
		refused(
			"sigil_generate",
			{ intention: "1234 !!", method: "chaos" },
			"The chaos method draws from letters, and the intention has none. Write it in words, or use the geometric method.",
		));

	test("an empty sigil intention", () =>
		refused(
			"sigil_generate",
			{ intention: "", method: "geometric" },
			/The arguments are not valid/,
		));

	test("a color canvas cannot read", () =>
		refused(
			"sacred_geometry_generate",
			{ pattern: "flower_of_life", colors: ["not-a-color"] },
			'"not-a-color" is not a CSS color. Use a name such as gold or a code such as #c0a060.',
		));

	test("layers out of range", () =>
		refused(
			"sacred_geometry_generate",
			{ pattern: "metatron", layers: 12 },
			/The arguments are not valid/,
		));

	test("a channel no surface serves fails the call", async () => {
		const { harness } = await open();
		await expect(
			harness.runTool(
				"sigil_generate",
				{ intention: "home", method: "chaos" },
				{
					channel: "nowhere:1",
				},
			),
		).rejects.toBeInstanceOf(PluginError);
		await harness.stop();
	});
});

describe("draw_cards", () => {
	test("draws against a generated deck and posts the spread", async () => {
		const { harness, surface } = await open({
			deckDir,
			random: seededRandom(11),
		});
		const text = await harness.runTool("draw_cards", {
			deck: "test-tarot",
			count: 3,
			question: "What now?",
		});
		expect(text).toStartWith(
			"Drew 3 from test-tarot; the spread picture is posted to the channel as cards.png.\n",
		);
		const lines = text.split("\n").slice(1);
		expect(lines).toHaveLength(3);
		for (const [i, line] of lines.entries())
			expect(line).toMatch(
				new RegExp(
					`^${i + 1}\\. (Major|Minor) Card \\d( \\(reversed\\))? \\[id: (major|minor)-\\d\\]$`,
				),
			);
		// Three cards of 200 px with 20 px gaps, between 32 px margins.
		expect(pngSize(surface.files[0]?.data ?? new Uint8Array())).toEqual({
			width: 32 * 2 + 3 * 220 - 20,
			height: 32 * 2 + 64 + Math.round(200 * (240 / 140)) + 30,
		});
		await harness.stop();
	});

	test("the same seed draws the same cards", async () => {
		const draw = async () => {
			const { harness, surface } = await open({
				deckDir,
				random: seededRandom(3),
			});
			const text = await harness.runTool("draw_cards", {
				deck: "test-tarot",
				count: 5,
			});
			await harness.stop();
			return { text, image: Buffer.from(surface.files[0]?.data ?? []) };
		};
		const [a, b] = [await draw(), await draw()];
		expect(a.text).toBe(b.text);
		expect(a.image.equals(b.image)).toBe(true);
	});

	test("a group, an exclusion, and upright cards", async () => {
		const { harness } = await open({ deckDir, random: seededRandom(4) });
		const text = await harness.runTool("draw_cards", {
			deck: "test-tarot",
			count: 5,
			group: "major",
			exclude: ["major-0"],
			allow_reversed: false,
		});
		const ids = [...text.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]);
		expect(ids.sort()).toEqual([
			"major-1",
			"major-2",
			"major-3",
			"major-4",
			"major-5",
		]);
		expect(text).not.toContain("(reversed)");
		await harness.stop();
	});

	test("a deck that names no reversals draws upright unless asked", async () => {
		const { harness } = await open({ deckDir, random: () => 0.1 });
		expect(
			await harness.runTool("draw_cards", { deck: "test-poker", count: 4 }),
		).not.toContain("(reversed)");
		expect(
			await harness.runTool("draw_cards", {
				deck: "test-poker",
				count: 4,
				allow_reversed: true,
			}),
		).toContain("(reversed)");
		await harness.stop();
	});

	test("a named spread labels its positions", async () => {
		const { harness, surface } = await open({ deckDir });
		const text = await harness.runTool("draw_cards", {
			deck: "test-poker",
			count: 3,
			spread: [
				{ row: 0, col: 0, label: "Past" },
				{ row: 0, col: 1, label: "Present" },
				{ row: 1, col: 0, label: "Future" },
			],
		});
		expect(text).toMatch(/1\. Past: .*\n2\. Present: .*\n3\. Future: /);
		const size = pngSize(surface.files[0]?.data ?? new Uint8Array());
		expect(size?.width).toBe(520);
		// Two rows of 26 + 300 + 30 + 20 px cells, less the last gap.
		expect(size?.height).toBe(32 * 2 + 64 + 2 * (26 + 300 + 30 + 20) - 20);
		await harness.stop();
	});

	test("a draw of 20 cards uses narrower cards in rows of seven", async () => {
		const { harness, surface } = await open({ deckDir });
		await harness.runTool("draw_cards", { deck: "test-poker", count: 20 });
		const size = pngSize(surface.files[0]?.data ?? new Uint8Array());
		// Twenty cards in rows of seven, 150 px wide with 20 px gaps.
		expect(size?.width).toBe(32 * 2 + 7 * 170 - 20);
		await harness.stop();
	});

	test("the description lists the decks the manifests name", async () => {
		const { harness } = await open({ deckDir });
		const tool = harness.contribution.tools?.find(
			(t) => t.name === "draw_cards",
		);
		expect(tool).toBeDefined();
		const registered: { description: string }[] = [];
		tool?.session.snapshot().factory?.({} as never)?.({
			registerTool: (definition: { description: string }) =>
				registered.push(definition),
		} as never);
		expect(registered[0]?.description).toContain(
			"test-tarot: Test Tarot, 10 cards (groups: major, minor)",
		);
		expect(registered[0]?.description).toContain(
			"test-poker: Test Playing Cards, 20 cards, upright by default",
		);
		await harness.stop();
	});

	const refused = async (
		args: Record<string, unknown>,
		expected: string | RegExp,
	) => {
		const { harness, surface } = await open({ deckDir });
		expect(await harness.runTool("draw_cards", args)).toMatch(expected);
		expect(surface.replies).toHaveLength(0);
		await harness.stop();
	};

	test("an unknown deck", () =>
		refused({ deck: "thoth", count: 1 }, /The arguments are not valid/));

	test("more cards than the deck has", () =>
		refused(
			{ deck: "test-tarot", count: 11 },
			"Cannot draw 11 cards: only 10 are available in deck test-tarot with 0 excluded.",
		));

	test("more cards than the group has", () =>
		refused(
			{ deck: "test-tarot", count: 5, group: "minor" },
			"Cannot draw 5 cards: only 4 are available in deck test-tarot group minor with 0 excluded.",
		));

	test("a group the deck does not have", () =>
		refused(
			{ deck: "test-tarot", count: 1, group: "wild" },
			'Deck test-tarot has no group "wild". Its groups are major, minor.',
		));

	test("a card id the deck does not list", () =>
		refused(
			{ deck: "test-tarot", count: 1, exclude: ["The Fool"] },
			'exclude names "The Fool", which is not a card of deck test-tarot. Use the card ids the deck lists.',
		));

	test("a spread with the wrong number of positions", () =>
		refused(
			{
				deck: "test-tarot",
				count: 2,
				spread: [{ row: 0, col: 0, label: "Only" }],
			},
			"The spread has 1 positions for 2 cards. Give one position for each card.",
		));

	test("two cards in one place", () =>
		refused(
			{
				deck: "test-tarot",
				count: 2,
				spread: [
					{ row: 0, col: 0, label: "A" },
					{ row: 0, col: 0, label: "B" },
				],
			},
			"Two cards share row 0, column 0. Give each card its own position.",
		));

	test("a count of zero", () =>
		refused({ deck: "test-tarot", count: 0 }, /The arguments are not valid/));
});

describe("what the review found", () => {
	const png = async (
		tool: string,
		args: Record<string, unknown>,
		options: Parameters<typeof drawing>[0] = {},
	) => {
		const { harness, surface } = await open(options);
		await harness.runTool(tool, args);
		await harness.stop();
		const data = surface.files[0]?.data;
		if (!data) throw new Error(`${tool} posted nothing`);
		return data;
	};

	test.each([
		["chaos", "simple"],
		["rose_cross", "simple"],
		["planetary", "simple"],
		["chaos", "elaborate"],
	])(
		"a one-letter %s sigil (%s) has something drawn",
		async (method, complexity) => {
			const ink = await inkOf(
				await png("sigil_generate", { intention: "a", method, complexity }),
			);
			expect(countInk(ink)).toBeGreaterThan(20);
			// The same letter written three times is one point too.
			const repeated = await inkOf(
				await png("sigil_generate", {
					intention: "AAA",
					method: "chaos",
					complexity,
				}),
			);
			expect(countInk(repeated)).toBeGreaterThan(20);
		},
	);

	test("a long intention keeps every sigil inside the frame", async () => {
		for (const method of ["chaos", "rose_cross", "planetary"]) {
			const ink = await inkOf(
				await png("sigil_generate", {
					intention: "the quick brown fox jumps over the lazy dog",
					method,
					style: "traditional",
				}),
			);
			expect(borderInk(ink, 10)).toBe(0);
		}
	});

	test.each(["flower_of_life", "metatron", "sri_yantra", "vesica_pisces"])(
		"every layer count of %s stays inside the frame",
		async (pattern) => {
			for (const layers of [1, 2, 3, 5, 9]) {
				const ink = await inkOf(
					await png("sacred_geometry_generate", {
						pattern,
						layers,
						rotation: 17,
					}),
				);
				expect(borderInk(ink, 10)).toBe(0);
				expect(countInk(ink)).toBeGreaterThan(100);
			}
		},
	);

	test.each([
		["flower_of_life", 3, 9],
		["vesica_pisces", 3, 9],
		["sri_yantra", 3, 9],
		["metatron", 1, 2],
	])("more layers change a %s: %d against %d", async (pattern, fewer, more) => {
		const a = await png("sacred_geometry_generate", { pattern, layers: fewer });
		const b = await png("sacred_geometry_generate", { pattern, layers: more });
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
	});

	test("a map whose names are far wider than a node is drawn whole", async () => {
		const long = "W".repeat(60);
		const ink = await inkOf(
			await png(
				"relationship_map",
				{
					title: "T".repeat(80),
					nodes: [
						{ id: long, type: "pc", label: "L".repeat(60) },
						{ id: "Bram", type: "npc" },
						{ id: `${long.slice(1)}X`, type: "faction" },
					],
					edges: [
						{ from: long, to: "Bram", type: "bond", label: "E".repeat(60) },
					],
				},
				{ random: seededRandom(9) },
			),
		);
		// Sixty wide letters need over a thousand pixels, which the old fixed size cut off.
		expect(ink.width).toBeGreaterThan(1000);
		expect(borderInk(ink, 20)).toBe(0);
	});

	test.each([
		["rotaton", 45],
		["colour", "red"],
	])(
		"an argument that does not exist (%s) is refused, not defaulted",
		async (name, value) => {
			const { harness, surface } = await open();
			expect(
				await harness.runTool("sacred_geometry_generate", {
					pattern: "metatron",
					[name]: value,
				}),
			).toMatch(/The arguments are not valid/);
			expect(surface.replies).toHaveLength(0);
			await harness.stop();
		},
	);

	test("a spread that is refused leaves the random source where it was", async () => {
		const draw = { deck: "test-tarot", count: 3 };
		const refused = await open({ deckDir, random: seededRandom(21) });
		expect(
			await refused.harness.runTool("draw_cards", {
				...draw,
				spread: [
					{ row: 0, col: 0, label: "A" },
					{ row: 0, col: 1, label: "B" },
					{ row: 0, col: 1, label: "C" },
				],
			}),
		).toMatch(/share row 0, column 1/);
		const after = await refused.harness.runTool("draw_cards", draw);
		const fresh = await open({ deckDir, random: seededRandom(21) });
		expect(await fresh.harness.runTool("draw_cards", draw)).toBe(after);
		await refused.harness.stop();
		await fresh.harness.stop();
	});

	test.each([77, 78, 100])(
		"a draw of %d cards lays out its own rows",
		async (count) => {
			const { harness, surface } = await open({ deckDir });
			const text = await harness.runTool("draw_cards", {
				deck: "test-large",
				count,
			});
			expect(text).toStartWith(`Drew ${count} from test-large`);
			const size = pngSize(surface.files[0]?.data ?? new Uint8Array());
			// Cards of 110 px in rows of seven.
			expect(size?.width).toBe(32 * 2 + 7 * 130 - 20);
			const rows = Math.ceil(count / 7);
			expect(size?.height).toBe(
				32 * 2 + 64 + rows * (Math.round(110 * 1.5) + 30 + 20) - 20,
			);
			await harness.stop();
		},
	);

	test("a spread of your own is held to the grid by the schema", async () => {
		const { harness } = await open({ deckDir });
		expect(
			await harness.runTool("draw_cards", {
				deck: "test-tarot",
				count: 1,
				spread: [{ row: 11, col: 0, label: "Far" }],
			}),
		).toMatch(/The arguments are not valid/);
		await harness.stop();
	});
});
