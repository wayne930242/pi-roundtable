import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { testPlugin } from "pi-roundtable/testing";
import { drawing, seededRandom } from "./index.ts";
import { RecordingSurface } from "./testing/fake-surface.ts";
import { writeTestDecks } from "./testing/test-deck.ts";

test("trusted card presentation receives the host turn and changes the attached picture", async () => {
	const deckDir = writeTestDecks();
	const calls: string[] = [];
	const make = (custom: boolean) =>
		testPlugin(
			drawing({
				deckDir,
				random: seededRandom(42),
				...(custom
					? {
							cardPresentation: {
								heading: (draw, turn) => {
									calls.push(
										`${turn.channel}:${draw.deck.id}:${draw.count}:${draw.question}`,
									);
									return {
										title: "Operator caption",
										subtitle: "A local spread",
									};
								},
								reversedSuffix: " - inverted",
							},
						}
					: {}),
			}),
			{ surfaces: [new RecordingSurface()] },
		);
	const normal = await make(false);
	const custom = await make(true);
	try {
		const args = { deck: "test-poker", count: 1, question: "A question" };
		const text = await normal.runTool("draw_cards", args, {
			channel: "test:42",
		});
		expect(
			await custom.runTool("draw_cards", args, { channel: "test:42" }),
		).toBe(text);
		expect(calls).toEqual(["test:42:test-poker:1:A question"]);
		expect(custom.files).toHaveLength(1);
		expect(custom.files[0]?.file.data).not.toEqual(normal.files[0]?.file.data);
	} finally {
		await normal.stop();
		await custom.stop();
		rmSync(deckDir, { recursive: true, force: true });
	}
});

test("a host words the card result and lifts the map text limits", async () => {
	const deckDir = writeTestDecks();
	const harness = await testPlugin(
		drawing({
			deckDir,
			random: seededRandom(7),
			cardPresentation: {
				result: ({ deck, cards, positions }) =>
					`Drew ${cards.length} from ${deck.id}|${positions.map((p) => p.label ?? "-").join(",")}|{file}`,
			},
			mapLimits: { title: 200, text: 120 },
		}),
		{ surfaces: [new RecordingSurface()] },
	);
	try {
		expect(
			await harness.runTool(
				"draw_cards",
				{
					deck: "test-poker",
					count: 1,
					spread: [{ row: 0, col: 0, label: "Past" }],
				},
				{ channel: "test:42" },
			),
		).toBe("Drew 1 from test-poker|Past|cards.png");
		const long = "a".repeat(100);
		const map = await harness.runTool(
			"relationship_map",
			{
				title: "t".repeat(150),
				nodes: [
					{ id: long, type: "pc" },
					{ id: "b", type: "npc" },
				],
				edges: [{ from: long, to: "b", type: "bond", label: long }],
			},
			{ channel: "test:42" },
		);
		expect(map).toContain("relationship map is attached");
	} finally {
		await harness.stop();
		rmSync(deckDir, { recursive: true, force: true });
	}
});

test("a permissive host takes what a looser caller sent, and the default refuses each", async () => {
	const deckDir = writeTestDecks();
	const make = (permissive: boolean) =>
		testPlugin(drawing({ deckDir, random: seededRandom(3), permissive }), {
			surfaces: [new RecordingSurface()],
		});
	const strict = await make(false);
	const lenient = await make(true);
	const draw = {
		deck: "test-poker",
		count: 2,
		exclude: ["not-a-card"],
		spread: [
			{ row: 0, col: 0, label: "A" },
			{ row: 0, col: 0, label: "B" },
		],
	};
	const map = {
		nodes: [
			{ id: "a", type: "pc" },
			{ id: "a", type: "npc" },
			{ id: " ", type: "faction" },
		],
		edges: [{ from: "a", to: "a", type: "bond" }],
	};
	try {
		expect(
			await strict.runTool("draw_cards", draw, { channel: "test:1" }),
		).toContain("Two cards share");
		expect(
			await strict.runTool(
				"draw_cards",
				{ deck: "test-poker", count: 1, exclude: ["not-a-card"] },
				{ channel: "test:1" },
			),
		).toContain("exclude names");
		expect(
			await strict.runTool("relationship_map", map, { channel: "test:1" }),
		).toContain("share the id");
		expect(
			await lenient.runTool("draw_cards", draw, { channel: "test:1" }),
		).toContain("Drew 2");
		expect(
			await lenient.runTool("relationship_map", map, { channel: "test:1" }),
		).toContain("attached");
	} finally {
		await strict.stop();
		await lenient.stop();
		rmSync(deckDir, { recursive: true, force: true });
	}
});

test("map limits that are not whole numbers of at least 1 stop the start", async () => {
	for (const text of [0, 1.5, Number.POSITIVE_INFINITY, Number.NaN])
		await expect(
			testPlugin(drawing({ mapLimits: { text } }), {
				surfaces: [new RecordingSurface()],
			}),
		).rejects.toThrow("mapLimits.text");
});

test("a permissive host also draws an empty node id, a letterless sigil and an unknown color, and the default refuses each", async () => {
	const make = (permissive: boolean) =>
		testPlugin(drawing({ permissive }), { surfaces: [new RecordingSurface()] });
	const strict = await make(false);
	const lenient = await make(true);
	const empty = {
		nodes: [
			{ id: "", type: "pc" },
			{ id: "b", type: "npc" },
		],
		edges: [{ from: "", to: "b", type: "bond" }],
	};
	const turn = { channel: "test:1" } as const;
	try {
		expect(await strict.runTool("relationship_map", empty, turn)).toContain(
			"not valid",
		);
		expect(await lenient.runTool("relationship_map", empty, turn)).toContain(
			"attached",
		);
		for (const method of ["chaos", "rose_cross", "planetary"]) {
			for (const intention of ["2026", "🔥✨", "   "]) {
				const args = { intention, method };
				expect(await strict.runTool("sigil_generate", args, turn)).toMatch(
					/draws from letters|intention is empty/,
				);
				expect(await lenient.runTool("sigil_generate", args, turn)).toContain(
					"attached",
				);
			}
		}
		const colors = { pattern: "flower_of_life", colors: ["notacolor", "gold"] };
		expect(
			await strict.runTool("sacred_geometry_generate", colors, turn),
		).toContain("not a CSS color");
		expect(
			await lenient.runTool("sacred_geometry_generate", colors, turn),
		).toContain("attached");
	} finally {
		await strict.stop();
		await lenient.stop();
	}
});
