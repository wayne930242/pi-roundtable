import type { AttachmentPort, ChannelKey } from "pi-roundtable";
import { RateWindow } from "./budget.ts";
import { baseType, bytesMatchType, isAllowedType } from "./file-types.ts";

/** The types a web chat takes unless its `limits.attachmentTypes` says otherwise. */
export const DEFAULT_ATTACHMENT_TYPES: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"application/json",
	"text/plain",
	"application/pdf",
];

/** The limits of uploads and of the attachments a message carries. */
export interface UploadLimits {
	/** The largest file in bytes; default 10 MiB, and never over the core's 25 MiB. */
	attachmentBytes: number;
	/** The most files one message may reference; default 8. */
	attachmentsPerMessage: number;
	/** Uploads one person may make in any hour; default 60. */
	uploadsPerHour: number;
	/** The bytes one person may have uploaded and not yet sent in a message; default 64 MiB. */
	unsentUploadBytesPerPrincipal: number;
	/**
	 * The bytes one person's messages may keep in all their conversations, until a conversation is
	 * deleted and gives its bytes back; default 1 GiB.
	 */
	usedAttachmentBytesPerPrincipal: number;
	/** The content types accepted, such as `image/png`; an entry ending in `/*` admits every type under it. */
	attachmentTypes: readonly string[];
	/** How long an upload no message referenced is kept before it is deleted; default 24 hours. */
	unsentUploadTtlMs: number;
}

/** Why an upload was refused, as the HTTP status and error code the client reads. */
export class UploadRefusal extends Error {
	override name = "UploadRefusal";
	readonly status: number;
	readonly code:
		| "bad_request"
		| "payload_too_large"
		| "unsupported_media_type"
		| "too_many_uploads";

	constructor(status: number, code: UploadRefusal["code"]) {
		super(code);
		this.status = status;
		this.code = code;
	}
}

/** What an upload returns: `file` is what a `send` frame's `attachments` names. */
export interface UploadedFile {
	file: string;
	name: string;
	contentType: string;
	size: number;
}

export interface UploadsDeps {
	limits: UploadLimits;
	/** Read when used, after the host linked every plugin. */
	attachments(): AttachmentPort;
	/** The clock, in milliseconds; default `Date.now`. */
	now?(): number;
}

const HOUR_MS = 60 * 60_000;
/** The longest file name accepted, in characters. */
const NAME_CHARS = 255;

/** Control characters, line and paragraph separators, and bidi controls: none reaches a prompt or a screen as it is. */
const UNSAFE_NAME_CHARS =
	/[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
/** A plain type/subtype, the grammar a configured `attachmentTypes` entry has too. */
const PLAIN_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;

/**
 * A name the model can read in its prompt: control and bidi characters and line separators become
 * underscores and quotes become apostrophes, so a name cannot add lines or close the quotes
 * around it.
 */
function safeName(name: string | null): string {
	const cleaned = (name ?? "")
		.replace(UNSAFE_NAME_CHARS, "_")
		.replaceAll('"', "'")
		.trim();
	if (cleaned === "" || cleaned.length > NAME_CHARS)
		throw new UploadRefusal(400, "bad_request");
	return cleaned;
}

/** The request body, or undefined once it passes `max` bytes; the rest of the stream is not read. */
async function readLimited(
	request: Request,
	max: number,
): Promise<Uint8Array | undefined> {
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > max) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * The files people upload to their conversations before they send a message: it checks the
 * content type, the bytes, the size and the person's allowance, and keeps the file with the
 * core's attachment port until a message uses it. Who may upload to which conversation is the
 * chat's to decide before it calls `receive`.
 */
export class Uploads {
	readonly #deps: UploadsDeps;
	readonly #rate: RateWindow;
	/** The bytes each person's uploads in flight may still write, counted against their allowance. */
	readonly #reserved = new Map<string, number>();
	/** The last admission queued for each person, which the next one waits for. */
	readonly #admissions = new Map<string, Promise<void>>();

	constructor(deps: UploadsDeps) {
		this.#deps = deps;
		this.#rate = new RateWindow(
			deps.limits.uploadsPerHour,
			HOUR_MS,
			deps.now ?? Date.now,
		);
	}

	/** What `ready` tells a client about attachments. */
	get advertised(): {
		maxBytes: number;
		perMessage: number;
		types: readonly string[];
	} {
		const { limits } = this.#deps;
		return {
			maxBytes: limits.attachmentBytes,
			perMessage: limits.attachmentsPerMessage,
			types: limits.attachmentTypes,
		};
	}

	/**
	 * Reserves the bytes an upload may write against the person's allowance, one admission at a
	 * time per person, so uploads in flight together count against it and not only the ones saved.
	 * Returns the bytes reserved, and the most the body may be.
	 */
	#admit(
		principalId: string,
		declared: number | undefined,
	): Promise<{ reserved: number; cap: number }> {
		const { limits } = this.#deps;
		const run = async () => {
			const holding = this.#reserved.get(principalId) ?? 0;
			const waiting = await this.#deps.attachments().pendingBytes(principalId);
			const room = Math.max(
				limits.unsentUploadBytesPerPrincipal - waiting - holding,
				0,
			);
			const cap = Math.min(limits.attachmentBytes, room);
			if (declared !== undefined && declared > room)
				throw new UploadRefusal(429, "too_many_uploads");
			const reserved = declared === undefined ? cap : Math.min(declared, cap);
			this.#reserved.set(principalId, holding + reserved);
			return { reserved, cap };
		};
		const result = (
			this.#admissions.get(principalId) ?? Promise.resolve()
		).then(run);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.#admissions.set(principalId, tail);
		void tail.then(() => {
			if (this.#admissions.get(principalId) === tail)
				this.#admissions.delete(principalId);
		});
		return result;
	}

	#release(principalId: string, reserved: number): void {
		const left = (this.#reserved.get(principalId) ?? 0) - reserved;
		if (left > 0) this.#reserved.set(principalId, left);
		else this.#reserved.delete(principalId);
	}

	/** Takes the request's body as a file for `principalId` in `channel`; throws an UploadRefusal. */
	async receive(
		request: Request,
		channel: ChannelKey,
		principalId: string,
		name: string | null,
	): Promise<UploadedFile> {
		const { limits } = this.#deps;
		const fileName = safeName(name);
		const type = baseType(request.headers.get("content-type"));
		if (
			!type ||
			!PLAIN_TYPE.test(type) ||
			!isAllowedType(limits.attachmentTypes, type)
		)
			throw new UploadRefusal(415, "unsupported_media_type");
		const header = request.headers.get("content-length");
		const length = header === null ? Number.NaN : Number(header);
		// A header that is no length is no declaration; the body is held to the room left instead.
		const declared =
			Number.isFinite(length) && length >= 0 ? length : undefined;
		if (declared !== undefined && declared > limits.attachmentBytes)
			throw new UploadRefusal(413, "payload_too_large");
		if (!this.#rate.take(principalId))
			throw new UploadRefusal(429, "too_many_uploads");
		const { reserved, cap } = await this.#admit(principalId, declared);
		let held = reserved;
		const release = () => {
			this.#release(principalId, held);
			held = 0;
		};
		try {
			const bytes = await readLimited(request, reserved);
			if (!bytes)
				// A body past its declared length lied; one past the room left is the allowance's.
				throw declared === undefined && cap < limits.attachmentBytes
					? new UploadRefusal(429, "too_many_uploads")
					: new UploadRefusal(413, "payload_too_large");
			if (!bytesMatchType(type, bytes))
				throw new UploadRefusal(415, "unsupported_media_type");
			const stored = await this.#deps.attachments().save(channel, principalId, {
				name: fileName,
				contentType: type,
				data: bytes,
			});
			// The saved file counts as waiting from here on.
			release();
			return {
				file: stored.file,
				name: stored.name,
				contentType: stored.contentType,
				size: stored.size,
			};
		} finally {
			release();
		}
	}

	/** Deletes the uploads no message used within the time to live; returns how many. */
	sweep(): Promise<number> {
		const now = (this.#deps.now ?? Date.now)();
		return this.#deps
			.attachments()
			.discardPending(new Date(now - this.#deps.limits.unsentUploadTtlMs));
	}
}
