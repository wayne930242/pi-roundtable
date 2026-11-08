import {
	type BlockSegment,
	DISPLAY_KINDS,
	INTERACTIVE_KINDS,
	parse,
	type Segment,
} from "pi-better-show";
import { configure } from "pi-better-show/elements";
import { PbsBlock } from "pi-better-show/react";
import type { ReactNode } from "react";
import { locale, translate } from "../lib/messages.ts";
import { useTheme } from "../lib/theme.ts";
import { AnswerBlock } from "./block-answer.tsx";
import { MarkdownContent } from "./message-markdown.tsx";

/** The most a diagram's source may be: the route refuses more (`src/diagram-route.ts`). */
const MAX_DIAGRAM_BYTES = 8 * 1024;

const encoder = new TextEncoder();

/** A diagram's image address on the app's own route, or none for a source the route would refuse. */
function diagramUrl(
	source: string,
	scheme: "light" | "dark",
): string | undefined {
	const bytes = encoder.encode(source);
	if (bytes.length > MAX_DIAGRAM_BYTES) return undefined;
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const encoded = btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
	return `api/diagram?scheme=${scheme}&s=${encoded}`;
}

/**
 * A review item's image, only through the app's own file route: the id of a file the agent
 * attached (`file:<id>`), never an address the agent wrote.
 */
function imageUrl(ref: string): string | undefined {
	return ref.startsWith("file:") && ref.length > 5
		? `api/files/${encodeURIComponent(ref.slice(5))}`
		: undefined;
}

let configured = false;
function configureOnce(): void {
	if (configured) return;
	configured = true;
	// A prototype page is never framed here; the review shows where to open it.
	const pageUnavailable = translate(
		"Prototype page, open it on the computer: ",
	);
	configure({
		diagramUrl,
		imageUrl,
		strings: {
			en: { pageUnavailable },
			"zh-Hant": { pageUnavailable },
		},
	});
}

/** A fence that has its closing line, or an alert (which has none): a block still being written is not drawn. */
function closed(segment: Segment): boolean {
	if (segment.type === "markdown") return true;
	if (segment.kind === "alert") return true;
	const lines = segment.raw.trimEnd().split("\n");
	return lines.length > 1 && /^ {0,3}(?:```|~~~)\s*$/.test(lines.at(-1) ?? "");
}

function BlockPanel({ segment }: { segment: BlockSegment }) {
	const { resolved } = useTheme();
	return (
		<div className="block-slot">
			<PbsBlock
				segment={segment}
				density="compact"
				scheme={resolved}
				lang={locale()}
			/>
		</div>
	);
}

/**
 * A message's content with its display blocks drawn by the `pbs-*` elements. Anything that is not
 * a drawable block stays Markdown: a block that does not parse and a block not yet closed show as
 * the code block it is, the first with the reason under it. An interactive block is answerable
 * where the message around it says so (see `AnswerBlock`).
 */
export default function Blocks({ source }: { source: string }) {
	configureOnce();
	const parts: ReactNode[] = [];
	for (const segment of parse(source)) {
		const at = parts.length;
		if (segment.type === "markdown") {
			parts.push(<MarkdownContent key={at} source={segment.text} />);
		} else if (!closed(segment)) {
			parts.push(<MarkdownContent key={at} source={segment.raw} />);
		} else if (segment.type === "invalid") {
			parts.push(
				<MarkdownContent key={at} source={segment.raw} />,
				<p key={`${at}e`} className="block-error">
					{segment.error}
				</p>,
			);
		} else if ((DISPLAY_KINDS as readonly string[]).includes(segment.kind)) {
			parts.push(<BlockPanel key={at} segment={segment} />);
		} else if (
			(INTERACTIVE_KINDS as readonly string[]).includes(segment.kind)
		) {
			parts.push(<AnswerBlock key={at} segment={segment} />);
		} else {
			parts.push(<MarkdownContent key={at} source={segment.raw} />);
		}
	}
	return <>{parts}</>;
}
