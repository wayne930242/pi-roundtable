import { useEffect, useState } from "react";
import type { RoomMessage } from "../../src/api-types.ts";
import { messageOf } from "../lib/api.ts";
import { useCharacters } from "../lib/characters.ts";
import { useConfig } from "../lib/config.ts";
import { installStyle } from "../lib/lazy-style.ts";
import {
	archivedApi,
	closeArchived,
	useArchived,
} from "../lib/message-sheets.ts";
import { translate as t } from "../lib/messages.ts";
import { MessageRow } from "./message-row.tsx";
import { Sheet } from "./sheet.tsx";
import { Empty, Failure, Loading } from "./states.tsx";

/** A pause this long between two messages of one author shows the author again. */
const PAUSE_MS = 5 * 60_000;

/**
 * The conversation a start-over archived, read only: the room's messages from the start-over
 * before it up to the line that ended it, newest page first, with earlier pages on request.
 */
export function ArchivedSheetHost() {
	const ask = useArchived();
	const [shown, setShown] = useState(ask);
	if (ask && ask !== shown) setShown(ask);
	if (!shown) return null;
	return (
		<Sheet
			open={ask !== undefined}
			title={t("Archived conversation")}
			size="wide"
			onClose={closeArchived}
		>
			<ArchivedLog
				key={`${shown.room}:${shown.until}`}
				room={shown.room}
				until={shown.until}
			/>
		</Sheet>
	);
}

function ArchivedLog(props: { room: string; until: number }) {
	installStyle("archived-log", ".archived-log .messages { padding: 0; }");
	const { timeZone } = useConfig();
	const characters = useCharacters();
	const [messages, setMessages] = useState<RoomMessage[]>();
	const [more, setMore] = useState(false);
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const { room, until } = props;

	useEffect(() => {
		let current = true;
		archivedApi.page(room, until).then(
			(page) => {
				if (!current) return;
				setMessages(page.messages);
				setMore(page.more);
			},
			(failure) => {
				if (current) setError(messageOf(failure));
			},
		);
		return () => {
			current = false;
		};
	}, [room, until]);

	const older = async () => {
		const first = messages?.[0];
		if (!first || loading) return;
		setLoading(true);
		try {
			const page = await archivedApi.page(room, until, first.id);
			setMessages((held) => [...page.messages, ...(held ?? [])]);
			setMore(page.more);
		} catch (failure) {
			setError(messageOf(failure));
		}
		setLoading(false);
	};

	if (error) return <Failure message={error} />;
	if (!messages) return <Loading />;
	if (messages.length === 0)
		return <Empty>{t("The archived conversation has no messages.")}</Empty>;
	return (
		<div className="archived-log">
			{more ? (
				<button
					type="button"
					className="secondary older"
					disabled={loading}
					onClick={older}
				>
					{loading ? t("Loading…") : t("Load earlier messages")}
				</button>
			) : null}
			<ol className="messages">
				{messages.map((message, index) => {
					const before = messages[index - 1];
					const header =
						!before ||
						before.kind !== message.kind ||
						before.author !== message.author ||
						Date.parse(message.at) - Date.parse(before.at) > PAUSE_MS;
					return (
						<MessageRow
							key={message.id}
							message={message}
							character={message.agent ? characters[message.agent] : undefined}
							header={header}
							enter={false}
							unread={false}
							timeZone={timeZone}
							quotable={false}
						/>
					);
				})}
			</ol>
		</div>
	);
}
