// Chat Markdown as Discord writes it, so a message reads the same in the app as in a channel: a line
// that starts with `-# ` is subtext (small and quiet), and a single line break inside a paragraph
// stays a line break. Code, inline or fenced, is left as it is.

/** The few Markdown tree shapes this pass reads and writes. */
interface Node {
	type: string;
	value?: string;
	children?: Node[];
	data?: { hProperties?: Record<string, unknown> };
}

const SUBTEXT = /^-# /;

/** A paragraph as the paragraphs it reads as: runs of plain lines and runs of subtext lines. */
function split(paragraph: Node): Node[] {
	// The paragraph's inline nodes cut into lines, at each line break and each newline in its text.
	const lines: Node[][] = [[]];
	for (const child of paragraph.children ?? [])
		if (child.type === "break") lines.push([]);
		else if (child.type !== "text") lines.at(-1)?.push(child);
		else
			(child.value ?? "").split("\n").forEach((part, at) => {
				if (at) lines.push([]);
				if (part) lines.at(-1)?.push({ type: "text", value: part });
			});
	const runs: { quiet: boolean; children: Node[] }[] = [];
	for (const line of lines) {
		const first = line[0];
		const quiet = first?.type === "text" && SUBTEXT.test(first.value ?? "");
		if (quiet && first) first.value = first.value?.replace(SUBTEXT, "");
		const last = runs.at(-1);
		if (last?.quiet === quiet) last.children.push({ type: "break" }, ...line);
		else runs.push({ quiet, children: line });
	}
	return runs.map(({ quiet, children }) => ({
		type: "paragraph",
		children,
		...(quiet ? { data: { hProperties: { className: ["subtext"] } } } : {}),
	}));
}

function walk(node: Node): void {
	if (!node.children) return;
	node.children = node.children.flatMap((child) =>
		child.type === "paragraph" ? split(child) : [child],
	);
	for (const child of node.children) walk(child);
}

/** The remark plugin: Discord's subtext and line breaks in a message's Markdown tree. */
export const remarkChat = () => walk;
