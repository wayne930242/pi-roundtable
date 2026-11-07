import type { BlockKind } from "pi-better-show";

/** How a block that a surface does not draw reads as text. */
export type BlockTextFlavor = "discord" | "line" | "plain";

/** What a surface says about display blocks (see pi-better-show): the kinds it draws and the text it reads the rest as. */
export interface BlockSupport {
	/** The kinds drawn by the surface itself; absent = none. */
	readonly blocks?: readonly BlockKind[];
	/** The flavor of text for the other kinds; absent = `discord`. */
	readonly blockText?: BlockTextFlavor;
}

/** What a surface says about one channel where it differs from the surface's own; a field that is absent changes nothing. */
export interface ChannelSupport extends BlockSupport {
	/** The formatting guidance given to a turn that replies in the channel. */
	readonly formatting?: string;
}

/**
 * What a surface does in `channel`: its own `formatting`, `blocks` and `blockText`, over which the
 * channel's `support` lays what differs (a host's room on an app, which draws no blocks).
 */
export function supportOf(
	surface:
		| (ChannelSupport & {
				support?(channel: string): ChannelSupport | undefined;
		  })
		| undefined,
	channel: string,
): ChannelSupport {
	if (!surface) return {};
	const own = {
		...(surface.formatting === undefined
			? {}
			: { formatting: surface.formatting }),
		...(surface.blocks ? { blocks: surface.blocks } : {}),
		...(surface.blockText ? { blockText: surface.blockText } : {}),
	};
	return { ...own, ...surface.support?.(channel) };
}
