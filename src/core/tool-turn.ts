import {
	AttachmentLookupError,
	openAttachment,
} from "./attachments/tool-attachment.ts";
import type { ToolTurn } from "./define.ts";
import { ToolRefusal } from "./define.ts";
import { attachReplyFile } from "./reply-files.ts";
import type { SessionContext } from "./sessions.ts";

/**
 * The turn a tool's `run` and `hold` receive, built from the session that makes the call and the
 * signal that stops it.
 */
export function toolTurn(
	context: SessionContext,
	signal: AbortSignal | undefined,
): ToolTurn {
	const origin = context.origin?.();
	return {
		speaker: context.speaker(),
		channel: context.turnChannel,
		agent: context.agent,
		signal,
		...(origin === undefined ? {} : { origin }),
		...(context.workspace ? { workspace: context.workspace } : {}),
		attachFile: attachReplyFile,
		attachment: async (file) => {
			if (context.attachmentDir === undefined)
				throw new ToolRefusal("this session keeps no attachments");
			try {
				return await openAttachment(context.attachmentDir, file);
			} catch (error) {
				if (error instanceof AttachmentLookupError)
					throw new ToolRefusal(error.message);
				throw error;
			}
		},
	};
}
