import { messages } from "../../i18n/index.ts";
import { countPoints, firstPoints } from "./card-text.ts";

/** The longest label a card shows for a field, in code points. */
const LABEL_CHARS = 40;

/** A one-line string longer than this goes in a block of its own, as does any with a line break. */
const INLINE_CHARS = 100;

/** How many hidden labels a card lists. */
const HIDDEN_LABELS = 20;

/** One argument of a held call as a card shows it. */
export interface CardField {
	label: string;
	// pi-lens-ignore: no-unknown-parameters — a tool's argument is untyped model JSON
	value: unknown;
}

/** What the fields of a card may take up; see `fieldList`. */
export interface FieldLimits {
	/** The fewest code points of a long string kept when the fields do not fit whole. */
	valueChars: number;
	/** The most characters the field list takes up. */
	totalChars: number;
}

// pi-lens-ignore: no-unknown-parameters — a tool's parameter schema is untyped JSON
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The arguments of a call in the order its tool's parameter schema lists them, each labelled by
 * its property's `title` or else its name; absent arguments are left out, and an argument the
 * schema does not list follows the listed ones under its own name. Undefined when the schema
 * lists no properties, or the call has no arguments to show.
 */
export function schemaFields(
	input: Record<string, unknown> | undefined,
	// pi-lens-ignore: no-unknown-parameters — a tool's parameter schema is untyped JSON
	schema: unknown,
): CardField[] | undefined {
	if (!input || !isRecord(schema) || !isRecord(schema.properties))
		return undefined;
	const properties = schema.properties;
	const fields: CardField[] = [];
	for (const [name, property] of Object.entries(properties)) {
		const value = input[name];
		if (value === undefined) continue;
		const title =
			isRecord(property) && typeof property.title === "string"
				? property.title.trim()
				: "";
		fields.push({ label: title || name, value });
	}
	for (const [name, value] of Object.entries(input))
		if (value !== undefined && !(name in properties))
			fields.push({ label: name, value });
	return fields.length > 0 ? fields : undefined;
}

/**
 * The fields as the lines of a card, within `limits.totalChars`: a long string is cut, the
 * longest first and never below `limits.valueChars`, and marked `… [N chars]` with its length in
 * code points. If that is not enough the last fields are dropped and their labels listed, so a
 * card never hides that it shows less than the call carries.
 */
export function fieldList(fields: CardField[], limits: FieldLimits): string {
	const render = (limit: number, among: CardField[] = fields) =>
		among.map((field) => fieldLines(field, limit)).join("\n");
	const whole = render(Number.POSITIVE_INFINITY);
	if (whole.length <= limits.totalChars) return whole;
	let limit = limits.valueChars;
	if (render(limit).length <= limits.totalChars) {
		// The largest limit that still fits: the longest values give up characters first.
		let low = limit;
		let high = Math.max(low, longestValue(fields) - 1);
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (render(mid).length <= limits.totalChars) low = mid;
			else high = mid - 1;
		}
		limit = low;
		return render(limit);
	}
	// At least the first field stays, cut as far as the limit allows.
	const shown: CardField[] = [];
	let size = 0;
	for (const field of fields) {
		const lines = fieldLines(field, limit);
		if (shown.length > 0 && size + lines.length + 1 > limits.totalChars) break;
		shown.push(field);
		size += lines.length + 1;
	}
	const hidden = fields.slice(shown.length);
	const labels = hidden
		.slice(0, HIDDEN_LABELS)
		.map((field) => inline(firstPoints(field.label, LABEL_CHARS)));
	if (hidden.length > HIDDEN_LABELS) labels.push("…");
	return `${render(limit, shown)}\n${messages().cardHiddenKeys(labels)}`;
}

/** The code points in the longest string a field carries. */
function longestValue(fields: CardField[]): number {
	let longest = 0;
	for (const field of fields) {
		const text = textOf(field.value);
		if (text !== undefined) longest = Math.max(longest, countPoints(text));
	}
	return longest;
}

/**
 * The text a field's value is shown as, or undefined for a number, a boolean or null, which are
 * never cut: a string as it is, an array of such scalars joined, anything else as compact JSON.
 */
// pi-lens-ignore: no-unknown-parameters — a tool's argument is untyped model JSON
function textOf(value: unknown): string | undefined {
	if (typeof value === "string") return value.replaceAll("\r\n", "\n");
	if (value === null || typeof value === "number" || typeof value === "boolean")
		return undefined;
	if (Array.isArray(value) && value.every(isScalarText))
		return value.map((item) => String(item)).join(", ");
	return JSON.stringify(value);
}

// pi-lens-ignore: no-unknown-parameters — a tool's argument is untyped model JSON
function isScalarText(item: unknown): boolean {
	if (typeof item === "string") return !item.includes("\n");
	return item === null || typeof item === "number" || typeof item === "boolean";
}

/** One field as the lines of a card; strings over `limit` code points are cut and marked. */
function fieldLines(field: CardField, limit: number): string {
	const label = `**${inline(firstPoints(field.label, LABEL_CHARS))}**`;
	const text = textOf(field.value);
	if (text === undefined) return `${label}: ${String(field.value)}`;
	const points = countPoints(text);
	const cut = points > limit;
	const shown = cut ? firstPoints(text, limit) : text;
	const note = cut ? `… [${points} chars]` : "";
	const structured = typeof field.value !== "string" && !isScalarArray(field);
	if (structured)
		return shown.length + note.length <= INLINE_CHARS && !shown.includes("`")
			? `${label}: \`${shown}\`${note}`
			: `${label}:\n${fenced(`${shown}${note}`, "json")}`;
	return shown.includes("\n") || points > INLINE_CHARS
		? `${label}:\n${fenced(`${shown}${note}`)}`
		: `${label}: ${inline(shown)}${note}`;
}

function isScalarArray(field: CardField): boolean {
	return Array.isArray(field.value) && field.value.every(isScalarText);
}

/** `text` in a fenced block, which keeps its line breaks and in which nothing is markdown. */
function fenced(text: string, language = ""): string {
	return `\`\`\`${language}\n${text.replaceAll("```", "`\u200b``")}\n\`\`\``;
}

/**
 * `text` made safe to put inside a line of Discord markdown: nothing in it formats, links or
 * mentions anyone, and a line break becomes a space. An `@` stays, so an address reads as written.
 */
function inline(text: string): string {
	return text
		.replace(/\s*\n\s*/g, " ")
		.replace(/[\\*_~`|[\]<>]/g, "\\$&")
		.replace(/@(?=everyone|here)/g, "@\u200b");
}
