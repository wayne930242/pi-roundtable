import { isRecord } from "./protocol.ts";

export const PI_RUN_DIR = "/run/sandbox";
export const PI_WORKSPACE = "/workspace";
export const PI_BROKER_SOCKET = "broker.sock";
export const PI_ATTACHMENTS = "attachments";
export const PI_OUTBOX = "outbox";
export const PI_FORWARDER_PORT = 8080;
export const PI_DUMMY_TOKEN = "sandbox-dummy-token";
export const PI_MEDIA_LIMITS = {
	images: 8,
	imageBytes: 20 * 1024 * 1024,
	totalImageBytes: 64 * 1024 * 1024,
	files: 10,
	fileBytes: 10 * 1024 * 1024,
	totalFileBytes: 50 * 1024 * 1024,
} as const;
export const PI_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];
export interface PiImage {
	data: string;
	mimeType: string;
}
export interface PiTurnRequest {
	turnId: string;
	author: { id: string; name: string; principalId?: string };
	text: string;
	memory: string;
	/** Defaults to private for older callers; shared prompt blocks do not taint a reader record. */
	memoryVisibility?: "shared" | "private";
	images: PiImage[];
	thinking: PiThinkingLevel;
}
export interface PiReplyFile {
	name: string;
	data: string;
}
export type PiTurnResponse =
	| { ok: true; text: string; files: PiReplyFile[] }
	| { ok: false; error: string };
export function validateReplyFiles(
	files: unknown,
): asserts files is PiReplyFile[] {
	if (!Array.isArray(files) || files.length > PI_MEDIA_LIMITS.files)
		throw new Error("Too many reply files");
	let total = 0;
	for (const file of files) {
		if (
			!isRecord(file) ||
			typeof file.name !== "string" ||
			!safeFileName(file.name) ||
			typeof file.data !== "string" ||
			file.data.length === 0 ||
			file.data.length > Math.ceil(PI_MEDIA_LIMITS.fileBytes / 3) * 4 ||
			file.data.length % 4 !== 0 ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
		)
			throw new Error("Invalid reply file");
		const size = Buffer.byteLength(file.data, "base64");
		total += size;
		if (
			size > PI_MEDIA_LIMITS.fileBytes ||
			total > PI_MEDIA_LIMITS.totalFileBytes
		)
			throw new Error("Reply file budget exceeded");
	}
}
export interface PiToolResponse {
	ok: boolean;
	text?: string;
	error?: string;
	image?: PiImage;
	/** The principal who may read this tool exchange, including its arguments. */
	privateTo?: string;
}
export interface PiTurnContext {
	authorId: string;
	authorName: string;
	/** Falls back to authorId for legacy workers whose actor id is already their principal. */
	authorPrincipalId?: string;
	outbox: string;
	memory: string;
	memoryVisibility?: "shared" | "private";
}
export interface PiMcpDiscovery {
	servers: { name: string; tools: string[] }[];
}
/** What the worker learns from the host at startup; `compaction` is absent when the host has no compactor. */
export interface PiWorkerConfig {
	compaction?: { engine: string };
}
/** The JSON of one Pi `AgentMessage` from the worker's session. */
export type PiCompactMessage = { role: string } & Record<string, unknown>;
/** The worker's compaction preparation, sent to the host's compactor. */
export interface PiCompactRequest {
	/** What triggered the compaction: a manual compact, the context threshold, or an overflow. */
	reason: "manual" | "threshold" | "overflow";
	tokensBefore: number;
	/** The first session entry the compaction keeps; a compaction must keep the same one. */
	firstKeptEntryId: string;
	/** Whether the cut falls inside a turn, so `turnPrefixMessages` holds that turn's start. */
	isSplitTurn: boolean;
	messagesToSummarize: PiCompactMessage[];
	turnPrefixMessages: PiCompactMessage[];
	/** The messages from `firstKeptEntryId` on, which stay in the context. */
	keptMessages: PiCompactMessage[];
	previousSummary?: string;
	customInstructions?: string;
	/** Files only read, and files written or edited, in the summarized messages. */
	readFiles: string[];
	modifiedFiles: string[];
}
/** A compaction the host's compactor wrote, shaped as Pi's `CompactionResult`. */
export interface PiCompaction {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	details?: unknown;
}
/** The host's answer: a compaction, or a fallback to Pi's own summary with its reason. */
export type PiCompactResponse =
	| { ok: true; compaction: PiCompaction }
	| { ok: false; fallback: string };
/** What the worker tells the host about its compactions, so the host logs them per channel. */
export type PiCompactionReport =
	| {
			type: "bypass";
			/** Why the hard ceiling skipped the host's compactor for Pi's summary. */
			reason: string;
			tokensBefore: number;
	  }
	| {
			type: "end";
			reason: PiCompactRequest["reason"];
			aborted: boolean;
			willRetry: boolean;
			/** Absent when the compaction failed. */
			engine?: "extension" | "pi";
			tokensBefore?: number;
			tokensAfter?: number;
			nextCompactionAt?: number;
			error?: string;
	  };
const COMPACT_REASONS = ["manual", "threshold", "overflow"];
function isMessageList(value: unknown): value is PiCompactMessage[] {
	return (
		Array.isArray(value) &&
		value.every((item) => isRecord(item) && typeof item.role === "string")
	);
}
function isStringList(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}
function isTokenCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function validateCompactRequest(
	value: unknown,
): asserts value is PiCompactRequest {
	if (
		!isRecord(value) ||
		!COMPACT_REASONS.includes(value.reason as string) ||
		!isTokenCount(value.tokensBefore) ||
		typeof value.firstKeptEntryId !== "string" ||
		value.firstKeptEntryId.length === 0 ||
		value.firstKeptEntryId.length > 256 ||
		typeof value.isSplitTurn !== "boolean" ||
		!isMessageList(value.messagesToSummarize) ||
		!isMessageList(value.turnPrefixMessages) ||
		!isMessageList(value.keptMessages) ||
		(value.previousSummary !== undefined &&
			typeof value.previousSummary !== "string") ||
		(value.customInstructions !== undefined &&
			typeof value.customInstructions !== "string") ||
		!isStringList(value.readFiles) ||
		!isStringList(value.modifiedFiles)
	)
		throw new Error("Invalid compact request");
}
export function validateCompactionReport(
	value: unknown,
): asserts value is PiCompactionReport {
	const valid =
		isRecord(value) &&
		(value.type === "bypass"
			? typeof value.reason === "string" &&
				value.reason.length <= 1000 &&
				isTokenCount(value.tokensBefore)
			: value.type === "end" &&
				COMPACT_REASONS.includes(value.reason as string) &&
				typeof value.aborted === "boolean" &&
				typeof value.willRetry === "boolean" &&
				(value.engine === undefined ||
					value.engine === "extension" ||
					value.engine === "pi") &&
				[value.tokensBefore, value.tokensAfter, value.nextCompactionAt].every(
					(count) => count === undefined || isTokenCount(count),
				) &&
				(value.error === undefined ||
					(typeof value.error === "string" && value.error.length <= 10_000)));
	if (!valid) throw new Error("Invalid compaction report");
}
export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
	return (
		typeof value === "string" &&
		(PI_THINKING_LEVELS as readonly string[]).includes(value)
	);
}
export function safeFileName(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= 255 &&
		!/[\\/\\\\\p{Cc}]/u.test(name) &&
		name !== "." &&
		name !== ".."
	);
}
export function validateImages(images: unknown): asserts images is PiImage[] {
	if (!Array.isArray(images) || images.length > PI_MEDIA_LIMITS.images)
		throw new Error("Too many images");
	let total = 0;
	for (const image of images) {
		if (
			!isRecord(image) ||
			typeof image.data !== "string" ||
			typeof image.mimeType !== "string" ||
			!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
				image.mimeType,
			) ||
			image.data.length > Math.ceil(PI_MEDIA_LIMITS.imageBytes / 3) * 4 ||
			image.data.length % 4 !== 0 ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
		)
			throw new Error("Invalid or oversized image");
		const size = Buffer.byteLength(image.data, "base64");
		total += size;
		if (
			size === 0 ||
			size > PI_MEDIA_LIMITS.imageBytes ||
			total > PI_MEDIA_LIMITS.totalImageBytes
		)
			throw new Error("Image budget exceeded");
	}
}
export function validatePiTurn(value: unknown): asserts value is PiTurnRequest {
	if (
		!isRecord(value) ||
		typeof value.turnId !== "string" ||
		!safeFileName(value.turnId) ||
		!isRecord(value.author) ||
		typeof value.author.id !== "string" ||
		typeof value.author.name !== "string" ||
		value.author.id.length > 256 ||
		value.author.name.length > 256 ||
		(value.author.principalId !== undefined &&
			(typeof value.author.principalId !== "string" ||
				value.author.principalId.length === 0 ||
				value.author.principalId.length > 256)) ||
		typeof value.text !== "string" ||
		value.text.length > 100_000 ||
		typeof value.memory !== "string" ||
		value.memory.length > 100_000 ||
		(value.memoryVisibility !== undefined &&
			value.memoryVisibility !== "shared" &&
			value.memoryVisibility !== "private") ||
		!isPiThinkingLevel(value.thinking)
	)
		throw new Error("Invalid turn");
	validateImages(value.images);
}
