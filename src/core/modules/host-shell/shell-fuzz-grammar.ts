import { CommandGen } from "./shell-fuzz-commands.ts";
import { Rng } from "./shell-fuzz-rng.ts";

/**
 * Seeded random bash command lines. The same seed always gives the same line, so a failure is
 * rebuilt from its seed alone.
 *
 * - `attack`: a line over the whole grammar with `sudo marker` planted in one or two command
 *   positions, in many spellings and wrappers, and sometimes pasted in at a random word boundary.
 * - `everyday`: lines of commands that an agent runs every day, from the plain half of the grammar.
 * - `benign`: lines over the whole grammar with no planted command, harmless fillers only.
 */
export type FuzzKind = "attack" | "everyday" | "benign";

/** Text pasted into an `attack` line at a random place, where bash may or may not run it. */
const PASTES = [
	"sudo marker;",
	";sudo marker",
	"\nsudo marker\n",
	"$(sudo marker)",
	"`sudo marker`",
	"&& sudo marker ",
	"|| sudo marker ",
	"| sudo marker ",
	"& sudo marker ",
	"(sudo marker)",
	"{ sudo marker; }",
	"\\\nsudo marker\n",
	"\r\nsudo marker\r\n",
];

/** Places in a line between words, where a paste starts a new word. */
function boundaries(line: string): number[] {
	const found = [0, line.length];
	for (let i = 0; i < line.length; i++)
		if (line[i] === " " || line[i] === "\n" || line[i] === ";")
			found.push(i + 1);
	return found;
}

/** One random line of the given kind. */
export function fuzzLine(seed: number, kind: FuzzKind): string {
	const dice = new Rng(seed ^ 0xa5a5a5a5);
	const maxDepth = dice.weighted(
		kind === "everyday"
			? [
					[5, 1],
					[3, 2],
				]
			: [
					[5, 1],
					[6, 2],
					[2, 3],
					[1, 5],
				],
	);
	const build = (plantAt: ReadonlySet<number>) =>
		new CommandGen(
			new Rng(seed),
			new Rng(seed ^ 0x5bd1e995),
			kind === "everyday",
			plantAt,
			maxDepth,
		);
	if (kind !== "attack") return build(new Set()).top();
	// A dry run counts the command positions; the same seed then builds the same line again.
	const dry = build(new Set());
	dry.top();
	const planted = new Set<number>();
	for (let i = dice.chance(0.2) ? 2 : 1; i > 0; i--)
		planted.add(dice.int(Math.max(1, dry.slots)));
	let line = build(planted).top();
	// Bash splits words at a blank or a newline only; other white space (a no-break space, a form
	// feed) is part of a word, though a script's own reader may treat it as a separator.
	if (dice.chance(0.1)) {
		const blank = dice.pick([
			"\u00a0",
			"\f",
			"\v",
			"\u2028",
			"\u3000",
			"\u200b",
		]);
		const at = [...line.matchAll(/ /g)].map((match) => match.index as number);
		for (let i = dice.int(3) + 1; i > 0 && at.length > 0; i--) {
			const place = dice.pick(at);
			line = `${line.slice(0, place)}${blank}${line.slice(place + 1)}`;
		}
	}
	if (dice.chance(0.2)) {
		const at = dice.pick(boundaries(line));
		line = `${line.slice(0, at)}${dice.pick(PASTES)}${line.slice(at)}`;
	}
	// Bash joins a backslash and a newline, wherever they stand outside single quotes and comments.
	if (dice.chance(0.1)) {
		for (let i = dice.int(2) + 1; i > 0; i--) {
			const at = dice.int(line.length + 1);
			line = `${line.slice(0, at)}\\\n${line.slice(at)}`;
		}
	}
	// Damage that bash may put up with: a character dropped, doubled, or swapped for an operator.
	if (dice.chance(0.12)) {
		const punctuation = [
			"'",
			'"',
			"`",
			"$",
			"(",
			")",
			"{",
			"}",
			"<",
			">",
			"|",
			"&",
			";",
			"#",
			"\\",
			"\n",
			"[",
			"]",
		];
		for (let i = dice.int(2) + 1; i > 0 && line.length > 0; i--) {
			const at = dice.int(line.length);
			const edit = dice.int(3);
			line =
				edit === 0
					? `${line.slice(0, at)}${line.slice(at + 1)}`
					: edit === 1
						? `${line.slice(0, at)}${line[at]}${line.slice(at)}`
						: `${line.slice(0, at)}${dice.pick(punctuation)}${line.slice(at + 1)}`;
		}
	}
	return line;
}
