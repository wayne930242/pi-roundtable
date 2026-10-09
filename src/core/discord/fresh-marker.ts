/** The divider a guild channel gets when its conversation starts over. */
export const DEFAULT_FRESH_MARKER = "─── new conversation ───";

/** A channel as the divider needs it: whether it is a direct message, and a way to post. */
export interface MarkerTarget {
	dm: boolean;
	send(text: string): Promise<unknown>;
}

/**
 * Posts the divider that ends channel context's window after a conversation started over: a
 * public post of the assistant in a server channel or thread, never in a direct message, and
 * nothing for `false`. A channel that cannot be found or posted to is left as it is; a Discord
 * error rejects, for the caller to log.
 */
export async function postFreshMarker(
	marker: string | false,
	find: () => Promise<MarkerTarget | undefined>,
): Promise<void> {
	if (marker === false) return;
	const target = await find();
	if (!target || target.dm) return;
	await target.send(marker);
}
