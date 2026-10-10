import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { HeldCall } from "../../domain/conversation.ts";
import { messages } from "../../i18n/index.ts";
import type { ApprovalDetails } from "../../interactions/prompts.ts";

/** The fewest characters of a long string value in a held call's input its approval card keeps, when the input does not fit whole. */
const CARD_VALUE_CHARS = 200;

/** How many characters of the whole input its approval card shows, at most. */
const CARD_INPUT_CHARS = 1_500;

/** How many hidden key names a card lists, and how long each may be. */
const CARD_HIDDEN_KEYS = 20;
const CARD_KEY_CHARS = 40;

/** What an approval card shows of a call's input; see `approvalCard`. */
export interface CardLimits {
	/**
	 * The fewest characters of a long string value (at any depth) kept when the input is over
	 * `totalChars`; a value is cut only as far as the input needs, never below this. Counted in code points.
	 */
	valueChars?: number;
	/** Longest input shown. An input within it is shown whole; a longer one has its values cut, then the rest dropped. */
	totalChars?: number;
}

/**
 * What an approval card says: the held action's words, the exact call, and each file it sends by
 * path with the file's size now; relative paths resolve against `workspace`. An input within
 * `limits.totalChars` is shown whole. A longer one has its string values cut, the longest first
 * and never below `limits.valueChars`, each marked `… [N chars]` with its original length in code
 * points, until it fits, so one long value does not push the keys after it out of the card. If it
 * still does not fit, the rest is dropped and the keys that are no longer shown are listed.
 */
export function approvalCard(
	call: HeldCall,
	workspace?: string,
	limits: CardLimits = {},
): string {
	const input = shownInput(
		call.input,
		limits.valueChars ?? CARD_VALUE_CHARS,
		limits.totalChars ?? CARD_INPUT_CHARS,
	);
	const files = pathFiles(call.input).map(
		(path) => `\n-# ${messages().cardFile(path, fileSize(path, workspace))}`,
	);
	return `**${call.action}**\n-# \`${call.tool}\`\n\`\`\`json\n${input.replaceAll("```", "`\u200b``")}\n\`\`\`${files.join("")}`;
}

/** The input as a card shows it within `total` characters; see `approvalCard`. */
function shownInput(input: string, valueChars: number, total: number): string {
	if (input.length <= total) return input;
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		return `${prefix(input, total)}…`;
	}
	const longest = longestString(parsed);
	const cutAt = (limit: number) => cutValues(parsed, limit);
	let limit = valueChars;
	if (cutAt(limit).length <= total) {
		// The largest limit that still fits: the longest values give up characters first.
		let low = limit;
		let high = Math.max(low, longest - 1);
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (cutAt(mid).length <= total) low = mid;
			else high = mid - 1;
		}
		limit = low;
		return cutAt(limit);
	}
	const shown = cutAt(limit);
	const kept = prefix(shown, total);
	return `${kept}…${hiddenKeys(parsed, limit, kept.length)}`;
}

/** The longest string value in `value`, at any depth, in code points; 0 when there is none. */
// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
function longestString(value: unknown): number {
	let longest = 0;
	JSON.stringify(value, (_key, v: unknown) => {
		if (typeof v === "string" && v.length > longest)
			longest = Math.max(longest, countPoints(v));
		return v;
	});
	return longest;
}

/** `value` as JSON with each string longer than `limit` code points cut and marked `… [N chars]`. */
// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
function cutValues(value: unknown, limit: number): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (typeof v !== "string" || v.length <= limit) return v;
		const points = countPoints(v);
		if (points <= limit) return v;
		return `${firstPoints(v, limit)}… [${points} chars]`;
	});
}

/** The top-level keys, as a line for the card, whose names fall after the first `shown` characters of the cut input. */
// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
function hiddenKeys(parsed: unknown, limit: number, shown: number): string {
	if (!isPlainObject(parsed)) return "";
	const hidden: string[] = [];
	// Entries are laid out as `{"k":v,"k2":v2}`; an entry starts after the `{` and each comma.
	let offset = 1;
	for (const [key, value] of Object.entries(parsed)) {
		if (offset >= shown) hidden.push(key);
		offset += `${JSON.stringify(key)}:${cutValues(value, limit)},`.length;
	}
	if (hidden.length === 0) return "";
	const names = hidden
		.slice(0, CARD_HIDDEN_KEYS)
		.map((key) => JSON.stringify(firstPoints(key, CARD_KEY_CHARS)));
	if (hidden.length > CARD_HIDDEN_KEYS) names.push("…");
	return `\n${messages().cardHiddenKeys(names)}`;
}

/** How many code points `text` has. */
function countPoints(text: string): number {
	let points = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) i++;
		points++;
	}
	return points;
}

/** The first `count` code points of `text`. */
function firstPoints(text: string, count: number): string {
	let end = 0;
	for (let points = 0; points < count && end < text.length; points++) {
		const code = text.charCodeAt(end);
		end += code >= 0xd800 && code <= 0xdbff && end + 1 < text.length ? 2 : 1;
	}
	return text.slice(0, end);
}

/** The first `max` characters of `text`, backing off a cut that would split a surrogate pair. */
function prefix(text: string, max: number): string {
	if (text.length <= max) return text;
	const code = text.charCodeAt(max - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * A held call as data for a card that is not text: the action, the tool, the whole input, and
 * each file it sends by path with its size now (absent when unreadable). Unlike the text card,
 * nothing is cut and nothing is worded for a locale.
 */
export function approvalDetails(
	call: HeldCall,
	workspace?: string,
): ApprovalDetails {
	const files = pathFiles(call.input).map((path) => {
		const bytes = fileSize(path, workspace);
		return bytes === undefined ? { path } : { path, bytes };
	});
	return {
		action: call.action,
		tool: call.tool,
		input: parsedInput(call.input),
		...(files.length > 0 ? { files } : {}),
	};
}

/** A call's input object; `{}` for input that is not one (a held call's always is). */
function parsedInput(input: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(input);
		return isPlainObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** The paths of a call's `files` entries that name one. */
function pathFiles(input: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		return [];
	}
	const files = isPlainObject(parsed) ? parsed.files : undefined;
	if (!Array.isArray(files)) return [];
	return files.flatMap((file: unknown) =>
		isPlainObject(file) && typeof file.path === "string" ? [file.path] : [],
	);
}

/** A file's size in bytes, or undefined when it cannot be read. */
function fileSize(path: string, workspace: string | undefined) {
	try {
		const info = statSync(resolve(workspace ?? "/", path));
		return info.isFile() ? info.size : undefined;
	} catch {
		return undefined;
	}
}

// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
