import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginError } from "pi-roundtable";
import { testPlugin } from "pi-roundtable/testing";
import { drawing } from "../plugin.ts";
import { facePng, writeTestDecks } from "../testing/test-deck.ts";
import { loadDecks } from "./deck.ts";

let root = "";
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "drawing-manifests-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A deck directory with the given manifest text and files, in its own deckDir. */
function deckDirWith(
	id: string,
	manifest: unknown,
	files: Record<string, string | Buffer> = {},
): string {
	const dir = mkdtempSync(join(root, "deckdir-"));
	const deck = join(dir, id);
	mkdirSync(deck);
	writeFileSync(
		join(deck, "deck.json"),
		typeof manifest === "string" ? manifest : JSON.stringify(manifest),
	);
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(deck, name, ".."), { recursive: true });
		writeFileSync(join(deck, name), content);
	}
	return dir;
}

const card = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: id,
	...extra,
});

describe("loadDecks", () => {
	test("reads every deck under the directory, sorted by id", () => {
		const decks = loadDecks(writeTestDecks());
		expect(decks.map((deck) => deck.id)).toEqual([
			"test-large",
			"test-poker",
			"test-tarot",
		]);
		const tarot = decks[2];
		expect(tarot?.name).toBe("Test Tarot");
		expect(tarot?.reversals).toBe(true);
		expect(tarot?.cards).toHaveLength(10);
		expect(tarot?.cards[0]?.face).toEndWith("/test-tarot/faces/major-0.png");
		expect(decks[1]?.reversals).toBe(false);
		expect(decks[1]?.cards[0]?.face).toBeUndefined();
	});

	test("skips a subdirectory with no deck.json", () => {
		const dir = deckDirWith("a-deck", { name: "A", cards: [card("x")] });
		mkdirSync(join(dir, "notes"));
		expect(loadDecks(dir).map((deck) => deck.id)).toEqual(["a-deck"]);
	});

	const refuses = (dir: string, expected: string | RegExp) =>
		expect(() => loadDecks(dir)).toThrow(expected);

	test("a deckDir that is not a directory", () =>
		refuses(
			join(root, "missing"),
			/deckDir .*missing is not a directory\. Point it at the directory/,
		));

	test("a deckDir with no deck", () =>
		refuses(mkdtempSync(join(root, "empty-")), /holds no deck/));

	test("a deck.json that is not JSON", () =>
		refuses(
			deckDirWith("bad", "{ nope"),
			/deck bad: deck\.json cannot be read as JSON/,
		));

	test("a manifest without cards", () =>
		refuses(
			deckDirWith("bad", { name: "Bad" }),
			/deck bad: deck\.json is not a valid manifest/,
		));

	test("a card with an empty name", () =>
		refuses(
			deckDirWith("bad", { name: "Bad", cards: [{ id: "x", name: "" }] }),
			/deck bad: deck\.json is not a valid manifest at \/cards\/0\/name/,
		));

	test("a field the manifest does not know", () =>
		refuses(
			deckDirWith("bad", { name: "Bad", cards: [card("x")], colour: "red" }),
			/deck bad: deck\.json is not a valid manifest/,
		));

	test("two cards with one id", () =>
		refuses(
			deckDirWith("bad", { name: "Bad", cards: [card("x"), card("x")] }),
			'deck bad: two cards share the id "x".',
		));

	test("a deck directory name that is not a deck id", () =>
		refuses(
			deckDirWith("Bad Deck", { name: "Bad", cards: [card("x")] }),
			/deck Bad Deck: the directory name must be lowercase/,
		));

	test("a face that does not exist", () =>
		refuses(
			deckDirWith("bad", {
				name: "Bad",
				cards: [card("x", { file: "x.png" })],
			}),
			"deck bad: card x: file x.png does not exist in the deck directory.",
		));

	test("a face outside the deck directory", () =>
		refuses(
			deckDirWith(
				"bad",
				{ name: "Bad", cards: [card("x", { file: "../outside.png" })] },
				{},
			),
			"deck bad: card x: file ../outside.png must stay inside the deck directory.",
		));

	test("a face that is an absolute path", () =>
		refuses(
			deckDirWith("bad", {
				name: "Bad",
				cards: [card("x", { file: "/etc/hosts" })],
			}),
			"deck bad: card x: file /etc/hosts must stay inside the deck directory.",
		));

	test("a face of a type canvas does not read", () =>
		refuses(
			deckDirWith(
				"bad",
				{ name: "Bad", cards: [card("x", { file: "x.tiff" })] },
				{ "x.tiff": "data" },
			),
			/deck bad: card x: file x\.tiff must be one of \.png, \.jpg, \.jpeg, \.gif\./,
		));

	test("a file that is not an image, whatever its name", () =>
		refuses(
			deckDirWith(
				"bad",
				{ name: "Bad", cards: [card("x", { file: "x.png" })] },
				{ "x.png": "this is text" },
			),
			/deck bad: card x: file x\.png cannot be read as an image/,
		));

	test("a face too tall or too wide to be a card", () => {
		refuses(
			deckDirWith(
				"bad",
				{ name: "Bad", cards: [card("x", { file: "x.png" })] },
				{ "x.png": facePng("x", 0, 20, 200) },
			),
			/deck bad: card x: file x\.png is 20 by 200 px/,
		);
	});

	test("an aspect no card can have", () => {
		for (const aspect of [0, 0.01, 200])
			refuses(
				deckDirWith("bad", { name: "Bad", aspect, cards: [card("x")] }),
				/deck bad: deck\.json is not a valid manifest at \/aspect/,
			);
	});

	test("a file name that only starts with two dots is inside the deck", () => {
		const dir = deckDirWith(
			"ok",
			{ name: "Ok", cards: [card("x", { file: "..faces/x.png" })] },
			{ "..faces/x.png": facePng("x", 0) },
		);
		expect(loadDecks(dir)[0]?.cards[0]?.face).toEndWith("/ok/..faces/x.png");
	});

	test("a face that is a link out of the deck directory", () => {
		const dir = deckDirWith("bad", {
			name: "Bad",
			cards: [card("x", { file: "link.png" })],
		});
		symlinkSync("/etc/hosts", join(dir, "bad", "link.png"));
		expect(() => loadDecks(dir)).toThrow(
			"deck bad: card x: file link.png must stay inside the deck directory.",
		);
	});
});

describe("the plugin's setup", () => {
	test("a wrong deck directory stops the start with an error that names the plugin", async () => {
		const failure = await testPlugin(
			drawing({ deckDir: join(root, "missing") }),
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(PluginError);
		expect((failure as Error).message).toStartWith("plugin drawing: deckDir ");
	});
});
