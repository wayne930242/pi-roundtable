import type { ReactNode } from "react";

const URL_AT = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]}\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\uff09\u300d\u300f]+$/;

/** The part of a match that is the address, without the punctuation a sentence puts after it. */
function addressOf(match: string): string {
	const trimmed = match.replace(TRAILING, "");
	const url = URL.parse(trimmed);
	return url && (url.protocol === "https:" || url.protocol === "http:")
		? trimmed
		: "";
}

/**
 * Text as written: no Markdown, no HTML. Only a full web address (`https://…`) becomes a link, and
 * only to `http` or `https`, so nothing a stranger wrote can run or load.
 */
export function PlainText({ text }: { text: string }) {
	const parts: ReactNode[] = [];
	let from = 0;
	for (const match of text.matchAll(URL_AT)) {
		const address = addressOf(match[0]);
		if (address === "") continue;
		const start = match.index;
		if (start > from) parts.push(text.slice(from, start));
		parts.push(
			<a
				key={`${start}`}
				href={address}
				target="_blank"
				rel="noreferrer noopener"
			>
				{address}
			</a>,
		);
		from = start + address.length;
	}
	if (from < text.length) parts.push(text.slice(from));
	return <span className="plain">{parts}</span>;
}
