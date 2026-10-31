import { memo } from "react";
import type { RoomIntercom, RoomMessage } from "../../src/api-types.ts";
import { translate as t } from "../lib/messages.ts";
import { MessageMarkdown } from "./message-markdown.tsx";

/** The most characters of a card's summary line. */
const SUMMARY_CHARS = 120;

/**
 * The first line of the text that has words in it, without a Markdown heading's marks, cut to
 * `max` characters with an ellipsis and never through a surrogate pair.
 */
export function intercomSummary(text: string, max = SUMMARY_CHARS): string {
	const line =
		text
			.split("\n")
			.map((one) => one.trim())
			.find((one) => one !== "") ?? "";
	const plain = line.replace(/^#{1,6}\s+/, "");
	if (plain.length <= max) return plain;
	const last = plain.charCodeAt(max - 2);
	const cut = last >= 0xd800 && last <= 0xdbff ? max - 2 : max - 1;
	return `${plain.slice(0, cut)}…`;
}

/** Whom the request went to, or whom the answer came from, in the page's words. */
export function intercomHeading(card: RoomIntercom): string {
	const name = card.peer.displayName;
	if (card.kind === "sent") return t("→ To {name}", { name });
	if (card.kind === "answered") return t("← From {name}", { name });
	return t("No answer from {name}", { name });
}

/**
 * A message between two agents: one small line, its heading and the text's first line, that opens
 * to the whole text when the line leaves part of it out. A lazy chunk, with the note's row.
 */
export const IntercomRow = memo(function IntercomRow(props: {
	message: RoomMessage & { intercom: RoomIntercom };
	enter: boolean;
}) {
	const { message } = props;
	const summary = intercomSummary(message.text);
	const line = (
		<>
			<span className="intercom-heading">
				{intercomHeading(message.intercom)}
			</span>
			{summary ? <span className="intercom-summary">{summary}</span> : null}
		</>
	);
	return (
		<li
			className="line intercom"
			data-mid={message.id}
			data-intercom={message.intercom.kind}
			data-enter={props.enter || undefined}
		>
			{summary === message.text.trim() ? (
				<div className="intercom-card">{line}</div>
			) : (
				<details className="intercom-card">
					<summary>{line}</summary>
					<div className="intercom-body">
						<MessageMarkdown source={message.text} />
					</div>
				</details>
			)}
		</li>
	);
});
