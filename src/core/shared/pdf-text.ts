import { Worker } from "node:worker_threads";
import { MAX_ATTACHMENT_BYTES } from "../attachments/attachment-fetcher.ts";
import type { PdfWorkerAnswer } from "./pdf-text-worker.ts";

/**
 * The bounds of one PDF read. `bytes`: the largest file parsed, as large as the core reads any
 * attachment. `pages` and `chars`: the text stops after this many pages, or once it holds this many
 * characters (UTF-16 units), so every read of the same bytes gives the same text. `ms`: how long a
 * parse may run before its worker is stopped and the read refused.
 */
export const PDF_LIMITS = {
	bytes: MAX_ATTACHMENT_BYTES,
	pages: 2_000,
	chars: 5_000_000,
	ms: 30_000,
} as const;

/** A PDF's text as the worker read it; `cut` when it stopped at a limit before the end. */
export interface PdfText {
	totalPages: number;
	pagesRead: number;
	text: string;
	cut: boolean;
}

/** Why `pdfText` gave no text: pdf.js could not parse the file, or did not finish in time. */
export class PdfTextError extends Error {
	readonly reason: "unreadable" | "slow";
	constructor(reason: "unreadable" | "slow") {
		super(
			reason === "slow" ? "PDF parse timed out" : "PDF could not be parsed",
		);
		this.name = "PdfTextError";
		this.reason = reason;
	}
}

/**
 * A PDF's text, extracted in a worker of its own so the parse never holds the host's event loop,
 * and stopped after `limits.ms`. The worker gets a copy of `bytes`; the caller's array is left as
 * it was.
 */
export function pdfText(
	bytes: Uint8Array,
	limits: { pages: number; chars: number; ms: number } = PDF_LIMITS,
): Promise<PdfText> {
	const copy = bytes.slice();
	const worker = new Worker(new URL("./pdf-text-worker.ts", import.meta.url), {
		workerData: {
			pdfText: { pages: limits.pages, chars: limits.chars },
		},
	});
	return new Promise<PdfText>((resolve, reject) => {
		const timer = setTimeout(
			() => settle(() => reject(new PdfTextError("slow"))),
			limits.ms,
		);
		let done = false;
		const settle = (then: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			void worker.terminate();
			then();
		};
		worker.once("message", (answer: PdfWorkerAnswer) =>
			settle(() =>
				answer.ok
					? resolve({
							totalPages: answer.totalPages,
							pagesRead: answer.pagesRead,
							text: answer.text,
							cut: answer.cut,
						})
					: reject(new PdfTextError("unreadable")),
			),
		);
		worker.once("error", () =>
			settle(() => reject(new PdfTextError("unreadable"))),
		);
		worker.once("exit", () =>
			settle(() => reject(new PdfTextError("unreadable"))),
		);
		worker.postMessage(copy, [copy.buffer]);
	});
}
