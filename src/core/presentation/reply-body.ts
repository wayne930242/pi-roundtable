import type { ReplyFile, TurnResult } from "../domain/conversation.ts";
import { failureNotice } from "./failure-notice.ts";
import { splitReply } from "./reply-splitter.ts";
import { thinkingLine } from "./thinking-line.ts";

/** What a turn posts: its answer with a thinking line, or the failure or stopped notice. */
export function replyBody(result: TurnResult): {
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
		chunks: splitReply(result.text),
		...(result.files?.length ? { files: result.files } : {}),
	};
}
