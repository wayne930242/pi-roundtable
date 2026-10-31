import { memo } from "react";
import type { RoomMessage } from "../../src/api-types.ts";
import { clock } from "../lib/format.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { HostMarkdown } from "./host-markdown.tsx";
import { HostPicture } from "./host-picture.tsx";
import { Icon } from "./icons.tsx";
import { Files, FilesJump } from "./message-row.tsx";
import { PlainText } from "./plain-text.tsx";

/**
 * One message of a host room. What an outside party or a team member wrote is plain text (a full
 * web address becomes a link, nothing else); what the assistant or the host wrote is Markdown. A
 * notice is a line of its own between the messages.
 */
export const HostMessageRow = memo(function HostMessageRow(props: {
	message: RoomMessage;
	/** Show the author's name and picture: the author changed, or a pause came. */
	header: boolean;
	enter: boolean;
	/** The message was unread as the room opened or arrived out of sight: it wears a frame until seen. */
	unread?: boolean;
	timeZone: string;
	/** The signed-in person's principal, whose own messages stand at the right. */
	me: string | undefined;
	highlighted: boolean;
}) {
	const { message } = props;
	const kind = message.authorKind ?? "external";
	if (kind === "notice")
		return (
			<li
				className="host-notice"
				data-mid={message.id}
				data-highlight={props.highlighted || undefined}
				data-enter={props.enter || undefined}
			>
				<Icon name="bell" size={14} />
				<HostMarkdown source={message.text} />
				<time dateTime={message.at}>{clock(message.at, props.timeZone)}</time>
			</li>
		);
	const mine =
		kind === "member" &&
		message.principalId !== undefined &&
		message.principalId === props.me;
	return (
		<li
			className="message"
			data-mid={message.id}
			data-author={kind}
			data-mine={mine || undefined}
			data-header={props.header || undefined}
			data-enter={props.enter || undefined}
			data-unread={props.unread || undefined}
			data-highlight={props.highlighted || undefined}
		>
			{mine ? null : (
				<span className="message-avatar">
					{props.header ? (
						<HostPicture picture={message.picture} name={message.author} />
					) : null}
				</span>
			)}
			<div className="message-main">
				{props.header ? (
					<div className="message-meta">
						<strong>{message.author}</strong>
						{message.authorLabel ? (
							<span className="label-chip">{message.authorLabel}</span>
						) : null}
						<time dateTime={message.at}>
							{clock(message.at, props.timeZone)}
						</time>
					</div>
				) : null}
				<div className="bubble">
					<FilesJump files={message.files} />
					{message.text ? (
						kind === "assistant" ? (
							<HostMarkdown source={message.text} />
						) : (
							<PlainText text={message.text} />
						)
					) : null}
					<Files files={message.files} message={message} />
					{message.expiredFiles ? (
						<p className="message-expired">
							{plural(
								message.expiredFiles,
								"{count} file was removed",
								"{count} files were removed",
							)}
						</p>
					) : null}
				</div>
				{message.edited ? (
					<span className="message-edited">{t("edited")}</span>
				) : null}
			</div>
		</li>
	);
});
