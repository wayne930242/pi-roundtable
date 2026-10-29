import { QUESTIONNAIRE_LIMITS } from "pi-roundtable";
import {
	type ClientFrame,
	type FormInput,
	MAX_MESSAGE_FILES,
	type PromptAnswer,
} from "../api-types.ts";

export {
	APP_CLOSE_EXPIRED,
	APP_PROTOCOL,
	APP_PROTOCOL_VERSION,
	APPROVAL_MAX_BYTES,
	type ClientFrame,
	MAX_MESSAGE_CHARS,
	MAX_MESSAGE_FILES,
	type ServerFrame,
} from "../api-types.ts";

/** The longest room key, prompt id, upload id or client reference accepted. */
const ID_CHARS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= ID_CHARS;

const isText = (value: unknown): value is string => typeof value === "string";

const optional = <T>(value: unknown, check: (v: unknown) => v is T) =>
	value === undefined || check(value);

function parseAnswer(value: unknown): PromptAnswer | undefined {
	if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
	const { choices, text } = value;
	if (!choices.every(isText) || !optional(text, isText)) return undefined;
	return {
		choices: choices as string[],
		...(text === undefined ? {} : { text }),
	};
}

/** The most fields and the longest value a form's input may carry. */
const FORM_FIELDS = 40;
const FORM_VALUE_CHARS = 32_000;

/** A form's input: text, or a list of text, by field name. */
function parseInput(value: unknown): FormInput | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.length > FORM_FIELDS) return undefined;
	const input: Record<string, string | string[]> = {};
	for (const [name, field] of entries) {
		if (name.length === 0 || name.length > ID_CHARS) return undefined;
		if (typeof field === "string" && field.length <= FORM_VALUE_CHARS)
			input[name] = field;
		else if (
			Array.isArray(field) &&
			field.length <= FORM_FIELDS &&
			field.every((one) => isText(one) && one.length <= FORM_VALUE_CHARS)
		)
			input[name] = field as string[];
		else return undefined;
	}
	return input;
}

function parseAnswers(value: Record<string, unknown>): ClientFrame | undefined {
	const { prompt, answers, note } = value;
	if (!isId(prompt) || !Array.isArray(answers)) return undefined;
	if (answers.length < 1 || answers.length > QUESTIONNAIRE_LIMITS.questions)
		return undefined;
	if (!optional(note, isText)) return undefined;
	const parsed: (PromptAnswer | null)[] = [];
	for (const answer of answers as unknown[]) {
		if (answer === null) {
			parsed.push(null);
			continue;
		}
		const one = parseAnswer(answer);
		if (!one) return undefined;
		parsed.push(one);
	}
	return {
		type: "answers",
		prompt,
		answers: parsed,
		...(note === undefined ? {} : { note }),
	};
}

/** One client frame, checked field by field; undefined for anything else. */
export function parseClientFrame(
	raw: string | Uint8Array,
): ClientFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(
			typeof raw === "string" ? raw : new TextDecoder().decode(raw),
		);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	switch (value.type) {
		case "hello": {
			const { visible, focus } = value;
			if (typeof visible !== "boolean" || !optional(focus, isId))
				return undefined;
			return {
				type: "hello",
				visible,
				...(focus === undefined ? {} : { focus }),
			};
		}
		case "visibility":
			return typeof value.visible === "boolean"
				? { type: "visibility", visible: value.visible }
				: undefined;
		case "focus":
			if (!optional(value.room, isId)) return undefined;
			return {
				type: "focus",
				...(value.room === undefined ? {} : { room: value.room as string }),
			};
		case "send": {
			const { id, room, text, uploads, mode } = value;
			if (!isId(id) || !isId(room) || !isText(text)) return undefined;
			if (mode !== undefined && mode !== "note" && mode !== "turn")
				return undefined;
			if (
				uploads !== undefined &&
				!(
					Array.isArray(uploads) &&
					uploads.length <= MAX_MESSAGE_FILES &&
					uploads.every(isId)
				)
			)
				return undefined;
			return {
				type: "send",
				id,
				room,
				text,
				...(uploads === undefined || uploads.length === 0
					? {}
					: { uploads: uploads as string[] }),
				...(mode === undefined ? {} : { mode }),
			};
		}
		case "subscribe":
		case "unsubscribe":
			return isId(value.room)
				? { type: value.type, room: value.room }
				: undefined;
		case "act": {
			const { id, room, page, action, card, input } = value;
			if (!isId(id) || !isId(action)) return undefined;
			// One target: a room or a page, never both and never neither.
			if ((room === undefined) === (page === undefined)) return undefined;
			if (!optional(room, isId) || !optional(page, isId)) return undefined;
			if (!optional(card, isId)) return undefined;
			const parsed = input === undefined ? undefined : parseInput(input);
			if (input !== undefined && !parsed) return undefined;
			return {
				type: "act",
				id,
				action,
				...(room === undefined ? {} : { room: room as string }),
				...(page === undefined ? {} : { page: page as string }),
				...(card === undefined ? {} : { card: card as string }),
				...(parsed ? { input: parsed } : {}),
			};
		}
		case "ack":
			return isId(value.tag) ? { type: "ack", tag: value.tag } : undefined;
		case "read":
			return isId(value.room) &&
				typeof value.upTo === "number" &&
				Number.isSafeInteger(value.upTo) &&
				value.upTo >= 0
				? { type: "read", room: value.room, upTo: value.upTo }
				: undefined;
		case "stop":
			return isId(value.room) ? { type: "stop", room: value.room } : undefined;
		case "approval":
			return isId(value.prompt) && typeof value.approved === "boolean"
				? { type: "approval", prompt: value.prompt, approved: value.approved }
				: undefined;
		case "answer": {
			const answer = parseAnswer(value.answer);
			return isId(value.prompt) && answer
				? { type: "answer", prompt: value.prompt, answer }
				: undefined;
		}
		case "answers":
			return parseAnswers(value);
		case "cancel":
			return isId(value.prompt)
				? { type: "cancel", prompt: value.prompt }
				: undefined;
		default:
			return undefined;
	}
}
