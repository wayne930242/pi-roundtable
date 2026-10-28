import { extname } from "node:path";
import type { AttachmentFile, AttachmentRef } from "pi-roundtable";
import type { RoomFile, UploadView } from "../api-types.ts";
import { FILE_RETENTION_MS, type FileDir, safeName } from "./files.ts";
import {
	boundaryOf,
	MultipartError,
	type PartHeaders,
	type PartSink,
	readMultipart,
} from "./multipart.ts";

/** The most bytes of one uploaded file when the options say nothing else: 100 MiB. */
export const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
/** What the multipart framing of one file may add to a body: 64 KiB. */
export const UPLOAD_FRAMING_BYTES = 64 * 1024;
/** How long an upload no message used waits: 24 hours. */
export const UPLOAD_WAIT_MS = 24 * 3_600_000;
/** The most files one person may have waiting for a message, or on their way. */
const PENDING_PER_PRINCIPAL = 16;
/** The most bytes one person may have waiting for a message, or on their way: 400 MiB. */
const PENDING_BYTES_PER_PRINCIPAL = 400 * 1024 * 1024;
/** How much of the start of a file is kept to tell what it is. */
const HEAD_BYTES = 16;

/** The scheme of the references a message carries to its uploads: `app-upload:<id>`. */
const REF_PREFIX = "app-upload:";

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
	bytes.byteLength >= at + signature.length &&
	signature.every((byte, index) => bytes[at + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** The image type the first bytes say, if any; these four are the ones the page shows itself. */
function imageTypeOf(head: Uint8Array): string | undefined {
	if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
	if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a")))
		return "image/gif";
	if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8))
		return "image/webp";
	return undefined;
}

/** The image types a file's declared type may name; any other declared type says nothing the bytes must match. */
const CHECKED_IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

/** The type kept for a text file: what its name says among the text types, otherwise plain text. */
function textTypeOf(name: string, declared: string): string {
	switch (extname(name).toLowerCase()) {
		case ".md":
		case ".markdown":
			return "text/markdown";
		case ".csv":
			return "text/csv";
		case ".json":
			return "application/json";
		default:
			return declared === "application/json" ? declared : "text/plain";
	}
}

/**
 * What kind of file the bytes are, learned as they stream past: the first bytes, and whether
 * everything so far is UTF-8 text without a NUL. Nothing is held but the first few bytes.
 */
class Sniffer {
	#head: Uint8Array = new Uint8Array(0);
	#text = true;
	readonly #decoder = new TextDecoder("utf-8", { fatal: true });

	feed(chunk: Uint8Array): void {
		if (this.#head.byteLength < HEAD_BYTES) {
			const kept = new Uint8Array(
				Math.min(HEAD_BYTES, this.#head.byteLength + chunk.byteLength),
			);
			kept.set(this.#head, 0);
			kept.set(
				chunk.subarray(0, kept.byteLength - this.#head.byteLength),
				this.#head.byteLength,
			);
			this.#head = kept;
		}
		if (!this.#text) return;
		if (chunk.includes(0)) {
			this.#text = false;
			return;
		}
		try {
			this.#decoder.decode(chunk, { stream: true });
		} catch {
			this.#text = false;
		}
	}

	/** The verdict at the end of the file: the type it is kept as, or undefined when its declared image type is not what the bytes are. */
	verdict(name: string, declared: string): string | undefined {
		let complete = this.#text;
		if (complete) {
			try {
				this.#decoder.decode();
			} catch {
				complete = false;
			}
		}
		const image = imageTypeOf(this.#head);
		if (CHECKED_IMAGE_TYPES.has(declared) && image !== declared)
			return undefined;
		if (image) return image;
		if (complete) return textTypeOf(name, declared);
		if (startsWith(this.#head, ascii("%PDF-"))) return "application/pdf";
		return "application/octet-stream";
	}
}

/** Why an upload was refused; `status` is the HTTP answer. */
export class UploadRefusal extends Error {
	override name = "UploadRefusal";
	constructor(
		readonly status: 400 | 413 | 415 | 429,
		message: string,
	) {
		super(message);
	}
}

interface Waiting {
	principalId: string;
	at: number;
	size: number;
}

/**
 * The files the owner uploads for a message, kept on disk until a message uses them. A file is
 * its owner's alone: a message may only name uploads of its own sender. When a message takes
 * its uploads they move to the stored files, which keep 30 days, and the agent reads them
 * through the surface as `app-upload:<id>`; an upload no message uses is deleted after a day.
 * An upload is read as a stream and written to disk as it arrives, so its size costs disk, not
 * memory; what a person may have waiting is bounded in files and in bytes.
 */
export class Uploads {
	readonly #waiting: FileDir;
	readonly #stored: FileDir;
	readonly #pending = new Map<string, Waiting>();
	/** What uploads under way will take at most, by person: their declared lengths. */
	readonly #inflight = new Map<string, { files: number; bytes: number }>();
	readonly #now: () => number;
	readonly maxBytes: number;
	readonly #pendingBytes: number;

	constructor(
		waiting: FileDir,
		stored: FileDir,
		options: {
			maxBytes?: number;
			/** The most bytes one person may have waiting; default 400 MiB. */
			pendingBytes?: number;
			now?: () => number;
		} = {},
	) {
		this.#waiting = waiting;
		this.#stored = stored;
		this.#now = options.now ?? Date.now;
		this.maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
		this.#pendingBytes = options.pendingBytes ?? PENDING_BYTES_PER_PRINCIPAL;
	}

	#waitingOf(principalId: string): { files: number; bytes: number } {
		let files = 0;
		let bytes = 0;
		for (const w of this.#pending.values())
			if (w.principalId === principalId) {
				files += 1;
				bytes += w.size;
			}
		const flying = this.#inflight.get(principalId);
		return {
			files: files + (flying?.files ?? 0),
			bytes: bytes + (flying?.bytes ?? 0),
		};
	}

	/** Takes one file from a multipart body (field `file`); throws `UploadRefusal` when it is not accepted. */
	async receive(request: Request, principalId: string): Promise<UploadView> {
		const length = Number(request.headers.get("content-length"));
		if (!Number.isFinite(length) || length <= 0)
			throw new UploadRefusal(400, "The upload has no length.");
		if (length > this.maxBytes + UPLOAD_FRAMING_BYTES)
			throw new UploadRefusal(413, "The file is too large.");
		const waiting = this.#waitingOf(principalId);
		if (waiting.files >= PENDING_PER_PRINCIPAL)
			throw new UploadRefusal(429, "Too many files are waiting for a message.");
		if (waiting.bytes + length > this.#pendingBytes)
			throw new UploadRefusal(
				429,
				"Too much is waiting for a message. Send it, or wait a day for the rest to clear.",
			);
		const boundary = boundaryOf(request.headers.get("content-type"));
		if (!boundary || !request.body)
			throw new UploadRefusal(400, "The upload is not a form.");
		this.#inflight.set(principalId, {
			files: (this.#inflight.get(principalId)?.files ?? 0) + 1,
			bytes: (this.#inflight.get(principalId)?.bytes ?? 0) + length,
		});
		let kept: RoomFile | undefined;
		try {
			await readMultipart(request.body, boundary, (part) => {
				if (kept || part.name !== "file" || part.filename === undefined)
					return undefined;
				return this.#sink(part, (file) => {
					kept = file;
				});
			});
		} catch (error) {
			// A file part may have finished before the body failed; the form as a whole did not arrive.
			if (kept) this.#waiting.remove(kept.id);
			if (error instanceof MultipartError)
				throw new UploadRefusal(400, "The upload is not a form.");
			throw error;
		} finally {
			const flying = this.#inflight.get(principalId);
			if (flying && flying.files > 1)
				this.#inflight.set(principalId, {
					files: flying.files - 1,
					bytes: flying.bytes - length,
				});
			else this.#inflight.delete(principalId);
		}
		if (!kept) throw new UploadRefusal(400, "There is no file.");
		this.#pending.set(kept.id, {
			principalId,
			at: this.#now(),
			size: kept.size,
		});
		return {
			id: kept.id,
			name: kept.name,
			type: kept.type,
			size: kept.size,
		};
	}

	/** The sink that streams one file part to the waiting directory and decides what it is as it goes. */
	#sink(part: PartHeaders, done: (file: RoomFile) => void): PartSink {
		const sniffer = new Sniffer();
		const name = safeName(part.filename ?? "file");
		let writer: Awaited<ReturnType<FileDir["begin"]>> | undefined;
		const open = async () => {
			writer ??= await this.#waiting.begin();
			return writer;
		};
		return {
			write: async (chunk) => {
				const file = await open();
				if (file.size + chunk.byteLength > this.maxBytes)
					throw new UploadRefusal(413, "The file is too large.");
				sniffer.feed(chunk);
				await file.write(chunk);
			},
			end: async () => {
				const file = await open();
				if (file.size === 0) throw new UploadRefusal(400, "The file is empty.");
				const type = sniffer.verdict(name, part.contentType);
				if (!type)
					throw new UploadRefusal(415, "The file is not what its type says.");
				done(await file.finish(name, type));
			},
			abort: async () => {
				await writer?.abort();
			},
		};
	}

	/** Deletes a waiting upload of the person's own; false when there is none such, or a message already took it. */
	discard(id: string, principalId: string): boolean {
		const waiting = this.#pending.get(id);
		if (!waiting || waiting.principalId !== principalId) return false;
		this.#pending.delete(id);
		this.#waiting.remove(id);
		return true;
	}

	/**
	 * Checks that these are waiting uploads of the person and returns them; undefined when one is
	 * unknown, someone else's, or named twice. Nothing moves yet.
	 */
	claim(ids: readonly string[], principalId: string): RoomFile[] | undefined {
		if (new Set(ids).size !== ids.length) return undefined;
		const files: RoomFile[] = [];
		for (const id of ids) {
			const waiting = this.#pending.get(id);
			const meta = this.#waiting.meta(id);
			if (!waiting || waiting.principalId !== principalId || !meta)
				return undefined;
			files.push(meta);
		}
		return files;
	}

	/** Moves claimed uploads into the stored files, once their message is accepted. */
	use(ids: readonly string[]): void {
		for (const id of ids) {
			this.#pending.delete(id);
			this.#waiting.moveTo(id, this.#stored);
		}
	}

	/** The reference a message carries for a stored upload. */
	refOf(file: RoomFile): AttachmentRef {
		return {
			url: `${REF_PREFIX}${file.id}`,
			name: file.name,
			contentType: file.type,
			size: file.size,
		};
	}

	/**
	 * The file behind a reference this store made, as its path: the host copies it from there, so
	 * a large file is never held in memory. Rejects for any other reference.
	 */
	async read(ref: AttachmentRef): Promise<AttachmentFile> {
		if (!ref.url.startsWith(REF_PREFIX))
			throw new Error("not a file of this app");
		const id = ref.url.slice(REF_PREFIX.length);
		const path = this.#stored.pathOf(id) ?? this.#waiting.pathOf(id);
		if (!path) throw new Error("the file is gone");
		return { path };
	}

	/** Deletes the waiting uploads older than a day and the stored files older than 30 days; returns how many. */
	sweep(): number {
		const now = this.#now();
		let dropped = 0;
		for (const id of this.#waiting.older(UPLOAD_WAIT_MS, now)) {
			this.#waiting.remove(id);
			this.#pending.delete(id);
			dropped += 1;
		}
		for (const id of this.#stored.older(FILE_RETENTION_MS, now)) {
			this.#stored.remove(id);
			dropped += 1;
		}
		return dropped;
	}

	/** Remembers the uploads left on disk by an earlier run, to the principal who made them: none, so they are swept. */
	adopt(): void {
		for (const id of this.#waiting.ids())
			if (!this.#pending.has(id))
				this.#pending.set(id, {
					principalId: "",
					at: this.#now(),
					size: 0,
				});
	}
}
