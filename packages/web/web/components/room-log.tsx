import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { RoomMessage } from "../../src/api-types.ts";
import { api, messageOf } from "../lib/api.ts";
import { store, useSelector } from "../lib/app-store.ts";
import { useCharacters } from "../lib/characters.ts";
import { useConfig } from "../lib/config.ts";
import { dayKey, dayLabel } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { ROOM_PAGE, type TimelineItem, timeline } from "../lib/rooms.ts";
import { toast } from "../lib/toast.ts";
import { PromptCard } from "./cards.tsx";
import { LiveRow, MessageRow, PendingRow } from "./message-row.tsx";

/** A pause this long between two messages of one author shows the author again. */
const PAUSE_MS = 5 * 60_000;

/**
 * Fetches a room's latest page on opening and after every reconnect, to be merged with what frames
 * brought. `loaded` turns true with the first page; `error` says why it could not.
 */
export function useRoomHistory(roomKey: string): {
	loaded: boolean;
	error: string | undefined;
} {
	const connects = useSelector((state) => state.connects);
	const [error, setError] = useState<string>();
	const [loaded, setLoaded] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the room and the connection count say when to fetch
	useEffect(() => {
		let current = true;
		api.messages(roomKey, undefined, ROOM_PAGE).then(
			(page) => {
				if (!current) return;
				store.dispatch({
					type: "history_loaded",
					room: roomKey,
					messages: page.messages,
					more: page.more,
					cards: page.cards,
					older: false,
				});
				setError(undefined);
				setLoaded(true);
			},
			(failure) => {
				if (current) setError(messageOf(failure));
			},
		);
		return () => {
			current = false;
		};
	}, [roomKey, connects]);
	return { loaded, error };
}

/** Fetches the page of messages older than the room's first one. */
export async function loadOlderMessages(roomKey: string): Promise<boolean> {
	const first = store.getState().rooms[roomKey]?.messages[0];
	if (!first) return false;
	try {
		const page = await api.messages(roomKey, first.id, ROOM_PAGE);
		store.dispatch({
			type: "history_loaded",
			room: roomKey,
			messages: page.messages,
			more: page.more,
			cards: page.cards,
			older: true,
		});
		return true;
	} catch (failure) {
		toast(messageOf(failure), "danger");
		return false;
	}
}

/** What a room's log adds around its messages: a divider before one, marks after one, or the message itself drawn another way. */
export interface RowDecor {
	before?(message: RoomMessage): ReactNode;
	after?(message: RoomMessage): ReactNode;
	/** Whether a message wears the unread frame. */
	unread?(message: RoomMessage): boolean;
	message?(
		message: RoomMessage,
		look: {
			header: boolean;
			enter: boolean;
			unread: boolean;
			timeZone: string;
		},
	): ReactNode;
}

interface Row {
	item: TimelineItem;
	header: boolean;
	day: string | undefined;
}

const headerOf = (message: RoomMessage, before: RoomMessage | undefined) =>
	!before ||
	before.kind !== message.kind ||
	before.author !== message.author ||
	Date.parse(message.at) - Date.parse(before.at) > PAUSE_MS;

/** The timeline with, for each stored message, whether it shows its author and whether a new day starts at it. */
function useRows(items: TimelineItem[], timeZone: string, now: number): Row[] {
	return useMemo(() => {
		let before: RoomMessage | undefined;
		let lastDay: string | undefined;
		return items.map((item) => {
			if (item.kind !== "message")
				return { item, header: true, day: undefined };
			const day = dayKey(item.message.at, timeZone);
			const starts =
				day !== lastDay ? dayLabel(item.message.at, now, timeZone) : undefined;
			lastDay = day;
			const header = headerOf(item.message, before) || starts !== undefined;
			before = item.message;
			return { item, header, day: starts };
		});
	}, [items, timeZone, now]);
}

/** A message with the day's label above it when a new day starts there. */
function RowFragment(props: {
	day: string | undefined;
	children: React.ReactNode;
}) {
	return (
		<>
			{props.day ? (
				<li className="day" aria-hidden="true">
					<span>{props.day}</span>
				</li>
			) : null}
			{props.children}
		</>
	);
}

/**
 * The room's messages, cards and the turn in progress, as the room's own page lists them. The scene's
 * history sheet shows the same list, so a card answered there is the card answered in the room.
 */
export function RoomLog(props: {
	roomKey: string;
	/** Messages with an id above this slide in; those present when the room opened do not. */
	enterAfter: number | undefined;
	quotable: boolean;
	decor?: RowDecor;
}) {
	const config = useConfig();
	const { now } = useLive();
	const parts = useSelector((state) => ({
		rooms: state.rooms,
		cards: state.cards,
		cardOrder: state.cardOrder,
	}));
	const characters = useCharacters();
	const items = useMemo(
		() => timeline(parts, props.roomKey),
		[parts, props.roomKey],
	);
	const rows = useRows(items, config.timeZone, now);
	return (
		<ol className="messages">
			{rows.map((row) => {
				switch (row.item.kind) {
					case "message":
						return (
							<RowFragment key={`m${row.item.message.id}`} day={row.day}>
								{props.decor?.before?.(row.item.message)}
								{props.decor?.message?.(row.item.message, {
									header: row.header,
									enter:
										props.enterAfter !== undefined &&
										row.item.message.id > props.enterAfter,
									unread: props.decor?.unread?.(row.item.message) ?? false,
									timeZone: config.timeZone,
								}) ?? (
									<MessageRow
										message={row.item.message}
										character={
											row.item.message.agent
												? characters[row.item.message.agent]
												: undefined
										}
										header={row.header}
										enter={
											props.enterAfter !== undefined &&
											row.item.message.id > props.enterAfter
										}
										unread={props.decor?.unread?.(row.item.message) ?? false}
										timeZone={config.timeZone}
										quotable={props.quotable}
									/>
								)}
								{props.decor?.after?.(row.item.message)}
							</RowFragment>
						);
					case "card":
						return (
							<li key={`c${row.item.id}`} className="slot" data-enter>
								<PromptCard card={row.item.card} timeZone={config.timeZone} />
							</li>
						);
					case "pending":
						return (
							<PendingRow
								key={`p${row.item.pending.id}`}
								pending={row.item.pending}
							/>
						);
					case "live":
						return (
							<LiveRow
								key={`l${row.item.message.live}`}
								message={row.item.message}
								character={
									row.item.message.agent
										? characters[row.item.message.agent]
										: undefined
								}
							/>
						);
					default:
						return null;
				}
			})}
		</ol>
	);
}
