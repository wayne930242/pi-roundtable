/** A body that is not the multipart form it says it is. */
export class MultipartError extends Error {
	override name = "MultipartError";
}

/** What a part of the form says about itself. */
export interface PartHeaders {
	/** The form field's name. */
	name: string;
	/** The file's name, for a file part. */
	filename: string | undefined;
	/** The part's content type, lower-cased, without parameters. */
	contentType: string;
}

/** Takes the part's bytes as they arrive; `end` runs once its last byte did, `abort` when the body ended early or failed. */
export interface PartSink {
	write(chunk: Uint8Array): void | Promise<void>;
	end(): void | Promise<void>;
	abort(): void | Promise<void>;
}

/** The longest a part's header block may be. */
const MAX_HEADER_BYTES = 16 * 1024;
/** The most bytes of text before the first boundary that are skipped; a form has none. */
const MAX_PREAMBLE_BYTES = 8 * 1024;

const encoder = new TextEncoder();

/** The boundary a `multipart/form-data` content type names; undefined when it names none. */
export function boundaryOf(contentType: string | null): string | undefined {
	if (!contentType) return undefined;
	const match =
		/^multipart\/form-data\s*;(?:.*;)?\s*boundary=(?:"([^"]{1,200})"|([^\s;"]{1,200}))/i.exec(
			contentType,
		);
	return match?.[1] ?? match?.[2];
}

function headersOf(block: string): PartHeaders {
	const map = new Map<string, string>();
	for (const line of block.split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon > 0)
			map.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1));
	}
	const disposition = map.get("content-disposition") ?? "";
	const param = (key: string) => {
		const match = new RegExp(`;\\s*${key}="((?:[^"\\\\]|\\\\.)*)"`, "i").exec(
			disposition,
		);
		return match?.[1]
			?.replaceAll("%22", '"')
			.replaceAll("%0D", "\r")
			.replaceAll("%0A", "\n")
			.replace(/\\(.)/g, "$1");
	};
	return {
		name: param("name") ?? "",
		filename: param("filename"),
		contentType:
			map.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "",
	};
}

const find = (haystack: Uint8Array, needle: Uint8Array, from = 0): number =>
	Buffer.from(
		haystack.buffer,
		haystack.byteOffset,
		haystack.byteLength,
	).indexOf(needle, from);

const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
	if (a.byteLength === 0) return b;
	const both = new Uint8Array(a.byteLength + b.byteLength);
	both.set(a, 0);
	both.set(b, a.byteLength);
	return both;
};

/**
 * Reads a `multipart/form-data` body as a stream, handing each part's bytes to the sink that
 * `onPart` returns, so no part is ever held whole: memory stays at a chunk and a boundary's
 * length. A part `onPart` gives no sink for is read past and dropped. Throws `MultipartError`
 * for a body that is not well formed, and whatever a sink or `onPart` throws; the part being
 * written is aborted first.
 */
export async function readMultipart(
	body: ReadableStream<Uint8Array>,
	boundary: string,
	onPart: (
		headers: PartHeaders,
	) => PartSink | undefined | Promise<PartSink | undefined>,
): Promise<void> {
	const delimiter = encoder.encode(`\r\n--${boundary}`);
	const headerEnd = encoder.encode("\r\n\r\n");
	// The first boundary is not preceded by a line break; pretending one came keeps one search for all.
	let buffer: Uint8Array = encoder.encode("\r\n");
	let state: "preamble" | "after-delimiter" | "headers" | "body" | "done" =
		"preamble";
	let sink: PartSink | undefined;
	let dropped = false;
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (value) buffer = join(buffer, value);
			// Everything the buffer can settle is settled before the next chunk is read.
			for (let progressed = true; progressed && state !== "done"; ) {
				progressed = false;
				if (state === "preamble") {
					const at = find(buffer, delimiter);
					if (at >= 0) {
						buffer = buffer.subarray(at + delimiter.byteLength);
						state = "after-delimiter";
						progressed = true;
					} else if (buffer.byteLength > MAX_PREAMBLE_BYTES) {
						buffer = buffer.subarray(buffer.byteLength - delimiter.byteLength);
					}
				} else if (state === "after-delimiter") {
					if (buffer.byteLength >= 2) {
						const head = String.fromCharCode(buffer[0] ?? 0, buffer[1] ?? 0);
						if (head === "--") {
							state = "done";
						} else if (head === "\r\n") {
							buffer = buffer.subarray(2);
							state = "headers";
							progressed = true;
						} else throw new MultipartError("A boundary is not well formed.");
					}
				} else if (state === "headers") {
					const at = find(buffer, headerEnd);
					if (at >= 0) {
						const block = new TextDecoder().decode(buffer.subarray(0, at));
						buffer = buffer.subarray(at + headerEnd.byteLength);
						sink = await onPart(headersOf(block));
						dropped = sink === undefined;
						state = "body";
						progressed = true;
					} else if (buffer.byteLength > MAX_HEADER_BYTES)
						throw new MultipartError("A part's headers are too long.");
				} else if (state === "body") {
					const at = find(buffer, delimiter);
					if (at >= 0) {
						if (!dropped && at > 0) await sink?.write(buffer.subarray(0, at));
						await sink?.end();
						sink = undefined;
						buffer = buffer.subarray(at + delimiter.byteLength);
						state = "after-delimiter";
						progressed = true;
					} else {
						// Hold back what could be the start of the delimiter.
						const safe = buffer.byteLength - (delimiter.byteLength - 1);
						if (safe > 0) {
							if (!dropped) await sink?.write(buffer.subarray(0, safe));
							buffer = buffer.subarray(safe);
						}
					}
				}
			}
			if (done) break;
		}
		if (state !== "done") throw new MultipartError("The form is cut short.");
	} catch (error) {
		await sink?.abort();
		throw error;
	} finally {
		reader.releaseLock();
	}
}
