import { memo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";

/** A fenced code block with a button that copies it. */
function Pre({ children }: { children?: React.ReactNode }) {
	const [copied, setCopied] = useState(false);
	const text = (node: React.ReactNode): string => {
		if (typeof node === "string") return node;
		if (Array.isArray(node)) return node.map(text).join("");
		if (node && typeof node === "object" && "props" in node)
			return text((node.props as { children?: React.ReactNode }).children);
		return "";
	};
	return (
		<div className="code-block">
			<pre>{children}</pre>
			<button
				type="button"
				className="icon-button code-copy"
				aria-label={t("Copy")}
				onClick={() => {
					navigator.clipboard
						?.writeText(text(children))
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

/**
 * An agent's or owner's message as Markdown. Raw HTML in it stays text, links open only if they
 * are web addresses, and an image is shown as its description, so a message can load nothing.
 */
export const MessageMarkdown = memo(function MessageMarkdown({
	source,
}: {
	source: string;
}) {
	return (
		<div className="prose">
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) =>
						href && /^https?:\/\//.test(href) ? (
							<a href={href} target="_blank" rel="noreferrer noopener">
								{children}
							</a>
						) : (
							<span>{children}</span>
						),
					img: ({ alt }) => <span>{alt}</span>,
					pre: Pre,
					table: ({ children }) => (
						<div className="table-wrap">
							<table>{children}</table>
						</div>
					),
				}}
			>
				{source}
			</Markdown>
		</div>
	);
});
