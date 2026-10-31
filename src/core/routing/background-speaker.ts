import type { BackgroundRunsAs, BackgroundTurn } from "../contract/channels.ts";
import { IdentityError } from "../domain/errors.ts";
import {
	type IdentityService,
	systemSpeaker,
} from "../identity/identity-service.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { isSystemTurn } from "./system-turns.ts";

/**
 * Who a background turn runs as, before its claim has the last word: the system principal for
 * the host's own turn, at its tier; otherwise its author's principal, which the identity service
 * checks and caps at the lower of the turn's tier and theirs. Why not, when it may not run;
 * throws when the identity service cannot tell.
 */
export async function speakerOf(
	turn: BackgroundTurn,
	principals: Pick<IdentityService, "speakerFor"> | undefined,
): Promise<BackgroundRunsAs> {
	const { author, tier } = turn;
	if (!author?.principalId || !tier)
		return {
			skipped:
				"a background turn names its author's principal (author.principalId) and the tier it runs at (tier); this one does not",
		};
	if (author.principalId === SYSTEM_PRINCIPAL)
		return isSystemTurn(turn)
			? { speaker: { ...systemSpeaker(tier), name: author.name } }
			: {
					skipped: `only the host itself starts a turn as the system principal "${SYSTEM_PRINCIPAL}"`,
				};
	if (!principals)
		return {
			skipped: "the host has no identity service to check whom it runs as",
		};
	try {
		const checked = await principals.speakerFor(author.principalId, tier);
		return {
			speaker: {
				id: author.id,
				name: author.name,
				tier: checked.tier,
				principalId: checked.principalId,
			},
		};
	} catch (error) {
		if (!(error instanceof IdentityError)) throw error;
		return { skipped: error.message };
	}
}
