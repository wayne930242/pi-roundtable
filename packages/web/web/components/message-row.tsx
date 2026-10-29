import type { CharacterSpec } from "pi-roundtable/characters";
import { memo, useContext, useEffect, useState } from "react";
import type { RoomFile, RoomMessage } from "../../src/api-types.ts";
import { store, useSelector } from "../lib/app-store.ts";
import { ConfigContext } from "../lib/config.ts";
import { clock } from "../lib/format.ts";
import { avatarMenu, fileMenu, messageMenu } from "../lib/menu-items.ts";
import { useMenuPress } from "../lib/menu-press.ts";
import { translate as t } from "../lib/messages.ts";
import type { PendingSend } from "../lib/rooms.ts";
import { fileUrl } from "../lib/rooms.ts";
import { useConnection } from "../lib/socket.ts";
import { PageCharacter } from "./character.tsx";
import { Icon } from "./icons.tsx";
import { hasThreadLink, MessageMarkdown } from "./message-markdown.tsx";

const YOLO_LINE = /^Yolo mode approved: ([\s\S]*)$/;

/** A line the server wrote into the room, in the page's words. */
export function systemLine(text: string): {
	icon: "bolt" | "reset" | "list";
	text: string;
} {
	if (text === "Conversation started over")
		return { icon: "reset", text: t("Conversation started over") };
	const yolo = YOLO_LINE.exec(text);
	if (yolo)
		return {
			icon: "bolt",
			text: t("Yolo mode approved: {action}", { action: yolo[1] ?? "" }),
		};
	return { icon: "list", text };
}

/** A file of a message: a picture that opens, or a chip that downloads; a long press offers both ways to keep it. */
function FileItem({ file }: { file: RoomFile }) {
	const press = useMenuPress(() => fileMenu(file));
	return file.type.startsWith("image/") ? (
		<li>
			<a
				{...press}
				href={fileUrl(file)}
				target="_blank"
				rel="noreferrer noopener"
			>
				<img
					src={fileUrl(file)}
					alt={file.name}
					loading="lazy"
					decoding="async"
					className="file-image"
				/>
			</a>
		</li>
	) : (
		<li>
			<a
				{...press}
				className="file-chip"
				href={fileUrl(file)}
				download={file.name}
			>
				<Icon name="file" size={16} />
				<span>{file.name}</span>
			</a>
		</li>
	);
}

function Files({ files }: { files: readonly RoomFile[] }) {
	if (files.length === 0) return null;
	return (
		<ul className="files">
			{files.map((file) => (
				<FileItem key={file.id} file={file} />
			))}
		</ul>
	);
}

/** One stored message of a room. Memoized: it redraws only when the message or its look changes. */
export const MessageRow = memo(function MessageRow(props: {
	message: RoomMessage;
	/** The author's character, from the room list; none for an agent the list does not have. */
	character: CharacterSpec | undefined;
	/** Show the author's name and picture: the author changed, or a pause came. */
	header: boolean;
	/** The message arrived while the room was open, so it slides in. */
	enter: boolean;
	timeZone: string;
	/** The room takes a reply, so a message can be quoted into its box. */
	quotable: boolean;
}) {
	const { message } = props;
	const surface = useContext(ConfigContext)?.app?.surface;
	const press = useMenuPress(
		(source) => messageMenu(message, source, props.quotable),
		{ selectable: true },
	);
	const agent = message.agent;
	const avatarPress = useMenuPress(() =>
		agent ? avatarMenu(agent, message.author) : undefined,
	);
	if (message.kind === "system") {
		const line = systemLine(message.text);
		// The start line of a dispatch thread links the thread's room.
		const linked = hasThreadLink(message.text, surface);
		return (
			<li className="line" data-enter={props.enter || undefined}>
				<Icon name={linked ? "conversations" : line.icon} size={14} />
				{linked ? (
					<MessageMarkdown source={message.text} />
				) : (
					<span>{line.text}</span>
				)}
			</li>
		);
	}
	const mine = message.kind === "owner";
	return (
		<li
			{...press}
			className="message"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a message takes focus so the Menu key can open its menu
			tabIndex={0}
			data-mine={mine || undefined}
			data-header={props.header || undefined}
			data-enter={props.enter || undefined}
		>
			{mine ? null : (
				<span
					className="message-avatar"
					{...(props.header && agent ? avatarPress : {})}
				>
					{props.header ? (
						<PageCharacter
							spec={props.character}
							name={message.agent ?? message.author}
							size={32}
							live={false}
						/>
					) : null}
				</span>
			)}
			<div className="message-main">
				{props.header ? (
					<div className="message-meta">
						<strong>{message.author}</strong>
						<time dateTime={message.at}>
							{clock(message.at, props.timeZone)}
						</time>
					</div>
				) : null}
				<div className="bubble">
					{message.text ? <MessageMarkdown source={message.text} /> : null}
					<Files files={message.files} />
				</div>
			</div>
		</li>
	);
});

/** A message of an agent still being written; the final reply replaces it. */
export const LiveRow = memo(function LiveRow(props: {
	message: RoomMessage;
	character: CharacterSpec | undefined;
}) {
	const { message } = props;
	return (
		<li className="message" data-header="true" data-live="true">
			<span className="message-avatar">
				<PageCharacter
					spec={props.character}
					name={message.agent ?? message.author}
					size={32}
					live={false}
				/>
			</span>
			<div className="message-main">
				<div className="message-meta">
					<strong>{message.author}</strong>
				</div>
				<div className="bubble">
					<MessageMarkdown source={message.text} />
				</div>
			</div>
		</li>
	);
});

/** How long a message may wait for the server before the page says it is not sent yet. */
const SLOW_SEND_MS = 10_000;

/** A message the person just sent that the server has not taken yet, or refused. */
export const PendingRow = memo(function PendingRow(props: {
	pending: PendingSend;
}) {
	const { pending } = props;
	const connection = useConnection();
	const offline = useSelector((state) => state.connection !== "open");
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		if (pending.failed) return;
		const timer = setTimeout(() => setSlow(true), SLOW_SEND_MS);
		return () => clearTimeout(timer);
	}, [pending.failed]);
	const stuck = Boolean(pending.failed) || slow;
	return (
		<li
			className="message"
			data-mine="true"
			data-header="true"
			data-pending={pending.failed ? "failed" : "sending"}
		>
			<div className="message-main">
				<div className="bubble">
					{pending.text ? <MessageMarkdown source={pending.text} /> : null}
					{pending.files.length ? (
						<ul className="files">
							{pending.files.map((file) => (
								<li key={file.id}>
									<span className="file-chip">
										<Icon name="file" size={16} />
										<span>{file.name}</span>
									</span>
								</li>
							))}
						</ul>
					) : null}
				</div>
				{stuck ? (
					<div className="message-meta pending-actions">
						<span className="failure-text">
							{pending.failed ? t("Not sent") : t("Not sent yet")}
						</span>
						<button
							type="button"
							className="link-button"
							onClick={() => connection.retry(pending)}
						>
							{t("Try again")}
						</button>
						<button
							type="button"
							className="link-button"
							onClick={() =>
								store.dispatch({ type: "pending_dropped", id: pending.id })
							}
						>
							{t("Discard")}
						</button>
					</div>
				) : (
					<div className="message-meta pending-actions">
						<span className="pending-note">
							{offline ? t("Waiting to send…") : t("Sending…")}
						</span>
					</div>
				)}
			</div>
		</li>
	);
});
