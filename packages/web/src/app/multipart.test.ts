import { expect, test } from "bun:test";
import {
	boundaryOf,
	MultipartError,
	type PartHeaders,
	readMultipart,
} from "./multipart.ts";

const encoder = new TextEncoder();

/** A form as bytes and the content type that names its boundary, built by the platform's own encoder. */
async function formOf(
	entries: [string, string | File][],
): Promise<{ bytes: Uint8Array; boundary: string }> {
	const form = new FormData();
	for (const [name, value] of entries) form.set(name, value);
	const response = new Response(form);
	const boundary = boundaryOf(response.headers.get("content-type"));
	if (!boundary) throw new Error("the platform named no boundary");
	return { bytes: new Uint8Array(await response.arrayBuffer()), boundary };
}

const streamOf = (bytes: Uint8Array, chunk: number) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (let at = 0; at < bytes.byteLength; at += chunk)
				controller.enqueue(bytes.slice(at, at + chunk));
			controller.close();
		},
	});

interface Seen {
	headers: PartHeaders;
	data: Uint8Array;
	ended: boolean;
	aborted: boolean;
}

async function parse(
	bytes: Uint8Array,
	boundary: string,
	chunk: number,
	keep: (headers: PartHeaders) => boolean = () => true,
): Promise<Seen[]> {
	const seen: Seen[] = [];
	await readMultipart(streamOf(bytes, chunk), boundary, (headers) => {
		if (!keep(headers)) return undefined;
		const part: Seen = {
			headers,
			data: new Uint8Array(0),
			ended: false,
			aborted: false,
		};
		seen.push(part);
		return {
			write: (piece) => {
				const joined = new Uint8Array(part.data.byteLength + piece.byteLength);
				joined.set(part.data, 0);
				joined.set(piece, part.data.byteLength);
				part.data = joined;
			},
			end: () => {
				part.ended = true;
			},
			abort: () => {
				part.aborted = true;
			},
		};
	});
	return seen;
}

test("the boundary is read from the content type, quoted or not", () => {
	expect(boundaryOf("multipart/form-data; boundary=abc123")).toBe("abc123");
	expect(boundaryOf('multipart/form-data; boundary="a b-c"')).toBe("a b-c");
	expect(boundaryOf("multipart/form-data; charset=x; boundary=zz")).toBe("zz");
	expect(boundaryOf("application/json")).toBeUndefined();
	expect(boundaryOf(null)).toBeUndefined();
});

test("a file and a field arrive whole, however the body is cut into chunks, even a byte at a time", async () => {
	const payload = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
	const { bytes, boundary } = await formOf([
		["note", "hello"],
		["file", new File([payload], "data.bin", { type: "application/zip" })],
	]);
	for (const chunk of [1, 2, 3, 7, 64, 1000, bytes.byteLength]) {
		const seen = await parse(bytes, boundary, chunk);
		expect(seen.map((p) => p.headers.name)).toEqual(["note", "file"]);
		expect(new TextDecoder().decode(seen[0]?.data)).toBe("hello");
		expect(seen[1]?.headers).toEqual({
			name: "file",
			filename: "data.bin",
			contentType: "application/zip",
		});
		expect(seen[1]?.data).toEqual(payload);
		expect(seen.every((p) => p.ended && !p.aborted)).toBe(true);
	}
});

test("a body that contains the boundary's start inside the file is not cut there", async () => {
	const tricky = encoder.encode("line\r\n--not-the-boundary\r\n--\r\nend");
	const { bytes, boundary } = await formOf([
		["file", new File([tricky], "t.txt", { type: "text/plain" })],
	]);
	const seen = await parse(bytes, boundary, 5);
	expect(seen[0]?.data).toEqual(tricky);
});

test("file names keep their characters, quotes and non-ASCII included", async () => {
	const { bytes, boundary } = await formOf([
		["file", new File(["x"], 'quote"d 檔案.txt', { type: "text/plain" })],
	]);
	const [part] = await parse(bytes, boundary, 16);
	expect(part?.headers.filename).toBe('quote"d 檔案.txt');
});

test("a part nobody takes is read past and dropped", async () => {
	const { bytes, boundary } = await formOf([
		["skip", "x".repeat(300)],
		["file", new File(["keep"], "k.txt")],
	]);
	const seen = await parse(bytes, boundary, 9, (h) => h.name === "file");
	expect(seen).toHaveLength(1);
	expect(new TextDecoder().decode(seen[0]?.data)).toBe("keep");
});

test("a body cut short aborts the part being written and says so", async () => {
	const { bytes, boundary } = await formOf([
		["file", new File(["abcdefghij".repeat(100)], "a.txt")],
	]);
	const cut = bytes.slice(0, 600);
	let aborted = false;
	await expect(
		readMultipart(streamOf(cut, 50), boundary, () => ({
			write: () => undefined,
			end: () => undefined,
			abort: () => {
				aborted = true;
			},
		})),
	).rejects.toBeInstanceOf(MultipartError);
	expect(aborted).toBe(true);
});

test("what is not a form is refused, and a sink that throws aborts its part and passes the error on", async () => {
	await expect(
		readMultipart(streamOf(encoder.encode("just text"), 4), "b", () => {
			throw new Error("never asked");
		}),
	).rejects.toBeInstanceOf(MultipartError);
	const { bytes, boundary } = await formOf([["file", new File(["zz"], "z")]]);
	let aborted = false;
	await expect(
		readMultipart(streamOf(bytes, 8), boundary, () => ({
			write: () => {
				throw new RangeError("too big");
			},
			end: () => undefined,
			abort: () => {
				aborted = true;
			},
		})),
	).rejects.toBeInstanceOf(RangeError);
	expect(aborted).toBe(true);
	const huge = encoder.encode(
		`--b\r\ncontent-disposition: form-data; name="x"\r\nx: ${"y".repeat(20_000)}\r\n\r\nbody\r\n--b--`,
	);
	await expect(
		readMultipart(streamOf(huge, 1000), "b", () => undefined),
	).rejects.toBeInstanceOf(MultipartError);
});
