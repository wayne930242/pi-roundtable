import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Read-only skill Markdown: raw HTML stays text and links cannot target local/private files. */
export function MarkdownDocument({ source }: { source: string }) {
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			components={{
				a: ({ href, children }) =>
					href && /^https?:\/\//.test(href) ? (
						<a href={href} target="_blank" rel="noreferrer">
							{children}
						</a>
					) : (
						<span>{children}</span>
					),
				img: ({ alt }) => <span>{alt}</span>,
			}}
		>
			{source}
		</Markdown>
	);
}
