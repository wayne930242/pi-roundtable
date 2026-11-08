import { describe, expect, test } from "bun:test";
import { DISPLAY_KINDS } from "pi-better-show";
import {
	ALL_BLOCKS_REPLY,
	BLOCK_SAMPLES,
	fencesIn,
} from "../testing/fixtures/all-blocks.ts";
import { chunksFor } from "./reply-chunks.ts";
import { splitReply } from "./reply-splitter.ts";

const drawing = { blocks: DISPLAY_KINDS };
const bigTable = (rows: number) =>
	[
		"```table",
		"columns: [name, size]",
		"rows:",
		...Array.from(
			{ length: rows },
			(_, i) => `  - [row number ${i} of the table, ${i * 7}]`,
		),
		"```",
	].join("\n");

describe("chunksFor", () => {
	test("a surface that draws no block gets the text split as a reply is", () => {
		const text = `${"a".repeat(1200)}\n\n${"b".repeat(1200)}`;
		expect(chunksFor(undefined, text)).toEqual(splitReply(text));
		expect(chunksFor({}, "hello\n\nworld")).toEqual(["hello\n\nworld"]);
	});

	test("a surface that draws the kinds in a text gets it whole, byte for byte, even past the message limit", () => {
		const table = bigTable(200);
		expect(table.length).toBeGreaterThan(5000);
		const text = `Before.\n${table}\nAfter, with a single newline around the block.`;
		expect(chunksFor(drawing, text)).toEqual([text]);
	});

	test("a surface that draws blocks gets plain text whole too, not cut at the message limit", () => {
		const text = `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`;
		expect(chunksFor(drawing, text)).toEqual([text]);
		expect(chunksFor(drawing, "  \n")).toEqual([]);
	});

	test("a kind the surface does not draw becomes text while a declared kind stays a fence", () => {
		const text = ["Pick one.", BLOCK_SAMPLES.options, BLOCK_SAMPLES.table].join(
			"\n\n",
		);
		const [chunk, ...rest] = chunksFor(drawing, text);
		expect(rest).toEqual([]);
		expect(fencesIn(chunk ?? "")).toEqual(["table"]);
		expect(chunk).toContain(BLOCK_SAMPLES.table);
		expect(chunk).toContain("Reply with a number.");
	});

	test("an interactive kind the surface does not draw asks in the surface's language", () => {
		const text = ["Pick one.", BLOCK_SAMPLES.options].join("\n\n");
		const zh = chunksFor({ ...drawing, lang: "zh-TW" }, text).join("\n");
		expect(zh).toContain("\u8acb\u56de\u8986\u7de8\u865f\u3002");
		expect(zh).not.toContain("Reply with a number.");
		const en = chunksFor(drawing, text).join("\n");
		expect(en).toContain("Reply with a number.");
		expect(fencesIn(zh)).toEqual([]);
	});

	test("a declared kind that does not parse stays as it was written", () => {
		const broken = "```table\ncolumns: [unclosed\n```";
		expect(chunksFor(drawing, `Text.\n\n${broken}`)).toEqual([
			`Text.\n\n${broken}`,
		]);
	});

	test("a Discord reply keeps no block fence but diff, and a diagram is drawn as text", () => {
		const chunks = chunksFor(undefined, ALL_BLOCKS_REPLY);
		expect(chunks.length).toBeGreaterThan(0);
		const joined = chunks.join("\n\n");
		expect(fencesIn(joined)).toEqual(["diff"]);
		expect(joined).toContain("Start");
		expect(joined).not.toContain("graph TD");
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
	});

	test("a LINE reply keeps no fence at all and no Markdown markup", () => {
		const chunks = chunksFor({ blockText: "line" }, ALL_BLOCKS_REPLY);
		const joined = chunks.join("\n\n");
		expect(joined).not.toContain("```");
		expect(joined).not.toContain("**");
		expect(joined).toContain("Heads up");
	});

	test("a block left open at the end of a reply is still a block: text for a text surface, as written for one that draws it", () => {
		const open =
			"Working on it.\n\n```table\ncolumns: [a, b]\nrows:\n  - [1, 2]";
		expect(chunksFor(undefined, open)).toEqual([
			"Working on it.\n\n• a: 1 · b: 2",
		]);
		expect(chunksFor(drawing, open)).toEqual([open]);
	});

	test("a diagram that cannot be drawn in time reaches a text surface as its source, in well under a second", () => {
		// 25 states in a chain: a 250-byte source that the text drawing needs about a minute for.
		const slow = `stateDiagram-v2\n${Array.from({ length: 25 }, (_, i) => `S${i} --> S${i + 1}`).join("\n")}`;
		const started = performance.now();
		const chunks = chunksFor(
			undefined,
			`Plan:\n\n\`\`\`mermaid\n${slow}\n\`\`\``,
		);
		expect(performance.now() - started).toBeLessThan(2500);
		expect(chunks.join("\n")).toContain("S0 --> S1");
		expect(chunks.join("\n")).not.toContain("┌");
	}, 8000);

	test("a diagram over 3 KB is not drawn as text at all: a text surface gets its source as a code block", () => {
		const long = `graph TD\n${Array.from({ length: 400 }, (_, i) => `A${i} --> A${i + 1}`).join("\n")}`;
		expect(Buffer.byteLength(long)).toBeGreaterThan(3 * 1024);
		const chunks = chunksFor(undefined, `\`\`\`mermaid\n${long}\n\`\`\``);
		expect(chunks.join("\n")).toContain("A399 --> A400");
		expect(chunks.join("\n")).not.toContain("┌");
	}, 8000);

	test("a small diagram is still drawn as boxes, repeated or not", () => {
		const text = "```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```";
		for (let i = 0; i < 2; i++) {
			const joined = chunksFor(undefined, text).join("\n");
			expect(joined).toContain("Start");
			expect(joined).toContain("┌");
		}
	});
});
