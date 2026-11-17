import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { AttachmentTextError, readAttachmentText } from "./attachment-text.ts";
import { PDF_LIMITS, PdfTextError, pdfText } from "./pdf-text.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A PDF of one page per entry of `pages`, each saying its words. */
function pdf(pages: string[]): Uint8Array {
	const objects = [
		"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
		`2 0 obj << /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >> endobj`,
		"3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
		...pages.flatMap((words, i) => {
			const stream = `BT /F1 12 Tf 72 720 Td (${words}) Tj ET`;
			return [
				`${4 + 2 * i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >> endobj`,
				`${5 + 2 * i} 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
			];
		}),
	];
	return bytes(
		["%PDF-1.4", ...objects, "trailer << /Root 1 0 R >>", "%%EOF"].join("\n"),
	);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("resolved");
}

describe("a PDF's text, read in a worker", () => {
	test("reads every page while under the limits", async () => {
		const read = await pdfText(pdf(["one", "two", "three"]));
		expect(read).toMatchObject({ totalPages: 3, pagesRead: 3, cut: false });
		expect(read.text.split("\n")).toEqual(["one", "two", "three"]);
	});

	test("stops after its page limit, or once it holds its characters, and says so", async () => {
		const file = pdf(["one", "two", "three"]);
		expect(await pdfText(file, { ...PDF_LIMITS, pages: 2 })).toMatchObject({
			pagesRead: 2,
			cut: true,
			text: "one\ntwo",
		});
		expect(await pdfText(file, { ...PDF_LIMITS, chars: 2 })).toMatchObject({
			pagesRead: 1,
			cut: true,
			text: "on",
		});
	});

	test("refuses a parse that outlasts its time, and a file pdf.js cannot parse", async () => {
		const slow = await rejection(
			pdfText(pdf(["late"]), { ...PDF_LIMITS, ms: 1 }),
		);
		expect(slow).toBeInstanceOf(PdfTextError);
		expect((slow as PdfTextError).reason).toBe("slow");
		const broken = await rejection(pdfText(bytes("%PDF-garbage")));
		expect((broken as PdfTextError).reason).toBe("unreadable");
	});

	test("keeps the host's event loop running while it parses (pdf.js in the host's thread runs no timer)", async () => {
		// A 50 KiB file whose content stream inflates to 50 MiB: parsed in the host's thread it held
		// the loop for the whole parse, so not one timer ran.
		const content = deflateSync(
			Buffer.from(`BT /F1 12 Tf 72 720 Td (x) Tj ET\n${" ".repeat(50 << 20)}`),
		);
		const file = new Uint8Array(
			Buffer.concat([
				Buffer.from(
					[
						"%PDF-1.4",
						"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
						"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
						"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
						`4 0 obj << /Length ${content.length} /Filter /FlateDecode >> stream\n`,
					].join("\n"),
				),
				content,
				Buffer.from(
					"\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF",
				),
			]),
		);
		let ticks = 0;
		const timer = setInterval(() => ticks++, 5);
		const read = await pdfText(file);
		clearInterval(timer);
		expect(read.text).toBe("x");
		expect(ticks).toBeGreaterThan(0);
	});
});

describe("readAttachmentText's limits", () => {
	test("refuses a PDF over 25 MiB as tooLarge before parsing it", async () => {
		const big = new Uint8Array(PDF_LIMITS.bytes + 1);
		big.set(bytes("%PDF-"));
		const error = await rejection(
			readAttachmentText({ name: "big.pdf", bytes: big }),
		);
		expect(error).toBeInstanceOf(AttachmentTextError);
		expect((error as AttachmentTextError).code).toBe("tooLarge");
		expect((error as Error).message).toStartWith('"big.pdf" is too large');
	});

	test("never ends a piece between the halves of a surrogate pair", async () => {
		const file = bytes("a😀b");
		const first = await readAttachmentText({
			name: "t.txt",
			bytes: file,
			limit: 2,
		});
		expect(first).toMatchObject({ text: "a", nextOffset: 1, total: 4 });
		const second = await readAttachmentText({
			name: "t.txt",
			bytes: file,
			offset: 1,
			limit: 2,
		});
		expect(second).toMatchObject({ text: "😀", nextOffset: 3 });
		// A limit of 1 at a pair takes the whole pair rather than give an empty piece.
		const one = await readAttachmentText({
			name: "t.txt",
			bytes: file,
			offset: 1,
			limit: 1,
		});
		expect(one).toMatchObject({ text: "😀", nextOffset: 3 });
		const last = await readAttachmentText({
			name: "t.txt",
			bytes: file,
			offset: 3,
			limit: 1,
		});
		expect(last).toEqual({ kind: "text", text: "b", offset: 3, total: 4 });
	});
});
