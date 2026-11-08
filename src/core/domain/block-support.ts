import {
	type BlockKind,
	INTERACTIVE_KINDS,
	type TextLang,
} from "pi-better-show";

/** How a block that a surface does not draw reads as text. */
export type BlockTextFlavor = "discord" | "line" | "plain";

/** What a surface says about display blocks (see pi-better-show): the kinds it draws and the text it reads the rest as. */
export interface BlockSupport {
	/** The kinds drawn by the surface itself; absent = none. */
	readonly blocks?: readonly BlockKind[];
	/** The flavor of text for the other kinds; absent = `discord`. */
	readonly blockText?: BlockTextFlavor;
	/**
	 * The language a block that reads as text asks its reader to answer in: `en` or `zh-TW`.
	 * Absent = the host's, and without one `en`.
	 */
	readonly lang?: TextLang;
	/**
	 * `false` = the surface's own guidance already says what it cannot do with forms, option
	 * buttons and checklists, so core adds no line about them. Absent = core adds one whenever the
	 * surface does not draw every interactive kind.
	 */
	readonly blockNote?: false;
}

/** What a surface says about one channel where it differs from the surface's own; a field that is absent changes nothing. */
export interface ChannelSupport extends BlockSupport {
	/** The formatting guidance given to a turn that replies in the channel. */
	readonly formatting?: string;
}

/**
 * What a surface does in `channel`: its own `formatting`, `blocks` and `blockText`, over which the
 * channel's `support` lays what differs (a host's room on an app, which draws no blocks). A
 * surface that does not draw every interactive kind (`options`, `suggest`, `form`, `checklist`,
 * `review`) gets a closing line in its `formatting` that says so, so the model does not expect
 * its reader to fill one in. `lang` is the host's language for the text form of a block.
 */
export function supportOf(
	surface:
		| (ChannelSupport & {
				support?(channel: string): ChannelSupport | undefined;
		  })
		| undefined,
	channel: string,
	lang?: TextLang,
): ChannelSupport {
	if (!surface) return {};
	const own = {
		...(surface.formatting === undefined
			? {}
			: { formatting: surface.formatting }),
		...(surface.blocks ? { blocks: surface.blocks } : {}),
		...(surface.blockText ? { blockText: surface.blockText } : {}),
		...(surface.lang ? { lang: surface.lang } : {}),
		...(surface.blockNote === false ? { blockNote: false as const } : {}),
	};
	const merged: ChannelSupport = { ...own, ...surface.support?.(channel) };
	const note =
		merged.blockNote === false ? undefined : interactiveNote(merged.blocks);
	const language = merged.lang ?? lang;
	return {
		...merged,
		...(note === undefined
			? {}
			: { formatting: [merged.formatting, note].filter(Boolean).join(" ") }),
		...(language === undefined ? {} : { lang: language }),
	};
}

/**
 * What the model is told about the interactive kinds a surface does not draw: none when it draws
 * them all. Such a block reaches the reader as a question to answer by typing.
 */
function interactiveNote(
	blocks: readonly BlockKind[] | undefined,
): string | undefined {
	const missing = INTERACTIVE_KINDS.filter((kind) => !blocks?.includes(kind));
	if (missing.length === 0) return undefined;
	const cannot =
		missing.length === INTERACTIVE_KINDS.length
			? "forms, option buttons or checklists"
			: `${missing.map((kind) => `\`${kind}\``).join(", ")} blocks`;
	return `This chat cannot show ${cannot}. Ask in plain text. If you write such a block anyway, the user sees it as text and answers by typing.`;
}
