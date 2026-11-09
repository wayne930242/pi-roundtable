import {
	type PromptScope,
	SYSTEM_PRINCIPAL,
	TIERS,
	type Tier,
} from "pi-roundtable";

import type { Answerer } from "./desk-types.ts";

export const atLeast = (tier: Tier, least: Tier) =>
	TIERS.indexOf(tier) >= TIERS.indexOf(least);

/**
 * Who may approve a call held at `minTier`, as a test of the person who answers; undefined when
 * no one may, so the call is unavailable at once.
 */
export function approvalAudience(
	scope: PromptScope | undefined,
	minTier: Tier,
	approvers: readonly string[] | undefined,
	speakerOnly: boolean,
): ((from: Answerer) => boolean) | undefined {
	const tierOk = (from: Answerer) => atLeast(from.tier, minTier);
	const owner = (from: Answerer) => from.tier === "owner";
	if (speakerOnly) {
		// The speaker's alone: below the tier, or a speaker who is no person, no one answers.
		if (
			!scope ||
			scope.principalId === SYSTEM_PRINCIPAL ||
			!atLeast(scope.tier, minTier)
		)
			return undefined;
		const speaker = scope.principalId;
		return (from) => from.principalId === speaker && tierOk(from);
	}
	// Without a scope a card is the owners'.
	if (!scope) return owner;
	const person = scope.principalId;
	if (scope.escalate === "none") {
		// A private conversation's person is the only one who answers, and a call naming others is theirs only if named or an owner.
		if (!atLeast(scope.tier, minTier)) return undefined;
		if (
			approvers?.length &&
			!approvers.includes(person) &&
			scope.tier !== "owner"
		)
			return undefined;
		return (from) => from.principalId === person && tierOk(from);
	}
	if (approvers?.length) {
		// Named approvers answer it, at the tier it needs now, and so do the owners; the speaker does not unless named.
		const named = new Set(approvers);
		return (from) =>
			(named.has(from.principalId) && tierOk(from)) || owner(from);
	}
	return (from) => (from.principalId === person && tierOk(from)) || owner(from);
}

/** Who may answer a question: the speaker, and the owners where the scope escalates; without a scope, the owners. */
export function questionAudience(scope: PromptScope | undefined) {
	if (!scope) return (from: Answerer) => from.tier === "owner";
	const person = scope.principalId;
	if (scope.escalate === "none")
		return (from: Answerer) => from.principalId === person;
	return (from: Answerer) =>
		from.principalId === person || from.tier === "owner";
}
