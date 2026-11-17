import { describe, expect, test } from "bun:test";
import {
	ATTACHMENT_TEXT_LIMIT,
	AttachmentTextError,
	readAttachmentText,
} from "./attachment-text.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A one-page PDF that says `words`; pdf.js rebuilds the cross-reference table it lacks. */
function pdf(words: string): Uint8Array {
	const stream = `BT /F1 12 Tf 72 720 Td (${words}) Tj ET`;
	return bytes(
		[
			"%PDF-1.4",
			"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
			"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
			"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
			`4 0 obj << /Length ${stream.length} >> stream`,
			stream,
			"endstream endobj",
			"5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
			"trailer << /Root 1 0 R >>",
			"%%EOF",
		].join("\n"),
	);
}

async function code(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "resolved";
	} catch (error) {
		if (error instanceof AttachmentTextError) return error.code;
		throw error;
	}
}

describe("readAttachmentText", () => {
	test("reads text in pieces of 60,000 characters, saying where the next starts", async () => {
		const file = bytes("x".repeat(70_000));
		const first = await readAttachmentText({ name: "a.txt", bytes: file });
		expect(ATTACHMENT_TEXT_LIMIT).toBe(60_000);
		expect(first).toMatchObject({
			kind: "text",
			offset: 0,
			nextOffset: 60_000,
			total: 70_000,
		});
		expect(first.text).toHaveLength(60_000);
		const last = await readAttachmentText({
			name: "a.txt",
			bytes: file,
			offset: 60_000,
		});
		expect(last.text).toHaveLength(10_000);
		expect(last.nextOffset).toBeUndefined();
		const small = await readAttachmentText({
			name: "a.txt",
			bytes: bytes("hello"),
			offset: 1,
			limit: 2,
		});
		expect(small).toEqual({
			kind: "text",
			text: "el",
			offset: 1,
			nextOffset: 3,
			total: 5,
		});
	});

	test("takes text by its media type or its bytes when the name says nothing", async () => {
		for (const [name, contentType] of [
			["notes", "text/plain; charset=utf-8"],
			["data", "application/json"],
			["blob", null],
		] as const)
			expect(
				(await readAttachmentText({ name, contentType, bytes: bytes("{}") }))
					.text,
			).toBe("{}");
	});

	test("extracts a PDF's text, by its name, its media type or its first bytes", async () => {
		for (const [name, contentType] of [
			["r.pdf", undefined],
			["r", "application/pdf"],
			["r.bin", undefined],
		] as const) {
			const read = await readAttachmentText({
				name,
				contentType,
				bytes: pdf("Hello roundtable"),
			});
			expect(read.kind).toBe("pdf");
			expect(read.pages).toBe(1);
			expect(read.text).toStartWith("[PDF, 1 pages]\n");
			expect(read.text).toContain("Hello roundtable");
		}
	});

	test("refuses a binary as unsupported and a broken PDF as unreadable, naming only the file", async () => {
		const binary = readAttachmentText({
			name: "song.mp3",
			contentType: "audio/mpeg",
			bytes: new Uint8Array([0, 1, 2, 255]),
		});
		expect(await code(binary)).toBe("unsupported");
		await expect(binary).rejects.toThrow(
			'"song.mp3" is not a text or PDF file',
		);
		expect(
			await code(
				readAttachmentText({ name: "x.pdf", bytes: bytes("%PDF-garbage") }),
			),
		).toBe("unreadable");
	});

	test("refuses an offset or limit that is not a whole number", async () => {
		for (const [offset, limit] of [
			[-1, undefined],
			[1.5, undefined],
			[Number.NaN, undefined],
			[0, 0],
			[0, 2.5],
		] as const)
			expect(
				await code(
					readAttachmentText({
						name: "a.txt",
						bytes: bytes("hello"),
						offset,
						...(limit === undefined ? {} : { limit }),
					}),
				),
			).toBe("invalid");
	});
});
