import type { AttachmentRef } from "pi-roundtable";
import type { RoomFile, UploadView } from "../api-types.ts";
import { FILE_RETENTION_MS, type FileDir, safeName } from "./files.ts";

/** The most bytes of one uploaded file: 10 MiB. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** How long an upload no message used waits: 24 hours. */
export const UPLOAD_WAIT_MS = 24 * 3_600_000;
/** The most files one person may have waiting for a message. */
const PENDING_PER_PRINCIPAL = 16;

/** The content types an upload may be, exactly. */
export const UPLOAD_TYPES: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"application/json",
	"text/plain",
	"application/pdf",
];

/** The scheme of the references a message carries to its uploads: `app-upload:<id>`. */
const REF_PREFIX = "app-upload:";

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
	signature.every((byte, index) => bytes[at + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** Whether the bytes are what the type says, for the types whose first bytes say so. */
function bytesMatchType(type: string, bytes: Uint8Array): boolean {
	switch (type) {
		case "image/png":
			return startsWith(
				bytes,
				[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
			);
		case "image/jpeg":
			return startsWith(bytes, [0xff, 0xd8, 0xff]);
		case "image/gif":
			return (
				startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))
			);
		case "image/webp":
			return (
				startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)
			);
		case "application/pdf":
			return startsWith(bytes, ascii("%PDF-"));
		case "application/json":
			try {
				JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
				return true;
			} catch {
				return false;
			}
		case "text/plain":
			try {
				new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				return true;
			} catch {
				return false;
			}
		default:
			return false;
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
}

/**
 * The files the owner uploads for a message, kept on disk until a message uses them. A file is
 * its owner's alone: a message may only name uploads of its own sender. When a message takes
 * its uploads they move to the stored files, which keep 30 days, and the agent reads them
 * through the surface as `app-upload:<id>`; an upload no message uses is deleted after a day.
 */
export class Uploads {
	readonly #waiting: FileDir;
	readonly #stored: FileDir;
	readonly #pending = new Map<string, Waiting>();
	readonly #now: () => number;

	constructor(waiting: FileDir, stored: FileDir, now: () => number = Date.now) {
		this.#waiting = waiting;
		this.#stored = stored;
		this.#now = now;
	}

	/** Takes one file from a multipart body (field `file`); throws `UploadRefusal` when it is not accepted. */
	async receive(request: Request, principalId: string): Promise<UploadView> {
		const mine = [...this.#pending.values()].filter(
			(w) => w.principalId === principalId,
		).length;
		if (mine >= PENDING_PER_PRINCIPAL)
			throw new UploadRefusal(429, "Too many files are waiting for a message.");
		const length = Number(request.headers.get("content-length"));
		if (!Number.isFinite(length) || length <= 0)
			throw new UploadRefusal(400, "The upload has no length.");
		if (length > UPLOAD_MAX_BYTES + 64 * 1024)
			throw new UploadRefusal(413, "The file is too large.");
		const form = await request.formData().catch(() => undefined);
		if (!form) throw new UploadRefusal(400, "The upload is not a form.");
		const file = form.get("file");
		if (!(file instanceof File))
			throw new UploadRefusal(400, "There is no file.");
		if (file.size > UPLOAD_MAX_BYTES)
			throw new UploadRefusal(413, "The file is too large.");
		const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
		if (!UPLOAD_TYPES.includes(type))
			throw new UploadRefusal(415, "This kind of file is not accepted.");
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.byteLength === 0 || !bytesMatchType(type, bytes))
			throw new UploadRefusal(415, "The file is not what its type says.");
		const stored = this.#waiting.put(safeName(file.name), type, bytes);
		this.#pending.set(stored.id, { principalId, at: this.#now() });
		return {
			id: stored.id,
			name: stored.name,
			type: stored.type,
			size: stored.size,
		};
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

	/** The bytes of a reference this store made; rejects for any other reference. */
	async read(ref: AttachmentRef): Promise<Uint8Array> {
		if (!ref.url.startsWith(REF_PREFIX))
			throw new Error("not a file of this app");
		const id = ref.url.slice(REF_PREFIX.length);
		const bytes = this.#stored.bytes(id) ?? this.#waiting.bytes(id);
		if (!bytes) throw new Error("the file is gone");
		return bytes;
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
				this.#pending.set(id, { principalId: "", at: this.#now() });
	}
}
