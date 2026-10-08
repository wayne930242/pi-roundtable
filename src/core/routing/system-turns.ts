import type { BackgroundTurn } from "../contract/channels.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";

/** The turns the host itself made, by identity: a copy, or one a plugin writes, is not one of them. */
const made = new WeakSet<BackgroundTurn>();

/**
 * A background turn the host itself starts as the system principal, such as a logged error's
 * report or a Discord webhook's post, at the tier its starter gives; the router runs it as the
 * system principal's speaker. Core-internal: a plugin cannot make one, and a turn it writes naming
 * the system principal is skipped.
 */
export function systemTurn(
	turn: Omit<BackgroundTurn, "author" | "speaker"> & {
		author: { id: string; name: string };
	},
): BackgroundTurn {
	const own: BackgroundTurn = {
		...turn,
		author: { ...turn.author, principalId: SYSTEM_PRINCIPAL },
	};
	made.add(own);
	return own;
}

/** Whether the host made this very turn with `systemTurn`. */
export function isSystemTurn(turn: BackgroundTurn): boolean {
	return made.has(turn);
}
