import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AttachmentFailure,
	AttachmentRef,
	StoredAttachment,
} from "../domain/attachment.ts";
import { plainText } from "./attachment-name.ts";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** How long one download may go without a byte (the headers count as the first) before it is given up, by default. */
export const DEFAULT_IDLE_MS = 10_000;

export interface FetchRequest {
	refs: readonly AttachmentRef[];
	/** Directory of the channel's attachment store; created when missing. */
	dir: string;
	/** Prefix that keeps files of different messages apart, such as the message ID. */
	prefix: string;
	fromReference: boolean;
	/** Aborts the download of the files still to come, and the one in flight. */
	signal?: AbortSignal;
	/** Gives up on a file that sends no byte for this long, and goes on to the next; default 10 s. */
	idleMs?: number;
}

export interface FetchResult {
	files: StoredAttachment[];
	failures: AttachmentFailure[];
}

/** The most UTF-8 bytes a stored name keeps; a file system takes 255 bytes for the whole file name. */
const MAX_NAME_BYTES = 150;

const utf8Length = (codePoint: number): number =>
	codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

/** The end of `text` that fits `max` UTF-8 bytes, cut on a code point. */
function lastBytes(text: string, max: number): string {
	const points = [...text];
	let bytes = 0;
	let start = points.length;
	while (start > 0) {
		const size = utf8Length(points[start - 1]?.codePointAt(0) ?? 0);
		if (bytes + size > max) break;
		bytes += size;
		start -= 1;
	}
	return points.slice(start).join("");
}

/**
 * Keeps a file name readable while removing path separators and control characters, and keeps the
 * end of a long name (its extension) within 150 UTF-8 bytes so a prefix and a record suffix still
 * fit the 255 bytes a file system takes.
 */
export function safeFileName(name: string): string {
	const cleaned = lastBytes(
		plainText(name.toWellFormed().normalize("NFC").replace(/[/\\]/g, "_")),
		MAX_NAME_BYTES,
	).replace(/^\.+/, "_");
	return cleaned || "file";
}

/**
 * A failure's code, never its message: a message can quote the directory a file was to be written
 * to, a host path the model and the channel have no use for. The code is an error's `code` (such
 * as `ENOTDIR`) or its `name` (such as `TimeoutError`), and `error` when it has neither.
 */
function failureCode(error: unknown): string {
	const word = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
	if (typeof error !== "object" || error === null) return "error";
	const { code, name } = error as { code?: unknown; name?: unknown };
	if (typeof code === "string" && word.test(code)) return code;
	if (typeof name === "string" && name !== "Error" && word.test(name))
		return name;
	return "error";
}

/**
 * Ends a download that has gone quiet: `signal` aborts, with the reason `idle`, once `idleMs` pass
 * without a `touch`, and also when the outer signal does.
 */
class IdleWatch {
	readonly signal: AbortSignal;
	readonly #own = new AbortController();
	readonly #idleMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(idleMs: number, outer?: AbortSignal) {
		this.#idleMs = idleMs;
		this.signal = outer
			? AbortSignal.any([outer, this.#own.signal])
			: this.#own.signal;
		this.touch();
	}

	/** Whether the download was ended for want of bytes, not by the outer signal. */
	get idled(): boolean {
		return this.#own.signal.aborted;
	}

	touch(): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(
			() => this.#own.abort(new Error("idle")),
			this.#idleMs,
		);
	}

	stop(): void {
		clearTimeout(this.#timer);
	}
}

/** Rejects with the signal's reason when it aborts, so a fetch that ignores the signal still ends. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([work, aborted]).finally(() => {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	});
}

/** Downloads attachments one by one; a failed file is reported without stopping the others. */
export async function fetchAttachments(
	request: FetchRequest,
	fetchImpl: typeof fetch = fetch,
): Promise<FetchResult> {
	const files: StoredAttachment[] = [];
	const failures: AttachmentFailure[] = [];
	const { refs, dir, prefix, fromReference, signal } = request;
	const idleMs = request.idleMs ?? DEFAULT_IDLE_MS;
	if (refs.length === 0) return { files, failures };

	for (const [index, ref] of refs.entries()) {
		const fail = (reason: string) =>
			failures.push({ name: ref.name, reason, fromReference });
		if (signal?.aborted) {
			fail("download failed: deadline passed or download aborted");
			continue;
		}
		if (ref.size > MAX_ATTACHMENT_BYTES) {
			fail(`larger than 25 MB (${ref.size} bytes)`);
			continue;
		}
		const watch = new IdleWatch(idleMs, signal);
		try {
			// A directory that cannot be made fails the file, not the turn.
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const response = await untilAborted(
				fetchImpl(ref.url, { signal: watch.signal }),
				watch.signal,
			);
			if (!response.ok) {
				await response.body?.cancel();
				fail(`download failed with HTTP ${response.status}`);
				continue;
			}
			const data = await readAttachmentBody(response, watch);
			if (typeof data === "number") {
				fail(`larger than 25 MB (${data} bytes)`);
				continue;
			}
			const file = `${prefix}-${index}-${safeFileName(ref.name)}`;
			const path = join(dir, file);
			await Bun.write(path, data);
			files.push({
				name: ref.name,
				file,
				path,
				contentType:
					ref.contentType ||
					response.headers.get("content-type") ||
					"application/octet-stream",
				size: data.byteLength,
				fromReference,
			});
		} catch (error) {
			fail(
				`download failed: ${watch.idled && !signal?.aborted ? "idle_timeout" : failureCode(error)}`,
			);
		} finally {
			watch.stop();
		}
	}
	return { files, failures };
}

/** Returns the bytes, or the observed size once the stream exceeds the limit. */
async function readAttachmentBody(
	response: Response,
	watch: IdleWatch,
): Promise<Uint8Array | number> {
	if (!response.body) return new Uint8Array();
	const { signal } = watch;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	// A body that stalls ends with the signal, also when the fetch itself ignores it.
	const stop = () => void reader.cancel(signal.reason).catch(() => {});
	signal.addEventListener("abort", stop, { once: true });
	try {
		if (signal.aborted) throw signal.reason ?? new Error("aborted");
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			watch.touch();
			size += value.byteLength;
			if (size > MAX_ATTACHMENT_BYTES) {
				await reader.cancel();
				return size;
			}
			chunks.push(value);
		}
		// A cancelled reader reads as the end of the body, so a cut-short body is not a whole file.
		if (signal.aborted) throw signal.reason ?? new Error("aborted");
	} finally {
		signal.removeEventListener("abort", stop);
		reader.releaseLock();
	}
	const data = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return data;
}
