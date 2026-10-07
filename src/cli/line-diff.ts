/** Every line of `before` and `after` in order: kept, removed, or added. */
function lineOps(
	before: readonly string[],
	after: readonly string[],
): { kind: " " | "-" | "+"; line: string }[] {
	// The longest common subsequence, from the end, so the walk below reads forward.
	const rows = before.length + 1;
	const columns = after.length + 1;
	const common = new Uint32Array(rows * columns);
	for (let i = before.length - 1; i >= 0; i--)
		for (let j = after.length - 1; j >= 0; j--)
			common[i * columns + j] =
				before[i] === after[j]
					? (common[(i + 1) * columns + j + 1] ?? 0) + 1
					: Math.max(
							common[(i + 1) * columns + j] ?? 0,
							common[i * columns + j + 1] ?? 0,
						);
	const ops: { kind: " " | "-" | "+"; line: string }[] = [];
	let i = 0;
	let j = 0;
	while (i < before.length || j < after.length) {
		if (i < before.length && j < after.length && before[i] === after[j]) {
			ops.push({ kind: " ", line: before[i++] ?? "" });
			j++;
		} else if (
			j < after.length &&
			(i === before.length ||
				(common[i * columns + j + 1] ?? 0) >
					(common[(i + 1) * columns + j] ?? 0))
		)
			ops.push({ kind: "+", line: after[j++] ?? "" });
		else ops.push({ kind: "-", line: before[i++] ?? "" });
	}
	return ops;
}

const CONTEXT = 3;

/** The change from `before` to `after` as a unified diff with three lines of context; empty when they are the same. */
export function lineDiff(
	before: string,
	after: string,
	file: string,
): string[] {
	const ops = lineOps(before.split("\n"), after.split("\n"));
	const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
	if (changed.length === 0) return [];
	// Changes closer than twice the context share a hunk.
	const hunks: [number, number][] = [];
	for (const index of changed) {
		const last = hunks.at(-1);
		if (last && index - last[1] <= 2 * CONTEXT) last[1] = index;
		else hunks.push([index, index]);
	}
	const lines = [`--- ${file}`, `+++ ${file} (upgraded)`];
	for (const [first, last] of hunks) {
		const start = Math.max(0, first - CONTEXT);
		const end = Math.min(ops.length - 1, last + CONTEXT);
		const before = ops.slice(0, start);
		const span = ops.slice(start, end + 1);
		const count = (list: typeof ops, kind: "-" | "+") =>
			list.filter((op) => op.kind !== (kind === "-" ? "+" : "-")).length;
		const oldLength = count(span, "-");
		const newLength = count(span, "+");
		lines.push(
			`@@ -${count(before, "-") + (oldLength > 0 ? 1 : 0)},${oldLength} +${count(before, "+") + (newLength > 0 ? 1 : 0)},${newLength} @@`,
			...span.map((op) => `${op.kind}${op.line}`),
		);
	}
	return lines;
}
