import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Image } from "canvas";
import { Type } from "typebox";
import Value from "typebox/value";

/** The image types node-canvas loads everywhere. */
export const FACE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif"] as const;

/** A deck's id is its directory name; it is what the model passes as `deck`. */
const DECK_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** The card heights, as a multiple of the width, that a spread can draw. */
export const MIN_ASPECT = 0.25;
export const MAX_ASPECT = 4;

const CardEntry = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		file: Type.Optional(Type.String({ minLength: 1 })),
		group: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const Manifest = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		reversals: Type.Optional(Type.Boolean()),
		aspect: Type.Optional(
			Type.Number({ minimum: MIN_ASPECT, maximum: MAX_ASPECT }),
		),
		cards: Type.Array(CardEntry, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export interface Card {
	id: string;
	name: string;
	/** The face image, as an absolute path; undefined draws a plain tile with the name. */
	face?: string;
	group?: string;
}

export interface Deck {
	/** The directory name, which the tool takes as `deck`. */
	id: string;
	/** The name the operator gave the deck in its manifest. */
	name: string;
	/** Whether a draw may turn cards upside down by default. */
	reversals: boolean;
	/** Card height divided by card width; undefined takes the ratio of the first face drawn. */
	aspect?: number;
	cards: readonly Card[];
}

/** A deck directory that cannot be used; the message names the deck and what to fix. */
export class DeckError extends Error {
	override name = "DeckError";
}

function fail(id: string, problem: string): never {
	throw new DeckError(`deck ${id}: ${problem}`);
}

function readManifest(id: string, dir: string) {
	const path = join(dir, "deck.json");
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return fail(
			id,
			`deck.json cannot be read as JSON (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	if (!Value.Check(Manifest, json)) {
		const first = Value.Errors(Manifest, json)[0];
		return fail(
			id,
			`deck.json is not a valid manifest at ${first?.instancePath || "the top level"}: ${first?.message ?? "unknown problem"}.`,
		);
	}
	return json;
}

/** Decodes the face once, so a file that is not an image stops the start rather than the first draw. */
function checkImage(id: string, card: string, file: string, path: string) {
	let problem: string | undefined;
	const image = new Image();
	image.onerror = (error) => {
		problem = error.message;
	};
	image.src = readFileSync(path);
	if (problem !== undefined || !image.complete || image.width === 0)
		fail(
			id,
			`card ${card}: file ${file} cannot be read as an image${problem ? ` (${problem})` : ""}.`,
		);
	const aspect = image.height / image.width;
	if (aspect < MIN_ASPECT || aspect > MAX_ASPECT)
		fail(
			id,
			`card ${card}: file ${file} is ${image.width} by ${image.height} px, a height of ${aspect.toFixed(2)} times the width; cards must be between ${MIN_ASPECT} and ${MAX_ASPECT}.`,
		);
}

/** Whether `path` is `dir` or below it. */
function within(dir: string, path: string): boolean {
	const inside = relative(dir, path);
	return (
		inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
	);
}

function faceFile(id: string, dir: string, card: string, file: string) {
	const outside = () =>
		fail(id, `card ${card}: file ${file} must stay inside the deck directory.`);
	const path = resolve(dir, file);
	if (isAbsolute(file) || !within(dir, path)) outside();
	if (
		!(FACE_EXTENSIONS as readonly string[]).includes(
			extname(path).toLowerCase(),
		)
	)
		fail(
			id,
			`card ${card}: file ${file} must be one of ${FACE_EXTENSIONS.join(", ")}.`,
		);
	if (!existsSync(path) || !statSync(path).isFile())
		fail(
			id,
			`card ${card}: file ${file} does not exist in the deck directory.`,
		);
	// A link may not lead out of the deck directory either.
	if (!within(realpathSync(dir), realpathSync(path))) outside();
	checkImage(id, card, file, path);
	return path;
}

/** Reads and checks one deck directory (`<id>/deck.json` and the faces it names). */
export function loadDeck(id: string, dir: string): Deck {
	if (!DECK_ID.test(id))
		fail(
			id,
			"the directory name must be lowercase letters, digits, dashes, or underscores, starting with a letter or digit. Rename the directory.",
		);
	const manifest = readManifest(id, dir);
	const seen = new Set<string>();
	const cards = manifest.cards.map((entry): Card => {
		if (seen.has(entry.id))
			fail(id, `two cards share the id ${JSON.stringify(entry.id)}.`);
		seen.add(entry.id);
		return {
			id: entry.id,
			name: entry.name,
			...(entry.file ? { face: faceFile(id, dir, entry.id, entry.file) } : {}),
			...(entry.group ? { group: entry.group } : {}),
		};
	});
	return {
		id,
		name: manifest.name,
		reversals: manifest.reversals ?? true,
		...(manifest.aspect ? { aspect: manifest.aspect } : {}),
		cards,
	};
}

/** Every deck under `deckDir`: each subdirectory that holds a `deck.json`. */
export function loadDecks(deckDir: string): Deck[] {
	if (!existsSync(deckDir) || !statSync(deckDir).isDirectory())
		throw new DeckError(
			`deckDir ${deckDir} is not a directory. Point it at the directory that holds one subdirectory for each deck.`,
		);
	const decks = readdirSync(deckDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				existsSync(join(deckDir, entry.name, "deck.json")),
		)
		.map((entry) => loadDeck(entry.name, join(deckDir, entry.name)))
		.sort((a, b) => a.id.localeCompare(b.id));
	if (decks.length === 0)
		throw new DeckError(
			`deckDir ${deckDir} holds no deck: add a subdirectory with a deck.json for each deck.`,
		);
	return decks;
}

/** The groups a deck names for its cards, in order of first appearance. */
export function groupsOf(deck: Deck): string[] {
	return [
		...new Set(deck.cards.flatMap((card) => (card.group ? [card.group] : []))),
	];
}
