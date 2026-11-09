import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { drawing } from "./plugin.ts";
import { seededRandom } from "./random.ts";
import { pngSize } from "./testing/fake-surface.ts";
import { borderInk, countInk, inkOf } from "./testing/ink.ts";
import { filesOf, open } from "./testing/plugin-fixture.ts";
import { writeTestDecks } from "./testing/test-deck.ts";

let deckDir = "";

beforeAll(() => {
	deckDir = writeTestDecks();
});

afterAll(() => rmSync(deckDir, { recursive: true, force: true }));

describe("what the review found", () => {
	const png = async (
		tool: string,
		args: Record<string, unknown>,
		options: Parameters<typeof drawing>[0] = {},
	) => {
		const { harness } = await open(options);
		await harness.runTool(tool, args);
		await harness.stop();
		const data = filesOf(harness)[0]?.data;
		if (!data) throw new Error(`${tool} attached nothing`);
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
			const { harness } = await open({ deckDir });
			const text = await harness.runTool("draw_cards", {
				deck: "test-large",
				count,
			});
			expect(text).toStartWith(`Drew ${count} from test-large`);
			const size = pngSize(filesOf(harness)[0]?.data ?? new Uint8Array());
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
