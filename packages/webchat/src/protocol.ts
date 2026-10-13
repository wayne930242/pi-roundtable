import type {
	ApprovalDetails,
	AskOption,
	Tier,
	TurnProgress,
} from "pi-roundtable";
import type { Notice } from "./notices.ts";

/**
 * The WebSocket subprotocol a client offers, and the server echoes, for this version of the
 * protocol. A later incompatible version gets a new name, so an old client is refused at the
 * handshake rather than misreading frames.
 */
export const WEBCHAT_PROTOCOL = "roundtable.webchat.v1";

/** The version `ready` reports. */
export const WEBCHAT_PROTOCOL_VERSION = 1;

/** The subprotocol that carries a one-time ticket: `ticket.<ticket>`, offered beside `WEBCHAT_PROTOCOL`. */
export const TICKET_PROTOCOL_PREFIX = "ticket.";

/** Close codes the server uses besides the standard ones. */
export const CLOSE_CODES = Object.freeze({
	/** The token expired without a fresh `auth`, or a fresh one was refused. */
	tokenExpired: 4401,
	/** The person is no longer admitted: the policy gives them no tier, or a fresh token names someone else. */
	notAdmitted: 4403,
});

/** A persona a client may open a conversation with. */
export interface PersonaSummary {
	kind: string;
	label: string;
}

/** A file a reply carries, inline. */
export interface ReplyFileFrame {
	name: string;
	/** The bytes, base64. */
	data: string;
}

/** The most bytes (UTF-8, as JSON) an approval frame's `approval` carries before its long values are cut: 256 KiB. */
export const APPROVAL_MAX_BYTES = 256 * 1024;

/** An approval or a question the conversation's turn asks the person. */
export type PromptFrame =
	| {
			id: string;
			kind: "approval";
			title: string;
			/** The card as markdown text, as every client could always show it. */
			message: string;
			/**
			 * The same approval as data, when the server has it: the action, the tool, the call's whole
			 * input (not cut, unlike `message`, unless it passes `APPROVAL_MAX_BYTES`) and the files it sends by path with their size in bytes
			 * (absent when unreadable). A client shows this when it knows it, and `message` otherwise.
			 * When the serialized details would pass `APPROVAL_MAX_BYTES`, each long string value of
			 * `input` is cut to its start plus `… [N chars]` (N in code points) and `truncated` is true.
			 */
			approval?: ApprovalDetails & { truncated?: true };
	  }
	| {
			id: string;
			kind: "ask";
			title: string;
			question: string;
			/** None means a free-text answer. */
			options: readonly AskOption[];
			multi: boolean;
			allowOther: boolean;
	  };

/** How a prompt closed. */
export type PromptOutcome =
	| "approved"
	| "declined"
	| "answered"
	| "expired"
	| "cancelled";

/** The most functions a client may declare. */
export const MAX_CLIENT_TOOLS = 64;
/** The longest function name a client may declare. */
const CLIENT_TOOL_CHARS = 64;
/** A function name: lowercase words joined by underscores, as a tool's name is. */
const CLIENT_TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/** The most binary parts one answer may declare, whatever the server's own limit is. */
const MAX_FRAME_PARTS = 16;
/** The longest failure message accepted from a client, in characters. */
const CLIENT_MESSAGE_CHARS = 2000;

/** Why a client says a call failed; the server maps each to a `ClientCallError`. */
export const CLIENT_FAILURES = [
	"refused",
	"failed",
	"timeout",
	"stopped",
] as const;
export type ClientFailure = (typeof CLIENT_FAILURES)[number];

/** Why the server cancels a call it sent. */
export type ClientCancelReason = "turn_stopped" | "timeout" | "turn_ended";

/** What the server tells a client about the calls it may be asked to run. */
export interface ClientCallsAdvertised {
	/** How long a call waits for an answer unless it names a time, in milliseconds. */
	timeoutMs: number;
	/** The longest a call waits, in milliseconds. */
	maxTimeoutMs: number;
	/** The most bytes (UTF-8, as JSON) an answer's `value` may take. */
	maxValueBytes: number;
	/** The most binary parts one answer may carry. */
	maxParts: number;
	/** The most bytes of one part. */
	maxPartBytes: number;
}

/** Why the server refused a frame or a request. */
export type ErrorCode =
	| "bad_frame"
	| "unknown_conversation"
	| "forbidden"
	| "unknown_persona"
	| "unknown_prompt"
	| "too_many_conversations"
	| "busy"
	/** A `client_result` named a call that is not open on this connection. */
	| "unknown_call"
	/** A `send` named a file that is not waiting for this person in this conversation; the whole message is refused. */
	| "unknown_attachment"
	/** A `send` would take the person past `usedAttachmentBytesPerPrincipal`; the whole message is refused and its files stay waiting. */
	| "attachment_quota";

/** What a client sends: one JSON object per WebSocket text message. */
export type ClientFrame =
	/** A fresh token for the same person, sent when the server asks with `reauth`. */
	| { type: "auth"; token: string }
	/**
	 * A message. Without `conversation` it opens a new conversation of `persona`; `id` is the
	 * client's own reference, echoed by `accepted` or `error`.
	 */
	| {
			type: "send";
			id: string;
			conversation?: string;
			persona?: string;
			text: string;
			/**
			 * Files uploaded to the conversation (`POST <path>/conversations/<id>/files`) for this
			 * message, by the `file` each upload returned; at most `ready.attachments.perMessage`.
			 */
			attachments?: string[];
	  }
	/** Stops the conversation's running turn. */
	| { type: "stop"; conversation: string }
	/** Approves or declines an approval prompt. */
	| { type: "approval"; prompt: string; approved: boolean }
	/** Answers a question prompt: the chosen options' labels and, where allowed, their own text. */
	| { type: "answer"; prompt: string; choices: string[]; text?: string }
	/**
	 * Declares the functions this connection can run for the assistant's tools, such as reading the
	 * page the person has open. Send it after each `ready`. A connection that declares none is never
	 * asked to run anything, and its turns carry no client.
	 */
	| { type: "client_hello"; version: 1; tools: string[] }
	/**
	 * The answer to a `client_call`, sent on the connection the call arrived on. Binary parts are
	 * uploaded first (`PUT <path>/conversations/<id>/client-calls/<call>/parts/<n>`), and `parts`
	 * says how many; a failure names why, and `message` is shown to the assistant as data.
	 */
	| {
			type: "client_result";
			call: string;
			ok: true;
			value: unknown;
			parts?: number;
	  }
	| {
			type: "client_result";
			call: string;
			ok: false;
			code: ClientFailure;
			message?: string;
	  };

/** What the server sends: one JSON object per WebSocket text message. */
export type ServerFrame =
	/** The connection is authenticated; sent first, and again after a fresh token. */
	| {
			type: "ready";
			protocol: typeof WEBCHAT_PROTOCOL_VERSION;
			speaker: { id: string; name: string; tier: Tier; principalId: string };
			personas: readonly PersonaSummary[];
			/**
			 * What an upload may be: the most bytes in a file, the most files in a message, and the
			 * content types accepted, each exactly or as `<type>/*`. Absent from a server before 0.9.2,
			 * which takes no attachments: show no upload control then.
			 */
			attachments: {
				maxBytes: number;
				perMessage: number;
				types: readonly string[];
			};
			/** When the token expires, as an ISO time. */
			expiresAt: string;
			/**
			 * What a call to this client may take. Absent from a server before 0.9.11, which never sends
			 * `client_call`: show no feature that needs the page's help then.
			 */
			clientCalls?: ClientCallsAdvertised;
	  }
	/** The message `id` was taken into `conversation`, a new one when the client named none. */
	| { type: "accepted"; id: string; conversation: string }
	/** The assistant is, or is no longer, working in the conversation. */
	| { type: "typing"; conversation: string; on: boolean }
	/** A stop control applies, or no longer applies, to the conversation. */
	| { type: "stoppable"; conversation: string; on: boolean }
	/** What the running turn writes and which tools it runs, as it goes. */
	| { type: "progress"; conversation: string; event: TurnProgress }
	/** The turn's answer, in full markdown, with any files it made. */
	| {
			type: "reply";
			conversation: string;
			text: string;
			thinking?: string;
			files?: readonly ReplyFileFrame[];
	  }
	/** The turn ended without an answer: it failed, the host refused it before it ran, or it was stopped. The cause stays in the server's log. */
	| { type: "failed"; conversation: string; stopped: boolean }
	/** The turn asks the person; answer with `approval` or `answer`. */
	| { type: "prompt"; conversation: string; prompt: PromptFrame }
	| {
			type: "prompt_closed";
			conversation: string;
			prompt: string;
			outcome: PromptOutcome;
	  }
	/** A durable private inbox entry; fetch the REST inbox to recover missed notices. */
	| { type: "notice"; notice: Notice }
	/** The token expires soon: send `auth` with a fresh one before `expiresAt`, or the server closes with 4401. */
	| { type: "reauth"; expiresAt: string }
	/**
	 * The assistant asks this connection, and no other, to run a function it declared and answer
	 * with `client_result` within `timeoutMs`. One call is open on a connection at a time.
	 */
	| {
			type: "client_call";
			conversation: string;
			call: string;
			name: string;
			args: unknown;
			timeoutMs: number;
	  }
	/** The call is no longer wanted: stop running it; any answer is dropped. */
	| { type: "client_cancel"; call: string; reason: ClientCancelReason }
	/** A frame was refused; `ref` is the `send` id, prompt id or call id it was about. */
	| { type: "error"; code: ErrorCode; ref?: string };

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
		case "client_hello":
			return parseHello(value);
		case "client_result":
			return parseResult(value);
		default:
			return undefined;
	}
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
