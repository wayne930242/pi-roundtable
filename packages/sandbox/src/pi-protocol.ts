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
	author: { id: string; name: string };
	text: string;
	memory: string;
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
}
export interface PiTurnContext {
	authorId: string;
	authorName: string;
	outbox: string;
	memory: string;
}
export interface PiMcpDiscovery {
	servers: { name: string; tools: string[] }[];
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
		typeof value.text !== "string" ||
		value.text.length > 100_000 ||
		typeof value.memory !== "string" ||
		value.memory.length > 100_000 ||
		!isPiThinkingLevel(value.thinking)
	)
		throw new Error("Invalid turn");
	validateImages(value.images);
}
