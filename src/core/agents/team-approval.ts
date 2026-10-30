import type { PendingConfirmation } from "../domain/conversation.ts";
import { mayApproveNamed } from "../runtime/extensions/held-calls.ts";
import { type Speaker, tierAtLeast } from "../speakers.ts";
import type { ToolTiers } from "../tool-tiers.ts";

/**
 * Whether the speaker may approve the held actions by a message, call by call: an owner, as the
 * agents' channels are shared, or, for a call whose tool named its approvers, one of those
 * principals, or, for any other call, the principal whose turn held them (by their id, for
 * actions held before 0.9). Their tier must now hold every call. Nobody else in the channel
 * may, so a call that named approvers is not its speaker's to approve unless named. The gate
 * checks the named approvers again when the turn begins, whoever asked for the release.
 */
export function mayApprove(
	tiers: Pick<ToolTiers, "allows">,
	speaker: Speaker,
	pending: PendingConfirmation,
): boolean {
	const theirs =
		pending.principalId !== undefined
			? speaker.principalId === pending.principalId
			: speaker.id === pending.speakerId;
	// Nothing held names an approver to go by: only the owners and the speaker whose turn held it.
	if (pending.calls.length === 0) return speaker.tier === "owner" || theirs;
	return pending.calls.every(
		(call) =>
			(speaker.tier === "owner" ||
				(call.approverIds ? mayApproveNamed(speaker, call) : theirs)) &&
			tiers.allows(speaker.tier, call.tool) &&
			(!call.minTier || tierAtLeast(speaker.tier, call.minTier)),
	);
}
