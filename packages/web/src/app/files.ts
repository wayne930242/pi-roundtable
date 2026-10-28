import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import type { RoomFile } from "../api-types.ts";

/** A stored file's id: the uuid the store made. */
const FILE_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The image types shown in the page itself; every other file is a download. */
const INLINE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);

/** How long a reply's or a sent message's file stays: 30 days. */
export const FILE_RETENTION_MS = 30 * 24 * 3_600_000;

/** The types a file name suggests, for files an agent's turn made. */
const BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".json": "application/json",
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".pdf": "application/pdf",
	".html": "text/html",
	".svg": "image/svg+xml",
};

/** The type a file name suggests; unknown names are plain bytes. */
export const typeByName = (name: string): string =>
	BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream";

/** A file name safe to keep and to show: no path, no control characters, at most 120 characters. */
export function safeName(name: string): string {
	const cleaned = Array.from(basename(name.replaceAll("\\", "/")))
		.filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code > 0x1f && code !== 0x7f;
		})
		.join("")
		.trim();
	const cut = Array.from(cleaned).slice(0, 120).join("");
	return cut === "" || cut === "." || cut === ".." ? "file" : cut;
}

export const isFileId = (id: string): boolean => FILE_ID.test(id);

interface Meta {
	name: string;
	type: string;
	size: number;
}

/**
 * A directory of files kept by id, each with a small record of its name and type beside it.
 * Both stores of the app, the files of replies and sent messages and the uploads waiting for a
 * message, are one of these.
 */
export class FileDir {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	#path(id: string): string {
		return join(this.dir, id);
	}

	/** Keeps the bytes under a new id. */
	put(
		name: string,
		type: string,
		bytes: Uint8Array,
		id = crypto.randomUUID(),
	): RoomFile {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const meta: Meta = { name: safeName(name), type, size: bytes.byteLength };
		writeFileSync(this.#path(id), bytes, { mode: 0o600 });
		writeFileSync(`${this.#path(id)}.json`, JSON.stringify(meta), {
			mode: 0o600,
		});
		return { id, ...meta };
	}

	meta(id: string): RoomFile | undefined {
		if (!isFileId(id)) return undefined;
		try {
			const meta = JSON.parse(
				readFileSync(`${this.#path(id)}.json`, "utf8"),
			) as Meta;
			return { id, name: meta.name, type: meta.type, size: meta.size };
		} catch {
			return undefined;
		}
	}

	bytes(id: string): Uint8Array | undefined {
		if (!isFileId(id) || !existsSync(this.#path(id))) return undefined;
		try {
			return readFileSync(this.#path(id));
		} catch {
			return undefined;
		}
	}

	/** Moves a file, with its record, into another directory under the same id. */
	moveTo(id: string, other: FileDir): boolean {
		if (!isFileId(id) || !existsSync(this.#path(id))) return false;
		mkdirSync(other.dir, { recursive: true, mode: 0o700 });
		renameSync(this.#path(id), other.#path(id));
		renameSync(`${this.#path(id)}.json`, `${other.#path(id)}.json`);
		return true;
	}

	remove(id: string): void {
		if (!isFileId(id)) return;
		rmSync(this.#path(id), { force: true });
		rmSync(`${this.#path(id)}.json`, { force: true });
	}

	/** Ids of the files older than `maxAgeMs`, by their modification time. */
	older(maxAgeMs: number, now: number): string[] {
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch {
			return [];
		}
		return names
			.filter((name) => isFileId(name))
			.filter((name) => {
				try {
					return now - statSync(this.#path(name)).mtimeMs > maxAgeMs;
				} catch {
					return false;
				}
			});
	}

	/** Every file's id. */
	ids(): string[] {
		try {
			return readdirSync(this.dir).filter((name) => isFileId(name));
		} catch {
			return [];
		}
	}
}

/**
 * The response for a stored file: a download, except for the four image types the page shows,
 * never interpreted as a page (`sandbox`, `nosniff`).
 */
export function fileResponse(meta: RoomFile, bytes: Uint8Array): Response {
	const inline = INLINE_TYPES.has(meta.type);
	const encoded = encodeURIComponent(meta.name);
	return new Response(new Uint8Array(bytes), {
		headers: {
			"content-type": inline ? meta.type : "application/octet-stream",
			"content-disposition": inline
				? "inline"
				: `attachment; filename*=UTF-8''${encoded}`,
			"content-security-policy": "sandbox",
			"x-content-type-options": "nosniff",
			"cache-control": "private, max-age=3600",
			"content-length": String(bytes.byteLength),
		},
	});
}
