import { definePlugin, defineTool, ToolRefusal } from "pi-roundtable";
import { Type } from "typebox";

/** Returns a number from 0 up to, not including, 1, like `Math.random`. */
export type Random = () => number;

const MAX_DICE = 100;
const MAX_SIDES = 1000;
const MAX_LENGTH = 200;
const MAX_MODIFIER = 1_000_000;
const FATE_DEFAULT = 4;

type KeepDrop = "k" | "kh" | "kl" | "d" | "dh" | "dl";

const TERM = /^(\d*)d(?:(f)|(\d+)(?:(kh|kl|dh|dl|k|d)(\d+))?)$/;

const refuse = (problem: string): never => {
	throw new ToolRefusal(
		`${problem} Write an expression such as 2d6+3, d20, 4d6k3, or 4dF.`,
	);
};

/** The indexes a keep or drop rule removes; `rolls` has more than `n` dice. */
function removed(
	rolls: readonly number[],
	rule: KeepDrop,
	n: number,
): number[] {
	const ascending = rolls
		.map((value, index) => ({ value, index }))
		.sort((a, b) => a.value - b.value || a.index - b.index)
		.map((die) => die.index);
	switch (rule) {
		case "k":
		case "kh":
			return ascending.slice(0, rolls.length - n);
		case "kl":
			return ascending.slice(n);
		case "d":
		case "dl":
			return ascending.slice(0, n);
		case "dh":
			return ascending.slice(rolls.length - n);
	}
}

/** One term rolled: what it shows, and what it adds before its sign applies. */
interface Rolled {
	shown: string;
	value: number;
	dice: number;
}

/** A plain number term. */
function rollNumber(term: string): Rolled {
	if (term.length > 7 || Number(term) > MAX_MODIFIER)
		return refuse(`The number ${term} is over ${MAX_MODIFIER}.`);
	return { shown: String(Number(term)), value: Number(term), dice: 0 };
}

/** `count` fate dice, each one of -1, 0, or +1. */
function rollFate(count: number, random: Random): Rolled {
	const faces = Array.from(
		{ length: count },
		() => Math.floor(random() * 3) - 1,
	);
	const symbols = faces.map((face) => (face > 0 ? "+" : face < 0 ? "-" : "0"));
	return {
		shown: `[${symbols.join(", ")}]`,
		value: faces.reduce((sum, face) => sum + face, 0),
		dice: count,
	};
}

/** `count` dice of `sides` sides, with an optional keep or drop rule that removes some of them. */
function rollPool(
	term: string,
	count: number,
	sides: number,
	rule: { kind: KeepDrop; n: number } | undefined,
	random: Random,
): Rolled {
	if (sides < 2 || sides > MAX_SIDES)
		return refuse(`"${term}" needs between 2 and ${MAX_SIDES} sides.`);
	const rolls = Array.from(
		{ length: count },
		() => Math.floor(random() * sides) + 1,
	);
	if (rule && (rule.n < 1 || rule.n >= count))
		return refuse(
			`"${term}" must keep or drop at least 1 and fewer than ${count} dice.`,
		);
	const dropped = new Set(rule ? removed(rolls, rule.kind, rule.n) : []);
	const shown = rolls.map((value, index) =>
		dropped.has(index) ? `(${value})` : String(value),
	);
	return {
		shown: `[${shown.join(", ")}]`,
		value: rolls.reduce(
			(sum, value, index) => sum + (dropped.has(index) ? 0 : value),
			0,
		),
		dice: count,
	};
}

function rollTerm(term: string, random: Random): Rolled {
	if (/^\d+$/.test(term)) return rollNumber(term);
	const match = TERM.exec(term);
	if (!match) return refuse(`"${term}" is not a dice term.`);
	const [, countText, fate, sidesText, rule, nText] = match;
	const count = countText ? Number(countText) : fate ? FATE_DEFAULT : 1;
	if (count < 1) return refuse(`"${term}" rolls no dice.`);
	if (count > MAX_DICE)
		return refuse(`"${term}" rolls more than ${MAX_DICE} dice.`);
	if (fate) return rollFate(count, random);
	return rollPool(
		term,
		count,
		Number(sidesText),
		rule ? { kind: rule as KeepDrop, n: Number(nText) } : undefined,
		random,
	);
}

/**
 * Rolls an expression of dice terms and numbers joined by `+` and `-`, and writes the result as
 * text such as `2d6+3: [3, 5] + 3 = 11`. A term is `NdS`, an optional keep or drop rule
 * (`k`/`kh` keep the highest, `kl` the lowest, `d`/`dl` drop the lowest, `dh` the highest, each
 * with a count), `NdF` fate dice (default 4), or a whole number. Dropped dice show in parentheses.
 * An invalid or oversized expression throws a `ToolRefusal` that says what to fix.
 */
export function roll(expression: string, random: Random = Math.random): string {
	const compact = expression.replace(/\s+/g, "");
	if (!compact) return refuse("The expression is empty.");
	if (compact.length > MAX_LENGTH)
		return refuse(`The expression is over ${MAX_LENGTH} characters.`);
	const parts = [...compact.toLowerCase().matchAll(/([+-]?)([^+-]+)/g)];
	if (parts.map((part) => part[0]).join("") !== compact.toLowerCase())
		return refuse(`"${compact}" is not a sum of dice and numbers.`);
	let total = 0;
	let dice = 0;
	let line = "";
	for (const [index, [, sign = "", term = ""]] of parts.entries()) {
		if (index > 0 && !sign)
			return refuse(`"${compact}" is not a sum of dice and numbers.`);
		const rolled = rollTerm(term, random);
		dice += rolled.dice;
		if (dice > MAX_DICE)
			return refuse(`The expression rolls more than ${MAX_DICE} dice in all.`);
		total += sign === "-" ? -rolled.value : rolled.value;
		line +=
			index === 0
				? `${sign === "-" ? "-" : ""}${rolled.shown}`
				: ` ${sign} ${rolled.shown}`;
	}
	return `${compact}: ${line} = ${total}`;
}

/** The plugin, with the random source replaceable for a test. */
export function createDice(random: Random = Math.random) {
	return definePlugin({
		name: "dice",
		setup: () => ({
			tools: [
				defineTool({
					name: "roll_dice",
					description: `Roll dice and report each die and the total. The expression joins terms with + and -: NdS rolls N dice of S sides (2d6, d20), a count after k/kh keeps the highest dice (4d6k3), kl keeps the lowest, d/dl drops the lowest, dh drops the highest, NdF rolls N fate dice (default 4), and a plain number adds itself (2d6+1d4-1). At most ${MAX_DICE} dice in all and ${MAX_SIDES} sides per die. Dropped dice show in parentheses.`,
					parameters: Type.Object({
						expression: Type.String({
							description: "For example 2d6+3 or 4d6k3",
						}),
					}),
					minTier: "member",
					run: ({ expression }) => roll(expression, random),
				}),
			],
		}),
	});
}

export const dice = createDice();
