import type { BlockSupport } from "../domain/block-support.ts";
import type { ReplyFile, TurnResult } from "../domain/conversation.ts";
import { failureNotice } from "./failure-notice.ts";
import { chunksFor } from "./reply-chunks.ts";
import { thinkingLine } from "./thinking-line.ts";

/**
 * What a turn posts: its answer with a thinking line, or the failure or stopped notice. The
 * answer is cut for `surface`, the one it is posted on (see `chunksFor`); none = as for Discord.
 */
export function replyBody(
	result: TurnResult,
	surface?: BlockSupport,
): {
	thinking?: string;
	chunks: string[];
	files?: ReplyFile[];
	/** Set on the notice for a turn that ended in an error, not on a stopped one. */
	failed?: true;
} {
	if (!result.ok)
		return {
			chunks: [failureNotice(result)],
			...(result.stopped ? {} : { failed: true as const }),
		};
	const thinking = result.thinking ? thinkingLine(result.thinking) : undefined;
	return {
		...(thinking ? { thinking } : {}),
		chunks: chunksFor(surface, result.text),
		...(result.files?.length ? { files: result.files } : {}),
	};
}

/**
 * Whether a turn ended with nothing to post: an unattended turn, such as a schedule's, that had
 * nothing to say. It is no failure and shows no notice.
 */
export function isQuiet(result: TurnResult): boolean {
	return result.ok && !result.text.trim() && !result.files?.length;
}
