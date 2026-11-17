import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

/**
 * Extracts a PDF's text off the host's thread (see `pdf-text.ts`): pdf.js parses in the thread that
 * calls it, so a large or crafted file would hold every channel's event loop. It reads pages in
 * order and stops after `pages` pages or once it holds `chars` characters, so the host is given a
 * bounded text, the same for every read of the same bytes. Loaded outside a worker, which is what
 * importing every module of the core does, it does nothing.
 */
const limits = (
	workerData as { pdfText?: { pages: number; chars: number } } | null
)?.pdfText;

/** What the worker answers: the text it read, or that pdf.js could not parse the file. */
export type PdfWorkerAnswer =
	| {
			ok: true;
			totalPages: number;
			pagesRead: number;
			text: string;
			cut: boolean;
	  }
	| { ok: false };

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

async function extract(
	bytes: Uint8Array,
	max: { pages: number; chars: number },
): Promise<PdfWorkerAnswer> {
	const pdf = await getDocumentProxy(bytes);
	try {
		const texts: string[] = [];
		let chars = 0;
		let pagesRead = 0;
		while (pagesRead < Math.min(pdf.numPages, max.pages) && chars < max.chars) {
			const page = await pdf.getPage(pagesRead + 1);
			const content = await page.getTextContent();
			const text = content.items
				.map((item) =>
					"str" in item && item.str != null
						? item.str + (item.hasEOL ? "\n" : "")
						: "",
				)
				.join("");
			texts.push(text);
			chars += text.length;
			pagesRead += 1;
		}
		// As unpdf's `mergePages` joins pages: whitespace collapsed, line breaks kept, one blank line at most.
		const merged = texts
			.join("\n")
			.replace(/[^\S\n]+/g, " ")
			.replace(/ ?\n ?/g, "\n")
			.replace(/\n{3,}/g, "\n\n");
		let end = Math.min(merged.length, max.chars);
		// A cut never ends between the halves of a surrogate pair.
		if (end < merged.length && isHighSurrogate(merged.charCodeAt(end - 1)))
			end -= 1;
		return {
			ok: true,
			totalPages: pdf.numPages,
			pagesRead,
			text: merged.slice(0, end),
			cut: pagesRead < pdf.numPages || end < merged.length,
		};
	} finally {
		await pdf.loadingTask.destroy();
	}
}

if (limits && parentPort) {
	const port = parentPort;
	port.on("message", (bytes: Uint8Array) => {
		extract(bytes, limits).then(
			(answer) => port.postMessage(answer),
			() => port.postMessage({ ok: false } satisfies PdfWorkerAnswer),
		);
	});
}
