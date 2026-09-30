export const DISCORD_MESSAGE_LIMIT = 2000;

interface Block {
	text: string;
	/** The opening fence line when the block is a fenced code block. */
	fence?: string;
}

function fenceMarker(openingLine: string): string {
	return openingLine.trim().slice(0, 3);
}

/** Paragraphs separated by blank lines; a fenced code block is one block even with blank lines. */
function parseBlocks(text: string): Block[] {
	const blocks: Block[] = [];
	let lines: string[] = [];
	let fence: string | undefined;
	const flush = () => {
		if (lines.some((line) => line.trim())) {
			blocks.push({ text: lines.join("\n"), fence });
		}
		lines = [];
		fence = undefined;
	};

	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (fence) {
			lines.push(line);
			if (line.trim() === fenceMarker(fence)) flush();
		} else if (/^\s*(```|~~~)/.test(line)) {
			flush();
			fence = line;
			lines.push(line);
		} else if (!line.trim()) {
			flush();
		} else {
			lines.push(line);
		}
	}
	flush();
	return blocks;
}

function hardSplit(text: string, limit: number): string[] {
	const pieces: string[] = [];
	let current = "";
	for (const character of text) {
		if (current.length + character.length > limit) {
			pieces.push(current);
			current = "";
		}
		current += character;
	}
	if (current) pieces.push(current);
	return pieces;
}

/** Packs lines into pieces of at most `limit`, splitting a single overlong line by characters. */
function packLines(lines: string[], limit: number): string[] {
	const pieces: string[] = [];
	let current: string | undefined;
	for (const line of lines.flatMap((l) =>
		l.length > limit ? hardSplit(l, limit) : [l],
	)) {
		if (current !== undefined && current.length + 1 + line.length <= limit) {
			current += `\n${line}`;
		} else {
			if (current !== undefined) pieces.push(current);
			current = line;
		}
	}
	if (current !== undefined) pieces.push(current);
	return pieces;
}

function splitBlock(block: Block, limit: number): string[] {
	if (block.text.length <= limit) return [block.text];
	if (!block.fence) return packLines(block.text.split("\n"), limit);

	// A long code block becomes several complete code blocks, each reopened with the same fence.
	const marker = fenceMarker(block.fence);
	const lines = block.text.split("\n");
	const closed = lines.length > 1 && lines.at(-1)?.trim() === marker;
	const body = lines.slice(1, closed ? -1 : undefined);
	const overhead = block.fence.length + 1 + 1 + marker.length;
	return packLines(body, limit - overhead).map(
		(piece) => `${block.fence}\n${piece}\n${marker}`,
	);
}

/** Splits a reply into Discord messages on paragraph and code-block boundaries. */
export function splitReply(
	text: string,
	limit = DISCORD_MESSAGE_LIMIT,
): string[] {
	const chunks: string[] = [];
	let current: string | undefined;
	for (const piece of parseBlocks(text).flatMap((block) =>
		splitBlock(block, limit),
	)) {
		if (current !== undefined && current.length + 2 + piece.length <= limit) {
			current += `\n\n${piece}`;
		} else {
			if (current !== undefined) chunks.push(current);
			current = piece;
		}
	}
	if (current !== undefined) chunks.push(current);
	return chunks;
}
