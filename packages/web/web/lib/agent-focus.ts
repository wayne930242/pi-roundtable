// A menu's "Change look" opens the agent's profile at its character creator. The profile is a
// page of its own, so the wish waits here, once, until the page has loaded and takes it; a wish
// the page never took (the navigation was held back) goes stale.

/** How long a wish for the creator stands. */
const STALE_MS = 10_000;

let wantedAt: number | undefined;

/** The next profile page opens at the character creator. */
export const wantLook = (): void => {
	wantedAt = Date.now();
};

/** Whether a profile page was asked to open at the creator; asking clears it. */
export function takeLook(): boolean {
	const at = wantedAt;
	wantedAt = undefined;
	return at !== undefined && Date.now() - at < STALE_MS;
}
