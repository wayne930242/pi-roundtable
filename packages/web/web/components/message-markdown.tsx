import { lazy, memo, Suspense, useContext, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { BLOCK_HINT } from "../lib/block-hint.ts";
import { ConfigContext } from "../lib/config.ts";
import { translate as t } from "../lib/messages.ts";
import { remarkChat } from "../lib/remark-chat.ts";
import { hrefFor } from "../lib/router.ts";
import { Icon } from "./icons.tsx";

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a message names a dispatch thread's room by: `<surface>:thread.<uuid>`, as a link's address. */
const threadLinkOf = (surface: string | undefined): RegExp =>
	new RegExp(
		surface ? `^${escapeRegExp(surface)}:thread\\.[0-9a-f-]{36}$` : "(?!)",
	);

/** Whether Markdown text links a dispatch thread's room of the surface. */
export const hasThreadLink = (
	text: string,
	surface: string | undefined,
): boolean =>
	surface !== undefined &&
	new RegExp(`\\]\\(${escapeRegExp(surface)}:thread\\.[0-9a-f-]{36}\\)`).test(
		text,
	);

/** A fenced code block with a button that copies it. */
export function Pre({ children }: { children?: React.ReactNode }) {
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

// Display blocks (cards, tables, diagrams, ...) are drawn by pi-better-show's elements, which a
// message without a block never loads.
const Blocks = lazy(() => import("./blocks.tsx"));

/**
 * Markdown as elements, without the wrapper: raw HTML in it stays text, links open only if they
 * are web addresses or name a dispatch thread's room (which opens in the app), and an image is
 * shown as its description, so a message can load nothing.
 */
export const MarkdownContent = memo(function MarkdownContent({
	source,
}: {
	source: string;
}) {
	const threadLink = threadLinkOf(useContext(ConfigContext)?.app?.surface);
	return (
		<Markdown
			remarkPlugins={[remarkGfm, remarkChat]}
			urlTransform={(url) =>
				threadLink.test(url) ? url : defaultUrlTransform(url)
			}
			components={{
				a: ({ href, children }) =>
					href && threadLink.test(href) ? (
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
	);
});

/**
 * An agent's or owner's message as Markdown. It reads as Discord writes it: a line break stays
 * one, and a line that starts with `-# ` is subtext. A message with a display block draws it
 * (see `Blocks`), showing the Markdown until the blocks chunk has loaded.
 */
export const MessageMarkdown = memo(function MessageMarkdown({
	source,
}: {
	source: string;
}) {
	const plain = <MarkdownContent source={source} />;
	return (
		<div className="prose">
			{BLOCK_HINT.test(source) ? (
				<Suspense fallback={plain}>
					<Blocks source={source} />
				</Suspense>
			) : (
				plain
			)}
		</div>
	);
});
