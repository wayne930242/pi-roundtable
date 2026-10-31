import type { CharacterSpec } from "pi-roundtable/characters";
import { lazy, memo, Suspense, useContext, useEffect, useState } from "react";
import {
	HELPERS_ENDED,
	isStartOver,
	type RoomFile,
	type RoomMessage,
} from "../../src/api-types.ts";
import { store, useSelector } from "../lib/app-store.ts";
import { ConfigContext } from "../lib/config.ts";
import { clock } from "../lib/format.ts";
import { useMenuPress } from "../lib/menu-press.ts";
import { avatarMenuOf, messageMenuOf } from "../lib/menus.ts";
import { translate as t } from "../lib/messages.ts";
import type { PendingSend } from "../lib/rooms.ts";
import { useConnection } from "../lib/socket.ts";
import { PageCharacter } from "./character.tsx";
import { Icon } from "./icons.tsx";
import { hasThreadLink, MessageMarkdown } from "./message-markdown.tsx";

// An internal note's row and its styles, a knight's line that it archived its temp knights, and a
// message between agents, are read when the first is shown.
const NoteRow = lazy(() => import("./note-row.tsx"));

// The line where a conversation started over, and its styles, are read when the first is shown.
const StartOverLine = lazy(() => import("./start-over-line.tsx"));

// Another owner's picture, and the styles it brings, are read when a room shows one.
const OwnerPicture = lazy(() =>
	import("./host-picture.tsx").then((m) => ({ default: m.HostPicture })),
);

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

/**
 * Whether the viewer wrote an owner message: its author's principal is theirs. A message stored
 * without one (an old row) is the viewer's only where one person reads the room; where several do,
 * it belongs to an owner nobody can name, never to the viewer.
 */
function isMine(
	message: RoomMessage,
	me: string | undefined,
	shared: boolean,
): boolean {
	if (message.kind !== "owner") return false;
	if (message.principalId === undefined) return !shared;
	return message.principalId === me;
}

// A message's attachments, their block and the jump to it, with their styles, are read when a
// message with files is shown.
const Attachments = lazy(() => import("./attachments.tsx"));
const AttachmentsJump = lazy(() =>
	import("./attachments.tsx").then((m) => ({ default: m.AttachmentsJump })),
);

/** A message's files, as the one block every message shows them in. */
export function Files(props: {
	files: readonly RoomFile[];
	/** The stored message they belong to, for downloading them all together. */
	message?: Pick<RoomMessage, "room" | "id">;
}) {
	if (props.files.length === 0) return null;
	return (
		<Suspense fallback={<section className="attachments" />}>
			<Attachments {...props} />
		</Suspense>
	);
}

/** The line at the top of a long bubble that jumps to its files; nothing without files. */
export function FilesJump({ files }: { files: readonly RoomFile[] }) {
	if (files.length === 0) return null;
	return (
		<Suspense fallback={null}>
			<AttachmentsJump count={files.length} />
		</Suspense>
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
	/** The message was unread as the room opened or arrived out of sight: it wears a frame until seen. */
	unread?: boolean;
	timeZone: string;
	/** The room takes a reply, so a message can be quoted into its box. */
	quotable: boolean;
}) {
	const { message } = props;
	const surface = useContext(ConfigContext)?.app?.surface;
	const me = useSelector((state) => state.principal?.id);
	const shared = useSelector(
		(state) => state.rooms[message.room]?.view?.notes === true,
	);
	const press = useMenuPress(
		(source) => messageMenuOf(message, source, props.quotable),
		{ selectable: true },
	);
	const agent = message.agent;
	const avatarPress = useMenuPress(() =>
		agent ? avatarMenuOf(agent, message.author) : Promise.resolve(undefined),
	);
	if (
		message.note ||
		message.intercom ||
		(message.kind === "system" && message.text.startsWith(HELPERS_ENDED))
	)
		return (
			<Suspense fallback={<li className="message" data-header />}>
				<NoteRow
					message={message}
					enter={props.enter}
					timeZone={props.timeZone}
				/>
			</Suspense>
		);
	if (isStartOver(message))
		return (
			<Suspense fallback={<li className="line" />}>
				<StartOverLine message={message} enter={props.enter} />
			</Suspense>
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
	const mine = isMine(message, me, shared);
	const owner = message.kind === "owner";
	return (
		<li
			{...press}
			className="message"
			data-mid={message.id}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a message takes focus so the Menu key can open its menu
			tabIndex={0}
			data-mine={mine || undefined}
			data-header={props.header || undefined}
			data-enter={props.enter || undefined}
			data-unread={props.unread || undefined}
		>
			{mine ? null : (
				<span
					className="message-avatar"
					{...(props.header && agent ? avatarPress : {})}
				>
					{props.header ? (
						owner ? (
							<Suspense fallback={null}>
								<OwnerPicture
									picture={
										message.principalId === undefined
											? undefined
											: { principal: message.principalId }
									}
									name={message.author}
								/>
							</Suspense>
						) : (
							<PageCharacter
								spec={props.character}
								name={message.agent ?? message.author}
								size={32}
								live={false}
							/>
						)
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
					<FilesJump files={message.files} />
					{message.text ? <MessageMarkdown source={message.text} /> : null}
					<Files files={message.files} message={message} />
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
