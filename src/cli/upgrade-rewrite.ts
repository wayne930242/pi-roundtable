import { ConfigEditError, type Node } from "./config-edit.ts";

/** One replacement of the source text: [start, end) becomes `text`. */
export interface Edit {
	start: number;
	end: number;
	text: string;
}

/**
 * Rewrites one configuration's text. Each place it cannot read with confidence, such as an owner
 * built elsewhere or spread into the object, is a ConfigEditError naming the file, line, and column.
 */
export class Rewrite {
	readonly source: string;
	readonly #file: string;
	readonly #comments: readonly Node[];
	readonly edits: Edit[] = [];
	readonly moved: Node[] = [];

	constructor(source: string, file: string, comments: readonly Node[]) {
		this.source = source;
		this.#file = file;
		this.#comments = comments;
	}

	text(node: Node): string {
		return this.source.slice(node.start, node.end);
	}

	/** A ConfigEditError at the node, as `file:line:column: message`. */
	at(node: Node, message: string): ConfigEditError {
		const before = this.source.slice(0, node.start);
		const line = before.split("\n").length;
		const column = node.start - (before.lastIndexOf("\n") + 1) + 1;
		return new ConfigEditError(`${this.#file}:${line}:${column}: ${message}`);
	}

	/** The indentation of the node's line, when the node starts it; undefined when it shares the line. */
	indentOf(node: Node): string | undefined {
		const lineStart = this.source.lastIndexOf("\n", node.start - 1) + 1;
		const before = this.source.slice(lineStart, node.start);
		return /^[ \t]*$/.test(before) ? before : undefined;
	}

	/** The comments inside [start, end). */
	commentsIn(start: number, end: number): Node[] {
		return this.#comments.filter(
			(comment) => comment.start >= start && comment.end <= end,
		);
	}

	/**
	 * Where the property and what belongs to it end when it is removed: the comment lines right
	 * above it, its comma, and a comment after it on its line, through the line's end when it has
	 * the line to itself.
	 */
	removal(property: Node): { start: number; end: number } {
		const source = this.source;
		let end = property.end;
		const after = /^[ \t]*,?[ \t]*(\/\/[^\n]*|\/\*[^\n]*?\*\/)?[ \t]*/.exec(
			source.slice(end),
		);
		end += after?.[0].length ?? 0;
		const indent = this.indentOf(property);
		if (indent === undefined || (source[end] !== "\n" && end < source.length))
			return { start: property.start, end };
		let start = property.start - indent.length;
		for (;;) {
			const previousEnd = start - 1;
			if (previousEnd < 0) break;
			const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
			const line = source.slice(previousStart, previousEnd).trim();
			if (
				!(
					line.startsWith("//") ||
					(line.startsWith("/*") && line.endsWith("*/"))
				)
			)
				break;
			start = previousStart;
		}
		return { start, end: end + (source[end] === "\n" ? 1 : 0) };
	}

	/** The comment lines to put back above a rewritten property, at its indentation. */
	commentLines(comments: readonly Node[], indent: string | undefined): string {
		if (comments.length === 0) return "";
		if (indent === undefined) {
			const line = comments.find((comment) => comment.type === "CommentLine");
			if (line)
				throw this.at(
					line,
					"this comment is inside what the upgrade rewrites, on a line it shares with other keys; move it out, or rewrite the key by hand",
				);
			return `${comments.map((comment) => this.text(comment)).join(" ")} `;
		}
		return comments
			.map((comment) => `${this.text(comment)}\n${indent}`)
			.join("");
	}
}
