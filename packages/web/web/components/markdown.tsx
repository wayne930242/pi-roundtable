import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block.tsx";

/** Read-only skill Markdown: raw HTML stays text and links cannot target local/private files. */
export function MarkdownDocument({ source }: { source: string }) {
	return (
		<div className="prose document">
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
					pre: CodeBlock,
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
}
