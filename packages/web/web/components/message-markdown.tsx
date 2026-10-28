import { memo, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { Icon } from "./icons.tsx";

/** What a message names a dispatch thread's room by: `<surface>:thread.<uuid>`, as a link's address. */
export const THREAD_LINK = /^[^\s:()]+:thread\.[0-9a-f-]{36}$/;

/** Whether Markdown text links a dispatch thread's room. */
export const hasThreadLink = (text: string): boolean =>
	/\]\([^\s:()]+:thread\.[0-9a-f-]{36}\)/.test(text);

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
 * are web addresses or name a dispatch thread's room (which opens in the app), and an image is
 * shown as its description, so a message can load nothing.
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
				urlTransform={(url) =>
					THREAD_LINK.test(url) ? url : defaultUrlTransform(url)
				}
				components={{
					a: ({ href, children }) =>
						href && THREAD_LINK.test(href) ? (
							<a className="thread-link" href={hrefFor("room", href)}>
								{children}
							</a>
						) : href && /^https?:\/\//.test(href) ? (
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
