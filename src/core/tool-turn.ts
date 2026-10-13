import {
	AttachmentLookupError,
	listAttachments,
	openAttachment,
} from "./attachments/tool-attachment.ts";
import type { ToolTurn } from "./define.ts";
import { ToolRefusal } from "./define.ts";
import type { ClientPort } from "./domain/client.ts";
import { attachReplyFile } from "./reply-files.ts";
import type { SessionContext } from "./sessions.ts";

/**
 * `port` as a tool sees it in a turn: every call carries the turn's `signal` beside the caller's,
 * so stopping the turn cancels the call in flight.
 */
function clientIn(port: ClientPort, turn: AbortSignal | undefined): ClientPort {
	return {
		names: port.names,
		call: (name, args, options) => {
			const signals = [options?.signal, turn].filter(
				(signal): signal is AbortSignal => signal !== undefined,
			);
			const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
			return port.call(name, args, {
				...options,
				...(signal ? { signal } : {}),
			});
		},
	};
}

/**
 * The turn a tool's `run` and `hold` receive, built from the session that makes the call and the
 * signal that stops it. For a call being run, `toolCallId` finds who approved it.
 */
export function toolTurn(
	context: SessionContext,
	signal: AbortSignal | undefined,
	toolCallId?: string,
): ToolTurn {
	const origin = context.origin?.();
	const approvedBy =
		toolCallId === undefined ? undefined : context.approvedBy?.(toolCallId);
	const client = context.client?.();
	return {
		speaker: context.speaker(),
		channel: context.turnChannel,
		agent: context.agent,
		signal,
		...(origin === undefined ? {} : { origin }),
		...(approvedBy === undefined ? {} : { approvedBy }),
		...(client === undefined ? {} : { client: clientIn(client, signal) }),
		...(context.workspace ? { workspace: context.workspace } : {}),
		attachFile: attachReplyFile,
		attachments: async () =>
			context.attachmentDir === undefined
				? []
				: listAttachments(context.attachmentDir),
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
