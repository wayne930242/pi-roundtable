import { AsyncLocalStorage } from "node:async_hooks";
import type { ReplyFile, TurnResult } from "./domain/conversation.ts";

/** Limits across all tools in one turn, independent of the surface's own limits. */
export const REPLY_FILE_LIMITS = Object.freeze({
	maxFiles: 10,
	maxFileBytes: 10 * 1024 * 1024,
	maxTotalBytes: 50 * 1024 * 1024,
});

/** An attachment was refused; its message names the reason instead of dropping the file. */
export class ReplyFileError extends Error {
	override name = "ReplyFileError";
}

interface ReplyFiles {
	active: boolean;
	supported: boolean;
	files: ReplyFile[];
	bytes: number;
}

const current = new AsyncLocalStorage<ReplyFiles | undefined>();

/**
 * Queues a copy of a file for the current turn's successful reply. Session tools and Pi package
 * tools may call this directly; outside a supported running turn it throws ReplyFileError.
 */
export function attachReplyFile(file: ReplyFile): void {
	const turn = current.getStore();
	if (!turn?.active)
		throw new ReplyFileError(
			"attachReplyFile requires a running conversation turn; await it inside the turn's tool call.",
		);
	if (!turn.supported)
		throw new ReplyFileError(
			"this turn's chat surface does not support reply files.",
		);
	if (
		!file ||
		typeof file.name !== "string" ||
		!file.name.trim() ||
		file.name.length > 255 ||
		/[\\/]/.test(file.name) ||
		[...file.name].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		) ||
		file.name === "." ||
		file.name === ".."
	)
		throw new ReplyFileError(
			"a reply file needs a non-empty filename of at most 255 characters, without paths or control characters.",
		);
	if (!(file.data instanceof Uint8Array) || file.data.byteLength === 0)
		throw new ReplyFileError("a reply file needs non-empty Uint8Array data.");
	if (turn.files.length >= REPLY_FILE_LIMITS.maxFiles)
		throw new ReplyFileError(
			`a turn may attach at most ${REPLY_FILE_LIMITS.maxFiles} reply files.`,
		);
	if (file.data.byteLength > REPLY_FILE_LIMITS.maxFileBytes)
		throw new ReplyFileError(
			`a reply file may contain at most ${REPLY_FILE_LIMITS.maxFileBytes} bytes.`,
		);
	if (turn.bytes + file.data.byteLength > REPLY_FILE_LIMITS.maxTotalBytes)
		throw new ReplyFileError(
			`a turn's reply files may contain at most ${REPLY_FILE_LIMITS.maxTotalBytes} bytes in total.`,
		);
	turn.files.push({ name: file.name, data: new Uint8Array(file.data) });
	turn.bytes += file.data.byteLength;
}

/** Used by test fixtures to forward attachments only when called inside a turn. */
export function hasReplyFileScope(): boolean {
	return current.getStore()?.active === true;
}

/** Whether an otherwise empty final answer has files to show. */
export function hasReplyFiles(): boolean {
	const turn = current.getStore();
	return turn?.active === true && turn.files.length > 0;
}

/** One isolated collector per turn, also when turns run concurrently or nest. */
export async function withReplyFiles(
	supported: boolean,
	run: () => Promise<TurnResult>,
): Promise<TurnResult> {
	const turn: ReplyFiles = { active: true, supported, files: [], bytes: 0 };
	return current.run(turn, async () => {
		try {
			const result = await run();
			if (!result.ok) return result;
			// A replacement runtime may produce files in its result rather than calling the helper.
			for (const file of result.files ?? []) attachReplyFile(file);
			return turn.files.length ? { ...result, files: [...turn.files] } : result;
		} finally {
			turn.active = false;
			turn.files = [];
			turn.bytes = 0;
		}
	});
}

/** A transient task reports text, not a conversation reply: it cannot borrow its parent's collector. */
export function withoutReplyFiles<T>(run: () => Promise<T>): Promise<T> {
	return current.run(undefined, run);
}
