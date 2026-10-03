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
