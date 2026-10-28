import { MAX_MESSAGE_CHARS } from "../../src/api-types.ts";

// What the composer decides about files and long text, as plain functions so it can be tested
// without a browser: the composer only carries the decisions out.

/** A paste at least this long becomes a text file in the message instead of filling the box. */
export const PASTE_AS_FILE_CHARS = 4000;
/** What a message says when its text was too long and went as a file. */
export const LONG_TEXT_NOTE = "(long text attached)";
/** The name of the file a too-long message goes as. */
export const OVERFLOW_FILE_NAME = "message.txt";

/** How many files a message may carry, and how large each may be. */
export interface AttachLimits {
	perMessage: number;
	maxBytes: number;
}

/** The first line of a text with something on it, cut to `max` characters. */
export function firstLine(text: string, max = 80): string {
	const line = text.split("\n").find((one) => one.trim() !== "") ?? "";
	const flat = line.trim().replace(/\s+/g, " ");
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The next free `pasted-text-<n>.txt` among the names taken. */
export function pastedTextName(taken: readonly string[]): string {
	for (let n = 1; ; n += 1) {
		const name = `pasted-text-${n}.txt`;
		if (!taken.includes(name)) return name;
	}
}

/** A text as a UTF-8 file, which is what the server keeps as text and the agent opens. */
export const textFile = (name: string, text: string): File =>
	new File([text], name, { type: "text/plain" });

/** What a paste into the box does. */
export type PastePlan =
	/** The clipboard carries files: attach them. */
	| { kind: "files"; files: File[] }
	/** A long text: it becomes a chip. */
	| { kind: "text"; text: string }
	/** A long text with no slot left for it as a file: refuse it with a notice. */
	| { kind: "full" }
	/** An ordinary paste: the box takes it. */
	| { kind: "insert" };

export function planPaste(
	clipboard: { files: readonly File[]; text: string },
	used: number,
	limits: AttachLimits | undefined,
): PastePlan {
	if (clipboard.files.length > 0)
		return { kind: "files", files: [...clipboard.files] };
	if (clipboard.text.length < PASTE_AS_FILE_CHARS) return { kind: "insert" };
	return limits && used >= limits.perMessage
		? { kind: "full" }
		: { kind: "text", text: clipboard.text };
}

/** Which of some files to attach (picked, pasted or dropped), and why the others are not. */
export interface FilePlan {
	accepted: File[];
	tooLarge: File[];
	/** Files left over once the message has all the files it may carry. */
	full: File[];
}

export function planFiles(
	list: readonly File[],
	used: number,
	limits: AttachLimits | undefined,
): FilePlan {
	const plan: FilePlan = { accepted: [], tooLarge: [], full: [] };
	for (const file of list) {
		if (limits && file.size > limits.maxBytes) plan.tooLarge.push(file);
		else if (limits && used + plan.accepted.length >= limits.perMessage)
			plan.full.push(file);
		else plan.accepted.push(file);
	}
	return plan;
}

/** What a send does with the text: send it as it is, or send it as a file with a short line. */
export type SendPlan =
	| { ok: true; text: string; overflow?: string }
	| { ok: false; reason: "full" };

export function planSend(
	text: string,
	used: number,
	limits: AttachLimits | undefined,
): SendPlan {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_MESSAGE_CHARS) return { ok: true, text: trimmed };
	if (limits && used >= limits.perMessage) return { ok: false, reason: "full" };
	return { ok: true, text: LONG_TEXT_NOTE, overflow: trimmed };
}

/** Whether a long text chip, taken back into the box, fits there with what is typed. */
export function fitsBack(box: string, chipText: string): boolean {
	return joinBack(box, chipText).length <= MAX_MESSAGE_CHARS;
}

/** The box with the chip's text put back after what is typed. */
export function joinBack(box: string, chipText: string): string {
	if (box === "") return chipText;
	return `${box}${box.endsWith("\n") ? "" : "\n"}${chipText}`;
}
