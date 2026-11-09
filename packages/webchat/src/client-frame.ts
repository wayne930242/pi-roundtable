import { type OwnerAnswer, QUESTIONNAIRE_LIMITS } from "pi-roundtable";
import {
	CLIENT_FAILURES,
	type ClientFailure,
	type ClientFrame,
	MAX_CLIENT_TOOLS,
} from "./protocol.ts";

/** The longest function name a client may declare. */
const CLIENT_TOOL_CHARS = 64;
/** A function name: lowercase words joined by underscores, as a tool's name is. */
const CLIENT_TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/** The most binary parts one answer may declare, whatever the server's own limit is. */
const MAX_FRAME_PARTS = 16;
/** The longest failure message accepted from a client, in characters. */
const CLIENT_MESSAGE_CHARS = 2000;

/** The longest client reference, conversation id, or prompt id accepted. */
const ID_CHARS = 128;
/** The longest uploaded file reference accepted: a 36-character id, a dash, and a name cut to 120. */
const FILE_ID_CHARS = 200;
/** The most file references one frame may carry, whatever the server's own limit is. */
const MAX_FRAME_FILES = 32;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= ID_CHARS;

const isFileList = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.length <= MAX_FRAME_FILES &&
	value.every(
		(item) =>
			typeof item === "string" &&
			item.length > 0 &&
			item.length <= FILE_ID_CHARS,
	);

const optional = <T>(value: unknown, check: (v: unknown) => v is T) =>
	value === undefined || check(value);

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
		case "auth":
			return typeof value.token === "string" && value.token !== ""
				? { type: "auth", token: value.token }
				: undefined;
		case "send": {
			const { id, conversation, persona, text } = value;
			if (!isId(id) || typeof text !== "string") return undefined;
			if (!optional(conversation, isId) || !optional(persona, isId))
				return undefined;
			if (conversation === undefined && persona === undefined) return undefined;
			if (!optional(value.attachments, isFileList)) return undefined;
			const { attachments } = value;
			return {
				type: "send",
				id,
				text,
				...(conversation === undefined ? {} : { conversation }),
				...(persona === undefined ? {} : { persona }),
				...(attachments === undefined || attachments.length === 0
					? {}
					: { attachments }),
			};
		}
		case "stop":
			return isId(value.conversation)
				? { type: "stop", conversation: value.conversation }
				: undefined;
		case "approval":
			return isId(value.prompt) && typeof value.approved === "boolean"
				? { type: "approval", prompt: value.prompt, approved: value.approved }
				: undefined;
		case "answer": {
			const { prompt, choices, text } = value;
			if (!isId(prompt) || !Array.isArray(choices)) return undefined;
			if (!choices.every((choice) => typeof choice === "string"))
				return undefined;
			if (!optional(text, (t): t is string => typeof t === "string"))
				return undefined;
			return {
				type: "answer",
				prompt,
				choices: choices as string[],
				...(text === undefined ? {} : { text }),
			};
		}
		case "answers":
			return parseAnswers(value);
		case "prompt_features":
			return parseFeatures(value);
		case "client_hello":
			return parseHello(value);
		case "client_result":
			return parseResult(value);
		default:
			return undefined;
	}
}

function parseAnswers(value: Record<string, unknown>): ClientFrame | undefined {
	const { prompt, answers, note } = value;
	if (!isId(prompt) || !Array.isArray(answers)) return undefined;
	if (answers.length < 1 || answers.length > QUESTIONNAIRE_LIMITS.questions)
		return undefined;
	if (!optional(note, (n): n is string => typeof n === "string"))
		return undefined;
	const parsed: (OwnerAnswer | null)[] = [];
	for (const answer of answers as unknown[]) {
		if (answer === null) {
			parsed.push(null);
			continue;
		}
		if (!isRecord(answer) || !Array.isArray(answer.choices)) return undefined;
		const { choices, text } = answer;
		if (!choices.every((choice) => typeof choice === "string"))
			return undefined;
		if (!optional(text, (t): t is string => typeof t === "string"))
			return undefined;
		parsed.push({
			choices: choices as string[],
			...(text === undefined ? {} : { text }),
		});
	}
	return {
		type: "answers",
		prompt,
		answers: parsed,
		...(note === undefined ? {} : { note }),
	};
}

function parseFeatures(
	value: Record<string, unknown>,
): ClientFrame | undefined {
	const { ask } = value;
	if (!isRecord(ask)) return undefined;
	const { questions, previews, note } = ask;
	if (
		typeof questions !== "number" ||
		!Number.isInteger(questions) ||
		questions < 1 ||
		questions > QUESTIONNAIRE_LIMITS.questions ||
		typeof previews !== "boolean" ||
		typeof note !== "boolean"
	)
		return undefined;
	return { type: "prompt_features", ask: { questions, previews, note } };
}

function parseHello(value: Record<string, unknown>): ClientFrame | undefined {
	const { version, tools } = value;
	if (version !== 1 || !Array.isArray(tools)) return undefined;
	if (tools.length > MAX_CLIENT_TOOLS) return undefined;
	for (const tool of tools)
		if (
			typeof tool !== "string" ||
			tool.length > CLIENT_TOOL_CHARS ||
			!CLIENT_TOOL_NAME.test(tool)
		)
			return undefined;
	return {
		type: "client_hello",
		version: 1,
		tools: [...new Set(tools as string[])],
	};
}

function parseResult(value: Record<string, unknown>): ClientFrame | undefined {
	const { call, ok, message } = value;
	if (!isId(call) || typeof ok !== "boolean") return undefined;
	if (ok) {
		const { parts } = value;
		if (
			parts !== undefined &&
			(typeof parts !== "number" ||
				!Number.isInteger(parts) ||
				parts < 0 ||
				parts > MAX_FRAME_PARTS)
		)
			return undefined;
		return {
			type: "client_result",
			call,
			ok: true,
			value: value.value === undefined ? null : value.value,
			...(parts === undefined ? {} : { parts }),
		};
	}
	const { code } = value;
	if (!CLIENT_FAILURES.includes(code as ClientFailure)) return undefined;
	if (
		message !== undefined &&
		(typeof message !== "string" || message.length > CLIENT_MESSAGE_CHARS)
	)
		return undefined;
	return {
		type: "client_result",
		call,
		ok: false,
		code: code as ClientFailure,
		...(message === undefined ? {} : { message }),
	};
}
