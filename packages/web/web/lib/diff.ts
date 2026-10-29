// A line diff for the prompt editor's review: what a save would remove and what it would add.

export interface DiffLine {
	kind: "same" | "add" | "del";
	text: string;
}

/** Past this many cells the table is not worth building; the whole text is shown as replaced. */
const MAX_CELLS = 4_000_000;

/**
 * The lines of `before` and `after` in order, each marked as kept, removed or added. A common head
 * and tail are kept without comparing; what is left between them is matched by its longest common
 * run of lines.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	)
		tail++;
	const left = a.slice(head, a.length - tail);
	const right = b.slice(head, b.length - tail);
	const out: DiffLine[] = a
		.slice(0, head)
		.map((text) => ({ kind: "same", text }));
	out.push(...middle(left, right));
	out.push(
		...a
			.slice(a.length - tail)
			.map((text): DiffLine => ({ kind: "same", text })),
	);
	return out;
}

function middle(left: string[], right: string[]): DiffLine[] {
	const removed = (lines: string[]): DiffLine[] =>
		lines.map((text) => ({ kind: "del", text }));
	const added = (lines: string[]): DiffLine[] =>
		lines.map((text) => ({ kind: "add", text }));
	if (left.length === 0) return added(right);
	if (right.length === 0) return removed(left);
	if (left.length * right.length > MAX_CELLS)
		return [...removed(left), ...added(right)];
	// lengths[i][j]: the longest common run of left[i..] and right[j..].
	const width = right.length + 1;
	const lengths = new Uint32Array((left.length + 1) * width);
	for (let i = left.length - 1; i >= 0; i--)
		for (let j = right.length - 1; j >= 0; j--)
			lengths[i * width + j] =
				left[i] === right[j]
					? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(
							lengths[(i + 1) * width + j] ?? 0,
							lengths[i * width + j + 1] ?? 0,
						);
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			out.push({ kind: "same", text: left[i] as string });
			i++;
			j++;
		} else if (
			(lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)
		) {
			out.push({ kind: "del", text: left[i] as string });
			i++;
		} else {
			out.push({ kind: "add", text: right[j] as string });
			j++;
		}
	}
	out.push(...removed(left.slice(i)), ...added(right.slice(j)));
	return out;
}

/** How many lines a diff adds and removes. */
export function diffCounts(lines: readonly DiffLine[]): {
	added: number;
	removed: number;
} {
	return {
		added: lines.filter((line) => line.kind === "add").length,
		removed: lines.filter((line) => line.kind === "del").length,
	};
}
