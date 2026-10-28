import { afterEach, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDir } from "./files.ts";
import { UploadRefusal, Uploads } from "./uploads.ts";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
	0x44, 0x52,
]);
const MiB = 1024 * 1024;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function store(options: ConstructorParameters<typeof Uploads>[2] = {}): {
	uploads: Uploads;
	waiting: string;
	stored: string;
} {
	const root = mkdtempSync(join(tmpdir(), "uploads-"));
	dirs.push(root);
	const waiting = join(root, "waiting");
	const stored = join(root, "stored");
	return {
		uploads: new Uploads(new FileDir(waiting), new FileDir(stored), options),
		waiting,
		stored,
	};
}

const filesIn = (dir: string): string[] => {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
};

/** The body of a form with one file, as bytes, with the content type that names its boundary. */
async function formBytes(
	name: string,
	data: Uint8Array | string,
	type = "",
): Promise<{ bytes: Uint8Array; contentType: string }> {
	const form = new FormData();
	form.set("file", new File([data], name, { type }));
	const response = new Response(form);
	// Read before the body: Bun forgets the header once the body is consumed.
	const contentType = response.headers.get("content-type") ?? "";
	return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
}

/** An upload request whose body arrives in chunks; `length` is what the header claims. */
function requestOf(
	form: { bytes: Uint8Array; contentType: string },
	options: {
		chunk?: number;
		length?: number;
		gate?: Promise<void>;
		at?: number;
	} = {},
): Request {
	const { bytes } = form;
	const chunk = options.chunk ?? 16 * 1024;
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (options.gate && options.at !== undefined && sent >= options.at)
				await options.gate;
			if (sent >= bytes.byteLength) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(sent, sent + chunk));
			sent += chunk;
		},
	});
	return new Request("http://localhost/console/api/uploads", {
		method: "POST",
		headers: {
			"content-type": form.contentType,
			"content-length": String(options.length ?? bytes.byteLength),
		},
		body,
		duplex: "half",
	} as RequestInit);
}

const upload = async (
	uploads: Uploads,
	name: string,
	data: Uint8Array | string,
	type = "",
	principal = "ada",
) => uploads.receive(requestOf(await formBytes(name, data, type)), principal);

const refusalOf = async (work: Promise<unknown>): Promise<number> => {
	try {
		await work;
	} catch (error) {
		if (error instanceof UploadRefusal) return error.status;
		throw error;
	}
	throw new Error("the upload was accepted");
};

test("a file arrives on disk while its body is still coming, so its size costs no memory", async () => {
	const { uploads, waiting } = store();
	const data = new Uint8Array(3 * MiB).map((_, i) => (i * 31) % 251);
	const form = await formBytes("big.bin", data, "application/octet-stream");
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	// The body stops halfway; by then the first half must be in the file already.
	const done = uploads.receive(
		requestOf(form, { chunk: 64 * 1024, gate, at: form.bytes.byteLength / 2 }),
		"ada",
	);
	const deadline = Date.now() + 3000;
	let written = 0;
	while (Date.now() < deadline && written < MiB) {
		await Bun.sleep(10);
		const [id] = filesIn(waiting).filter((name) => !name.endsWith(".json"));
		written = id ? statSync(join(waiting, id)).size : 0;
	}
	expect(written).toBeGreaterThan(MiB);
	expect(written).toBeLessThan(data.byteLength);
	release();
	const view = await done;
	expect(view).toMatchObject({
		name: "big.bin",
		type: "application/octet-stream",
		size: data.byteLength,
	});
	expect(new Uint8Array(readFileSync(join(waiting, view.id)))).toEqual(data);
});

test("a file over the old 10 MiB limit is accepted, and the limit is the one the store was made with", async () => {
	const { uploads } = store({ maxBytes: 20 * MiB });
	const big = new Uint8Array(12 * MiB).fill(7);
	big[0] = 0;
	expect((await upload(uploads, "twelve.bin", big)).size).toBe(12 * MiB);
	expect(uploads.maxBytes).toBe(20 * MiB);
	expect(store().uploads.maxBytes).toBe(100 * MiB);
});

test("a file over the limit is refused with 413 and leaves nothing on disk, whatever the header claims", async () => {
	const { uploads, waiting } = store({ maxBytes: MiB });
	const data = new Uint8Array(2 * MiB).fill(1);
	data[0] = 0;
	const form = await formBytes("too-big.bin", data);
	// The header tells the truth: refused before the body is read at all.
	let pulled = false;
	const early = new Request("http://localhost/x", {
		method: "POST",
		headers: {
			"content-type": form.contentType,
			"content-length": String(form.bytes.byteLength),
		},
		body: new ReadableStream(
			{
				pull() {
					pulled = true;
				},
			},
			{ highWaterMark: 0 },
		),
		duplex: "half",
	} as RequestInit);
	expect(await refusalOf(uploads.receive(early, "ada"))).toBe(413);
	expect(pulled).toBe(false);
	// The header lies: refused as the bytes pass the limit, and the partial file is removed.
	expect(
		await refusalOf(uploads.receive(requestOf(form, { length: 5000 }), "ada")),
	).toBe(413);
	expect(filesIn(waiting)).toEqual([]);
	// A file at the limit is fine.
	const exact = new Uint8Array(MiB).fill(2);
	exact[0] = 0;
	expect((await upload(uploads, "exact.bin", exact)).size).toBe(MiB);
});

test("any ordinary file is accepted: images by their bytes, text as text, the rest as bytes with its name", async () => {
	const { uploads } = store();
	const cases: [string, Uint8Array | string, string, string][] = [
		// name, data, the type the browser said, the type kept
		["pixel.png", PNG, "image/png", "image/png"],
		["pasted", PNG, "", "image/png"],
		["notes.md", "# Title\n\ntext", "", "text/markdown"],
		["table.csv", "a,b\n1,2\n", "application/vnd.ms-excel", "text/csv"],
		["index.ts", "export const a = 1;\n", "video/mp2t", "text/plain"],
		["中文筆記.txt", "你好，世界\n", "text/plain", "text/plain"],
		["data.json", '{"a":1}', "", "application/json"],
		["Makefile", "all:\n\techo hi\n", "", "text/plain"],
		[
			"archive.zip",
			new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0xff, 0xfe, 0, 1]),
			"application/zip",
			"application/octet-stream",
		],
		[
			"report.docx",
			new Uint8Array([0x50, 0x4b, 3, 4, 0x14, 0, 6, 0, 8, 0xff]),
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"application/octet-stream",
		],
		[
			"paper.pdf",
			new TextEncoder().encode("%PDF-1.7\n").slice(0),
			"application/pdf",
			"text/plain",
		],
		[
			"binary.pdf",
			new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0, 0xff, 0xfe]),
			"application/pdf",
			"application/pdf",
		],
		[
			"latin1.txt",
			new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
			"text/plain",
			"application/octet-stream",
		],
	];
	for (const [name, data, declared, kept] of cases) {
		const view = await upload(uploads, name, data, declared);
		expect([name, view.type]).toEqual([name, kept]);
		expect(view.name).toBe(name);
	}
});

test("a file that says it is an image but is not one is refused, and an empty file is refused", async () => {
	const { uploads, waiting } = store();
	expect(
		await refusalOf(upload(uploads, "x.png", "not a png", "image/png")),
	).toBe(415);
	expect(await refusalOf(upload(uploads, "x.gif", PNG, "image/gif"))).toBe(415);
	expect(await refusalOf(upload(uploads, "empty.txt", "", "text/plain"))).toBe(
		400,
	);
	expect(filesIn(waiting)).toEqual([]);
});

test("a request that is no form, has no length or no file is refused", async () => {
	const { uploads } = store();
	const noLength = new Request("http://localhost/x", {
		method: "POST",
		headers: { "content-type": "multipart/form-data; boundary=b" },
		body: "x",
	});
	expect(await refusalOf(uploads.receive(noLength, "ada"))).toBe(400);
	const notForm = new Request("http://localhost/x", {
		method: "POST",
		headers: { "content-type": "application/json", "content-length": "2" },
		body: "{}",
	});
	expect(await refusalOf(uploads.receive(notForm, "ada"))).toBe(400);
	const field = new FormData();
	field.set("other", "x");
	const response = new Response(field);
	const contentType = response.headers.get("content-type") ?? "";
	const noFile = requestOf({
		bytes: new Uint8Array(await response.arrayBuffer()),
		contentType,
	});
	expect(await refusalOf(uploads.receive(noFile, "ada"))).toBe(400);
});

test("a person's waiting files and bytes are bounded, uploads on their way count, and others are not affected", async () => {
	const { uploads } = store({ pendingBytes: 2 * MiB });
	const chunk = new Uint8Array(MiB - 1024).fill(3);
	chunk[0] = 0;
	await upload(uploads, "one.bin", chunk);
	await upload(uploads, "two.bin", chunk);
	expect(await refusalOf(upload(uploads, "three.bin", chunk))).toBe(429);
	// Someone else has their own allowance.
	await upload(uploads, "bea.bin", chunk, "", "bea");
	// An upload under way holds its place: this one stalls, so the next cannot fit beside it.
	const roomy = store({ pendingBytes: 2 * MiB });
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const slow = await formBytes("slow.bin", chunk);
	const first = roomy.uploads.receive(
		requestOf(slow, { chunk: 4096, gate, at: 8192 }),
		"ada",
	);
	await Bun.sleep(50);
	const big = new Uint8Array(MiB + 4096).fill(4);
	big[0] = 0;
	expect(await refusalOf(upload(roomy.uploads, "big.bin", big))).toBe(429);
	release();
	await first;
});

test("sixteen files may wait for a message, counting uploads on their way", async () => {
	const { uploads } = store();
	for (let i = 0; i < 16; i += 1)
		await upload(uploads, `f${i}.txt`, `file ${i}`, "text/plain");
	expect(await refusalOf(upload(uploads, "f16.txt", "x", "text/plain"))).toBe(
		429,
	);
});

test("an upload a message uses moves to the stored files and is read from there, as text the agent can open", async () => {
	const { uploads, waiting, stored } = store();
	const view = await upload(uploads, "notes.md", "# hello\nworld", "");
	const [file] = uploads.claim([view.id], "ada") ?? [];
	if (!file) throw new Error("the upload was not claimed");
	expect(uploads.claim([view.id], "bea")).toBeUndefined();
	uploads.use([view.id]);
	expect(filesIn(waiting)).toEqual([]);
	expect(filesIn(stored).sort()).toEqual([view.id, `${view.id}.json`].sort());
	const text = new TextDecoder().decode(
		await uploads.read(uploads.refOf(file)),
	);
	expect(text).toBe("# hello\nworld");
});
