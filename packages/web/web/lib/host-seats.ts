import { useContext, useEffect, useRef } from "react";
import type { RoomView } from "../../src/api-types.ts";
import type { HostRoomSummaryView } from "../../src/host/views.ts";
import { useSelector } from "./app-store.ts";
import { ConfigContext } from "./config.ts";
import { hostApi } from "./host-api.ts";
import { useHost } from "./host-state.ts";
import { signal } from "./signal.ts";
import { useConnection } from "./socket.ts";

// What the round table seats for a person who is not an owner. The agent rooms are the owners', so
// their table seats the host rooms they may open: each kind's own list, which is the room list's
// access and no rule of the table's. A seat is a room, not an agent; its state comes from the
// room's own frames, which reach the socket only once the person has subscribed to a room they may read.

/** The most seats the scene draws before its "+N" podium; only these rooms are followed. */
export const SEATS_SHOWN = 12;

interface HostSeats {
	/** The rooms of the kinds' lists, newest first, as the table's roster takes them. */
	views: RoomView[];
	/** The rooms whose list entry says they ask for something, by room key. */
	attention: Readonly<Record<string, true>>;
	/** The kinds' lists were fetched at least once. */
	loaded: boolean;
}

const NONE: HostSeats = { views: [], attention: {}, loaded: false };
let seats: HostSeats = NONE;
const { emit, use } = signal();

/** The seats of the host rooms the person may list; empty until `useHostSeatsSync` has fetched them. */
export const useHostSeats = (): HostSeats => use(() => seats);

/** Forgets the seats, as a test or a new session starts over. */
export function resetHostSeats(): void {
	seats = NONE;
	emit();
}

/** Whether the visitor is served the table as a person of a tier below the owners: the config says a tier only where more than owners are admitted. */
export function useHostedTable(): boolean {
	const tier = useContext(ConfigContext)?.tier;
	return tier !== undefined && tier !== "owner";
}

/** Whether the table seats host rooms: a person below the owners always does, an owner where the host has kinds of room to list. */
export function useSeatsHostRooms(): boolean {
	const config = useContext(ConfigContext);
	return useHostedTable() || (config?.kinds?.length ?? 0) > 0;
}

/** A host room as a seat: the room's key is its name's home, and its title is the plate. */
function viewOf(room: HostRoomSummaryView, kind: string): RoomView {
	return {
		key: room.key,
		kind: "agent",
		name: `${kind}.${room.id}`,
		displayName: room.title,
		home: false,
		readOnly: false,
		mode: { yolo: false, longRunning: false },
		typing: false,
		stoppable: false,
	};
}

const ATTENDED = (room: HostRoomSummaryView) => room.attention === true;

/** Newest first; a room that has never had a message sits after those that have. */
const byNewest = (a: HostRoomSummaryView, b: HostRoomSummaryView): number =>
	(b.lastAt ?? "").localeCompare(a.lastAt ?? "");

/**
 * Fetches the first page of every kind's list, as the room list does, and seats what came back. A kind
 * whose list fails is left out and the others still seat.
 */
async function fetchSeats(kinds: readonly string[]): Promise<HostSeats> {
	const lists = await Promise.allSettled(
		kinds.map((kind) => hostApi.list(kind)),
	);
	const rooms: { room: HostRoomSummaryView; kind: string }[] = [];
	lists.forEach((list, at) => {
		const kind = kinds[at];
		if (list.status !== "fulfilled" || kind === undefined) return;
		for (const room of list.value.rooms) rooms.push({ room, kind });
	});
	rooms.sort((a, b) => byNewest(a.room, b.room));
	const attention: Record<string, true> = {};
	for (const { room } of rooms) if (ATTENDED(room)) attention[room.key] = true;
	return {
		views: rooms.map(({ room, kind }) => viewOf(room, kind)),
		attention,
		loaded: true,
	};
}

/**
 * Keeps the seats of a hosted table: fetches the kinds' lists as the table opens, after a reconnect
 * and whenever the host says a list may differ, and follows the rooms of the seats the scene draws,
 * so their activity reaches the page. The server answers a follow only for a room the person may
 * read now; a room that was refused or later closed to them sends nothing.
 */
export function useHostSeatsSync(kinds: readonly string[]): void {
	const connection = useConnection();
	const connects = useSelector((state) => state.connects);
	const changed = useHost((state) => state.lists);
	const asked = useRef(0);
	const taken = useRef(0);
	const wanted = kinds.join("\n");
	const { views } = useHostSeats();
	// biome-ignore lint/correctness/useExhaustiveDependencies: the kinds, the connection count and the lists' change counters say when to fetch
	useEffect(() => {
		asked.current += 1;
		const request = asked.current;
		let current = true;
		void fetchSeats(wanted === "" ? [] : wanted.split("\n")).then((next) => {
			if (!current || request < taken.current) return;
			taken.current = request;
			seats = next;
			emit();
		});
		return () => {
			current = false;
		};
	}, [wanted, connects, changed]);
	const followed = views
		.slice(0, SEATS_SHOWN)
		.map((view) => view.key)
		.join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new connection must follow again
	useEffect(() => {
		const keys = followed === "" ? [] : followed.split("\n");
		for (const room of keys) connection.send({ type: "subscribe", room });
		return () => {
			for (const room of keys) connection.send({ type: "unsubscribe", room });
		};
	}, [connection, followed, connects]);
}
