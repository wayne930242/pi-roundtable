import { memo } from "react";
import type { RoomMessage } from "../../src/api-types.ts";
import { useSelector } from "../lib/app-store.ts";
import { clock } from "../lib/format.ts";
import { translate as t } from "../lib/messages.ts";
import { installNoteStyle } from "../lib/note-style.ts";
import { HelpersEndedLine } from "./helpers-ended-line.tsx";
import { HostPicture } from "./host-picture.tsx";
import { IntercomRow } from "./intercom-row.tsx";
import { MessageMarkdown } from "./message-markdown.tsx";
import { Files } from "./message-row.tsx";

installNoteStyle();

/**
 * An internal note of an agent room: written by one of the room's people for the others, never
 * given to the agent. It always names its author, with their picture, and says it is a note. A
 * lazy chunk, loaded when the first note, or the first line of archived temp knights, is shown.
 */
const NoteRow = memo(function NoteRow(props: {
	message: RoomMessage;
	enter: boolean;
	timeZone: string;
}) {
	const { message } = props;
	const me = useSelector((state) => state.principal?.id);
	const mine = message.principalId !== undefined && message.principalId === me;
	return (
		<li
			className="message"
			data-mid={message.id}
			data-note
			data-mine={mine || undefined}
			data-header
			data-enter={props.enter || undefined}
		>
			{mine ? null : (
				<span className="message-avatar">
					<HostPicture
						picture={
							message.principalId === undefined
								? undefined
								: { principal: message.principalId }
						}
						name={message.author}
					/>
				</span>
			)}
			<div className="message-main">
				<div className="message-meta">
					<strong>{message.author}</strong>
					<span className="note-chip">{t("Internal note")}</span>
					<time dateTime={message.at}>{clock(message.at, props.timeZone)}</time>
				</div>
				<div className="bubble">
					{message.text ? <MessageMarkdown source={message.text} /> : null}
					<Files files={message.files} />
				</div>
			</div>
		</li>
	);
});

/**
 * What the first note, the first line of a knight's archived temp knights, or the first message
 * between agents loads: a note's row, that line, or the message's card.
 */
export default function ExtraRow(props: {
	message: RoomMessage;
	enter: boolean;
	timeZone: string;
}) {
	const { intercom } = props.message;
	if (intercom)
		return (
			<IntercomRow
				message={{ ...props.message, intercom }}
				enter={props.enter}
			/>
		);
	return props.message.kind === "system" ? (
		<HelpersEndedLine message={props.message} enter={props.enter} />
	) : (
		<NoteRow {...props} />
	);
}
