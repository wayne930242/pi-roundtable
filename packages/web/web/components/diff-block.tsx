import { useMemo } from "react";
import { type DiffLine, diffCounts, lineDiff } from "../lib/diff.ts";
import { translate as t } from "../lib/messages.ts";

const DIFF_MARK: Record<DiffLine["kind"], string> = {
	same: " ",
	add: "+",
	del: "−",
};

/** What a change would do, line by line: kept lines, removed lines and added lines, each told apart for a screen reader too. */
export function DiffLines({ lines }: { lines: DiffLine[] }) {
	return (
		<pre className="diff">
			{lines.map((line, index) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines have no identity but their place
					key={index}
					className="diff-line"
					data-kind={line.kind}
				>
					<span className="diff-mark" aria-hidden="true">
						{DIFF_MARK[line.kind]}
					</span>
					{line.kind === "add" || line.kind === "del" ? (
						<span className="visually-hidden">
							{line.kind === "add" ? t("Added") : t("Removed")}:{" "}
						</span>
					) : null}
					{line.text || " "}
				</span>
			))}
		</pre>
	);
}

/** A labelled diff of one text against another, with how many lines it adds and removes. */
export function TextDiff(props: {
	label: string;
	before: string;
	after: string;
}) {
	const lines = useMemo(
		() => lineDiff(props.before, props.after),
		[props.before, props.after],
	);
	const counts = diffCounts(lines);
	return (
		<div className="field">
			<span className="field-label">
				{props.label} ·{" "}
				{t("Lines: {added} added, {removed} removed", {
					added: counts.added,
					removed: counts.removed,
				})}
			</span>
			<DiffLines lines={lines} />
		</div>
	);
}
