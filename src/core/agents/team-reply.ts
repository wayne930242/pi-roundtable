import type { ReplyFile, TurnResult } from "../domain/conversation.ts";
import { failureNotice } from "../presentation/failure-notice.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import { thinkingLine } from "../presentation/thinking-line.ts";

/** What an agent's turn posts: its answer with a thinking line, or the failure or stopped notice. */
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
	return {
		...(result.thinking ? { thinking: thinkingLine(result.thinking) } : {}),
		chunks: splitReply(result.text),
		...(result.files?.length ? { files: result.files } : {}),
	};
}
