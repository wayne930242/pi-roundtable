import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ChannelKey } from "../../domain/conversation.ts";
import { DelegationError } from "../../domain/errors.ts";
import type { OwnerIdentity } from "../../identity.ts";
import { textToolsExtension } from "../../runtime/text-tools.ts";
import { DELEGATE_TOOL_SPEC } from "../../shared/delegate-tool.ts";
import type { Speaker } from "../../speakers.ts";
import type { Delegator } from "./delegator.ts";

export interface OwnerDelegation {
	delegator: Pick<Delegator, "start">;
	owner: { id: string; name: string };
	/** The chat channel a conversation's reports go to, as for schedules. */
	channelFor: (channel: ChannelKey) => Promise<ChannelKey>;
}

/**
 * Registers delegate_task for one owner conversation. `origin` is the channel its turns run
 * in, where each job's thread opens: a group's, for an agent's seat in one.
 */
export function delegateExtension(
	delegation: OwnerDelegation,
	channel: ChannelKey,
	identity: OwnerIdentity,
	origin: ChannelKey = channel,
	/** The person the running turn is for; the report comes back at their tier. */
	speaker: () => Speaker | undefined = () => undefined,
): ExtensionFactory {
	return textToolsExtension(
		[
			{
				...DELEGATE_TOOL_SPEC,
				run: async (input) => {
					const { title, task } = input as { title: string; task: string };
					const target = await delegation.channelFor(channel);
					const job = delegation.delegator.start({
						channel: target,
						origin,
						mode: "owner",
						author: speaker() ?? delegation.owner,
						title,
						task,
					});
					const where =
						target === channel
							? "here"
							: `in ${identity.name}'s Discord direct messages`;
					return `Delegated as task #${job.id}; the report comes back ${where} as a new turn.`;
				},
			},
		],
		DelegationError,
	);
}
