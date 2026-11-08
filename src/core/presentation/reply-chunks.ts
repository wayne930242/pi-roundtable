import { type BlockKind, parse, type TextLang, toText } from "pi-better-show";
import type { BlockSupport, BlockTextFlavor } from "../domain/block-support.ts";
import { diagramDrawer } from "./diagram-text.ts";
import { splitReply } from "./reply-splitter.ts";

/**
 * The messages that carry agent-written text to a surface. A display block (a fence such as
 * `table` or `mermaid`, or a GitHub alert) is YAML that only a surface that draws it should
 * see, so a block of a kind the surface does not list in `blocks` is turned into text first.
 * A surface that draws any block gets the result whole, since cutting a fence breaks the block;
 * any other surface gets it split into messages within Discord's limit. A block left open at the end
 * of the text is still a block; one that does not parse becomes a plain code block.
 */
export function chunksFor(
	surface: BlockSupport | undefined,
	text: string,
): string[] {
	const converted = textFor(surface, text);
	if ((surface?.blocks ?? []).length === 0) return splitReply(converted);
	return converted.trim() ? [converted] : [];
}

/**
 * The text as `chunksFor` would send it, in one piece: a block of a kind the surface does not draw
 * is text, and nothing is cut. For a surface that shows a message however long it is, such as a
 * web chat's, where cutting would split a code fence.
 */
export function textFor(
	surface: BlockSupport | undefined,
	text: string,
): string {
	return convert(
		text,
		surface?.blocks ?? [],
		surface?.blockText ?? "discord",
		surface?.lang,
	);
}

function convert(
	text: string,
	draws: readonly BlockKind[],
	flavor: BlockTextFlavor,
	lang: TextLang | undefined,
): string {
	const segments = parse(text);
	const blocks = segments.filter((segment) => segment.type !== "markdown");
	// Toward a surface that draws all of them the text is already right, and rejoining the
	// segments would only change its spacing.
	if (blocks.every((block) => draws.includes(block.kind))) return text;
	return toText(segments, {
		flavor,
		mermaid: diagramDrawer(),
		keep: draws,
		...(lang ? { lang } : {}),
	});
}
