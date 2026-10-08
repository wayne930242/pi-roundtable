import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ChannelKey } from "../../domain/conversation.ts";
import { DelegationError } from "../../domain/errors.ts";
import { SYSTEM_PRINCIPAL } from "../../identity/principal-store.ts";
import type { OwnerIdentity } from "../../identity.ts";
import { textToolsExtension } from "../../runtime/text-tools.ts";
import type { Delegator } from "../../services.ts";
import { DELEGATE_TOOL_SPEC } from "../../shared/delegate-tool.ts";
import type { Speaker } from "../../speakers.ts";
import { PERSONAL_TARGET } from "../background/personal-target.ts";

export interface OwnerDelegation {
	delegator: Pick<Delegator, "start">;
	/** The chat channel a conversation's reports go to, as for schedules, asked with the asker's principal. */
	channelFor: (channel: ChannelKey, principalId: string) => Promise<ChannelKey>;
}

/**
 * Registers delegate_task for one conversation; a job reports as the person whose turn started
 * it, and in a turn nobody is named for, or the host's own, the tool refuses. `origin` is the
 * channel its turns run in, where each job's thread opens: a group's, for an agent's seat in one.
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
					const author = speaker();
					if (!author)
						throw new DelegationError(
							"a task is delegated only in a turn someone is named for, whose report it is",
						);
					if (author.principalId === SYSTEM_PRINCIPAL)
						throw new DelegationError(
							"the host's own turns, such as a report's, delegate no tasks; ask the owner to",
						);
					const { title, task } = input as { title: string; task: string };
					const target = await delegation.channelFor(
						channel,
						author.principalId,
					);
					const job = delegation.delegator.start({
						channel: target,
						origin,
						target: PERSONAL_TARGET.name,
						author: {
							principalId: author.principalId,
							id: author.id,
							name: author.name,
							tier: author.tier,
						},
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
