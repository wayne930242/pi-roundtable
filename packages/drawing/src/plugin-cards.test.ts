import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { definePlugin, REPLY_FILE_LIMITS } from "pi-roundtable";
import { testPlugin } from "pi-roundtable/testing";
import { seededRandom } from "./random.ts";
import { pngSize, RecordingSurface } from "./testing/fake-surface.ts";
import { filesOf, open } from "./testing/plugin-fixture.ts";
import { writeTestDecks } from "./testing/test-deck.ts";
import { imageTool, strictObject } from "./tools/image-tool.ts";

let deckDir = "";

beforeAll(() => {
	deckDir = writeTestDecks();
});

afterAll(() => rmSync(deckDir, { recursive: true, force: true }));

describe("reply file limits", () => {
	test("a picture over the file limit is refused with advice, not attached", async () => {
		const surface = new RecordingSurface();
		const harness = await testPlugin(
			definePlugin({
				name: "oversize",
				setup: () => ({
					tools: [
						imageTool(
							{
								name: "oversize_picture",
								description: "Draws a picture that is too large.",
								parameters: strictObject({}),
								draw: () => ({
									stem: "big",
									image: new Uint8Array(REPLY_FILE_LIMITS.maxFileBytes + 1),
									text: "never read",
								}),
							},
							{ minTier: "member" },
						),
					],
				}),
			}),
			{ surfaces: [surface] },
		);
		const text = await harness.runTool("oversize_picture", {});
		expect(text).toMatch(
			/The picture is 10\.0 MiB, over the 10 MiB a reply may carry/,
		);
		expect(text).toMatch(/fewer cards or a smaller size/);
		expect(harness.files).toHaveLength(0);
		expect(surface.replies).toHaveLength(0);
		await harness.stop();
	});

	test("a picture exactly at the file limit is attached", async () => {
		const surface = new RecordingSurface();
		const harness = await testPlugin(
			definePlugin({
				name: "exact",
				setup: () => ({
					tools: [
						imageTool(
							{
								name: "exact_picture",
								description: "Draws a picture at the limit.",
								parameters: strictObject({}),
								draw: () => ({
									stem: "exact",
									image: new Uint8Array(REPLY_FILE_LIMITS.maxFileBytes).fill(1),
									text: "Attached {file}.",
								}),
							},
							{ minTier: "member" },
						),
					],
				}),
			}),
			{ surfaces: [surface] },
		);
		expect(await harness.runTool("exact_picture", {})).toBe(
			"Attached exact.png.",
		);
		expect(harness.files[0]?.file.data.byteLength).toBe(
			REPLY_FILE_LIMITS.maxFileBytes,
		);
		await harness.stop();
	});

	test("the turn's file count limit fails the call with the host's message and attaches nothing", async () => {
		const surface = new RecordingSurface();
		const harness = await testPlugin(
			definePlugin({
				name: "crowded",
				setup: () => ({
					tools: [
						imageTool(
							{
								name: "crowded_picture",
								description:
									"Draws after the turn already holds the most files.",
								parameters: strictObject({}),
								draw: (_args, turn) => {
									for (let i = 0; i < REPLY_FILE_LIMITS.maxFiles; i++)
										turn.attachFile({
											name: `earlier-${i}.png`,
											data: new Uint8Array([1]),
										});
									return {
										stem: "one-too-many",
										image: new Uint8Array([1]),
										text: "never read",
									};
								},
							},
							{ minTier: "member" },
						),
					],
				}),
			}),
			{ surfaces: [surface] },
		);
		await expect(harness.runTool("crowded_picture", {})).rejects.toThrow(
			/at most 10 reply files/,
		);
		expect(harness.files).toHaveLength(0);
		expect(surface.replies).toHaveLength(0);
		await harness.stop();
	});
});

describe("draw_cards", () => {
	test("draws against a generated deck and attaches the spread", async () => {
		const { harness } = await open({
			deckDir,
			random: seededRandom(11),
		});
		const text = await harness.runTool("draw_cards", {
			deck: "test-tarot",
			count: 3,
			question: "What now?",
		});
		expect(text).toStartWith(
			"Drew 3 from test-tarot; the spread picture is attached to your reply as cards.png.\n",
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
		expect(pngSize(filesOf(harness)[0]?.data ?? new Uint8Array())).toEqual({
			width: 32 * 2 + 3 * 220 - 20,
			height: 32 * 2 + 64 + Math.round(200 * (240 / 140)) + 30,
		});
		await harness.stop();
	});

	test("the same seed draws the same cards", async () => {
		const draw = async () => {
			const { harness } = await open({
				deckDir,
				random: seededRandom(3),
			});
			const text = await harness.runTool("draw_cards", {
				deck: "test-tarot",
				count: 5,
			});
			await harness.stop();
			return { text, image: Buffer.from(filesOf(harness)[0]?.data ?? []) };
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
		const { harness } = await open({ deckDir });
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
		const size = pngSize(filesOf(harness)[0]?.data ?? new Uint8Array());
		expect(size?.width).toBe(520);
		// Two rows of 26 + 300 + 30 + 20 px cells, less the last gap.
		expect(size?.height).toBe(32 * 2 + 64 + 2 * (26 + 300 + 30 + 20) - 20);
		await harness.stop();
	});

	test("a draw of 20 cards uses narrower cards in rows of seven", async () => {
		const { harness } = await open({ deckDir });
		await harness.runTool("draw_cards", { deck: "test-poker", count: 20 });
		const size = pngSize(filesOf(harness)[0]?.data ?? new Uint8Array());
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
		expect(harness.files).toHaveLength(0);
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
