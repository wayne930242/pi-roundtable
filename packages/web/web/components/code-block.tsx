import { type ReactNode, useState } from "react";
import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";

/** The text of rendered Markdown children, as it was written. */
const textOf = (node: ReactNode): string => {
	if (typeof node === "string") return node;
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (node && typeof node === "object" && "props" in node)
		return textOf((node.props as { children?: ReactNode }).children);
	return "";
};

/**
 * A fenced code block with a button that copies it: the one code block of every Markdown view (a
 * message, a host room, a skill document). A long line scrolls inside the block, not the panel.
 */
export function CodeBlock({ children }: { children?: ReactNode }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="code-block">
			<pre>{children}</pre>
			<button
				type="button"
				className="icon-button code-copy"
				aria-label={t("Copy")}
				onClick={() => {
					navigator.clipboard
						?.writeText(textOf(children))
						.then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1400);
						})
						.catch(() => undefined);
				}}
			>
				<Icon name={copied ? "check" : "copy"} size={16} />
			</button>
		</div>
	);
}
