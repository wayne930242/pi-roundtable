import { memo } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { translate as t } from "../lib/messages.ts";
import { Pre } from "./message-markdown.tsx";

/** A file the host saved in the room, named in an image: `![alt](file:<id>)`. */
const FILE_IMAGE = /^file:([A-Za-z0-9_-]{1,64})$/;

/** Whether an address is on the page's own origin: a link to another room or page. */
function sameOrigin(href: string): boolean {
	const url = URL.parse(href, document.baseURI);
	return url !== null && url.origin === window.location.origin;
}

/** A picture the host saved, or its description as text when it cannot be shown. */
function FileImage({ id, alt }: { id: string; alt: string }) {
	return (
		<img
			className="file-image"
			src={`api/files/${encodeURIComponent(id)}`}
			alt={alt}
			loading="lazy"
			decoding="async"
			onError={(event) => {
				const text = document.createElement("span");
				text.textContent = alt || t("Image");
				event.currentTarget.replaceWith(text);
			}}
		/>
	);
}

/**
 * Markdown the host or its assistant wrote for a host room: raw HTML stays text, a link opens only
 * if it is a web address or an address on this page's origin (another room, a page), and an image
 * is shown only when it names a file the host saved (`file:<id>`); any other image is its description.
 */
export const HostMarkdown = memo(function HostMarkdown({
	source,
}: {
	source: string;
}) {
	return (
		<div className="prose">
			<Markdown
				remarkPlugins={[remarkGfm]}
				urlTransform={(url) =>
					FILE_IMAGE.test(url) ? url : defaultUrlTransform(url)
				}
				components={{
					a: ({ href, children }) =>
						href && /^https?:\/\//.test(href) && !sameOrigin(href) ? (
							<a href={href} target="_blank" rel="noreferrer noopener">
								{children}
							</a>
						) : href && sameOrigin(href) ? (
							<a href={href}>{children}</a>
						) : (
							<span>{children}</span>
						),
					img: ({ src, alt }) => {
						const file = typeof src === "string" ? FILE_IMAGE.exec(src) : null;
						return file?.[1] ? (
							<FileImage id={file[1]} alt={alt ?? ""} />
						) : (
							<span>{alt}</span>
						);
					},
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
