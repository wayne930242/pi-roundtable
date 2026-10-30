import type { HeldCall } from "../../domain/conversation.ts";
import type { Release, SpeakerRef } from "./gate-refusals.ts";
import { sameCall } from "./held-calls.ts";

/**
 * How long a late approval's release waits for the call it was granted for. The turn that
 * answers a late card re-makes the call at once, so an hour covers a slow model or a queue of
 * turns and no more; a release nobody spent by then belongs to a call that is long gone.
 */
export const LATE_RELEASE_TTL_MS = 3_600_000;

/**
 * The releases that cards answered after their turn stopped waiting earned. A release lets the
 * identical call run once, only while it is fresh and only in a turn of the person who gave it
 * (or an owner), and it is dropped when the identical call runs without a hold, since that run
 * is the call the person approved.
 */
export class LateReleases {
	#list: { release: Release; at: number }[] = [];

	add(release: Release, now = Date.now()): void {
		this.#prune(now);
		this.#list.push({ release, at: now });
	}

	/**
	 * Takes the release of `call` that `speaker` may spend out of the list; undefined when none
	 * is fresh and theirs. A release whose approver is unknown is anyone's.
	 */
	spend(
		call: Pick<HeldCall, "tool" | "input">,
		speaker: SpeakerRef | undefined,
		now = Date.now(),
	): Release | undefined {
		this.#prune(now);
		const at = this.#list.findIndex(
			({ release }) =>
				sameCall(release.call, call) && maySpend(release, speaker),
		);
		if (at === -1) return undefined;
		const [spent] = this.#list.splice(at, 1);
		return spent?.release;
	}

	/** Drops every release of `call`, whoever gave it. */
	drop(call: Pick<HeldCall, "tool" | "input">): void {
		this.#list = this.#list.filter(
			({ release }) => !sameCall(release.call, call),
		);
	}

	/** Whether a fresh release of `call` waits, for whoever may spend it. */
	has(call: Pick<HeldCall, "tool" | "input">, now = Date.now()): boolean {
		this.#prune(now);
		return this.#list.some(({ release }) => sameCall(release.call, call));
	}

	#prune(now: number): void {
		this.#list = this.#list.filter(({ at }) => now - at <= LATE_RELEASE_TTL_MS);
	}
}

/**
 * Whether `speaker` may spend `release`: they gave it, or are an owner; anyone, when its giver is
 * unknown. A turn without a speaker is the owner's, as the gate treats it everywhere else.
 */
function maySpend(release: Release, speaker: SpeakerRef | undefined): boolean {
	if (!release.by) return true;
	if (!speaker) return true;
	return (
		speaker.tier === "owner" || speaker.principalId === release.by.principalId
	);
}
