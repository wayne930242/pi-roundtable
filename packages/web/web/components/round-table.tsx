import type { CharacterSpec } from "pi-roundtable/characters";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { useSelector } from "../lib/app-store.ts";
import { suggestionFor } from "../lib/character-spec.ts";
import { useCharacters, useRoomStates } from "../lib/characters.ts";
import { useHostedTable, useHostSeats } from "../lib/host-seats.ts";
import { useKit } from "../lib/kit.ts";
import { useCharacterStyle, useLook } from "../lib/look.ts";
import { useMedia } from "../lib/media.ts";
import { translate as t, wording } from "../lib/messages.ts";
import { navigate } from "../lib/router.ts";
import {
	createExpressionSwaps,
	type ExpressionSwaps,
	type GroupRound,
	seatedAtTable,
	seatPicture,
	seatStates,
	seatUid,
} from "../lib/seats.ts";
import { useSkins } from "../lib/skins.ts";
import type {
	SeatInit,
	SeatMenuRequest,
	SeatState,
	TableHandle,
	TableLabels,
} from "../table/entry.ts";

const SEAT_STATE_LABELS: Record<SeatState, string> = {
	idle: wording("idle"),
	thinking: wording("thinking"),
	working: wording("working"),
	waiting: wording("waiting"),
	speaking: wording("speaking"),
	done: wording("done"),
	error: wording("error"),
};

/** What the table says to a screen reader, in the page's words. */
const tableLabels = (): TableLabels => ({
	table: t("Round table"),
	seat: (name, state) =>
		t("{name} ({state})", { name, state: t(SEAT_STATE_LABELS[state]) }),
});

/** More seats than this on a phone held upright are also listed as buttons: the pictures get small. */
const LIST_ABOVE = 10;

/**
 * The agents of the room list, the coordinator first; only `members` of them when the table is a
 * group's. The owner's own table seats the agents whose room is not muted; `all` lists the muted ones
 * too, for the sheet that says who sits. A group's members sit whether muted or not. A person below
 * the owners has no agent rooms: the rooms their kinds list, newest first, sit instead.
 */
export function useRoster(
	members: readonly string[] | undefined,
	options: { all?: boolean } = {},
): RoomView[] {
	const all = options.all === true;
	const hosted = useHostedTable();
	const { views: hostRooms } = useHostSeats();
	const owned = useSelector(
		(state) => {
			const agents = state.order
				.map((key) => state.rooms[key]?.view)
				.filter(
					(view): view is RoomView =>
						view !== undefined && view.kind === "agent",
				);
			const seated = members
				? members
						.map((name) => agents.find((view) => view.name === name))
						.filter((view): view is RoomView => view !== undefined)
				: agents;
			const sitting = members || all ? seated : seatedAtTable(seated);
			return [...sitting].sort((a, b) => Number(b.home) - Number(a.home));
		},
		`${all}\n${members?.join("\n") ?? ""}`,
	);
	return hosted ? hostRooms : owned;
}

/** Every agent of the room list, seated or not. */
export const useAgents = (): RoomView[] => useRoster(undefined, { all: true });

/** The rounds of the group rooms that count for this table: one group's, or every group's. */
function useRounds(groupRoom: string | undefined): GroupRound[] {
	return useSelector(
		(state) =>
			Object.values(state.rooms)
				.filter((room) =>
					groupRoom ? room.key === groupRoom : room.view?.kind === "group",
				)
				.map((room) => ({
					typing: room.typing,
					...(room.agent === undefined ? {} : { agent: room.agent }),
				})),
		groupRoom ?? "",
	);
}

export interface RoundTableProps {
	/** Only these agents (by name) sit; every agent of the list when absent. */
	members?: readonly string[];
	/** The group room whose speaker is lit; any group's when absent. */
	groupRoom?: string;
	variant?: "full" | "compact";
	/** List the seats as buttons under the table, as a table in a narrow panel or sheet does. */
	list?: boolean;
	/** Receives the table's handle once it is mounted, and `undefined` when it goes. */
	onHandle?(handle: TableHandle | undefined): void;
	/** The agent (by name) the camera is on; the whole ring when null or absent. The scene turns to follow it. */
	focus?: string | null;
	/** The person turned the camera (a zoom, a swipe in a close-up): the agent it is on now, or null for the whole ring. */
	onFocus?(name: string | null): void;
	/** A seat was tapped; by default the page opens the agent's room. */
	onSeat?(name: string): void;
	/** A seat was held, right-clicked or given the Menu key; by default it has no menu. */
	onSeatMenu?(request: SeatMenuRequest): void;
	/** The "+N" podium was tapped. */
	onMore?(): void;
	/** The owner's own podium carries this name. */
	ownerName?: string;
}

/**
 * The round table of the agents: the seats' pictures are composed on the page and handed over as
 * the character kit draws them, each seat's state comes from the same rules as the room list, and
 * a seat's picture is redrawn when its face changes. The scene is a lazy chunk of its own.
 */
export function RoundTable(props: RoundTableProps) {
	const { variant = "full", onHandle } = props;
	const kit = useKit();
	const look = useLook();
	const style = useCharacterStyle();
	const skins = useSkins();
	const characters = useCharacters();
	const roster = useRoster(props.members);
	const agentStates = useRoomStates(roster.map((view) => view.key));
	const rounds = useRounds(props.groupRoom);
	const attention = useHostSeats().attention;
	const upright = useMedia("(orientation: portrait)");
	const listBelow =
		variant === "full" &&
		(props.list === true || (upright && roster.length > LIST_ABOVE));

	const states = useMemo(
		() =>
			seatStates(
				Object.fromEntries(
					roster.map((view) => {
						const state = agentStates[view.key] ?? "idle";
						// A hosted room's list entry says it asks for something, which only an idle seat shows.
						return [
							view.name,
							attention[view.key] && (state === "idle" || state === "sleepy")
								? "waiting"
								: state,
						];
					}),
				),
				rounds,
			),
		[roster, agentStates, rounds, attention],
	);
	const statesRef = useRef(states);
	statesRef.current = states;

	/** The seats without their states: the pictures follow the character, the look and the scheme, not what an agent does. */
	const seats = useMemo<SeatInit[]>(() => {
		if (!kit) return [];
		return roster.map((view, index) => {
			const spec: CharacterSpec =
				characters[view.name] ?? view.character ?? suggestionFor(kit, view);
			return {
				id: view.name,
				name: view.displayName,
				color: kit.accentOf(spec, style.look),
				avatarSvg: seatPicture(
					kit,
					spec,
					style.look,
					statesRef.current[view.name] ?? "idle",
					seatUid(index, view.name),
					skins,
				),
			};
		});
	}, [kit, roster, characters, style.look, skins]);
	const seatsRef = useRef(seats);
	seatsRef.current = seats;
	const rosterRef = useRef(roster);
	rosterRef.current = roster;
	const optionsRef = useRef({ look, scheme: style.scheme });
	optionsRef.current = { look, scheme: style.scheme };

	const host = useRef<HTMLDivElement>(null);
	const handle = useRef<TableHandle | undefined>(undefined);
	const [mounted, setMounted] = useState(0);
	const swaps = useRef<ExpressionSwaps | undefined>(undefined);
	const specOf = useRef<(name: string) => CharacterSpec | undefined>(
		() => undefined,
	);
	specOf.current = (name) => {
		const view = roster.find((one) => one.name === name);
		if (!kit || !view) return undefined;
		return characters[name] ?? view.character ?? suggestionFor(kit, view);
	};
	const styleRef = useRef(style);
	styleRef.current = style;
	const skinsRef = useRef(skins);
	skinsRef.current = skins;
	const kitRef = useRef(kit);
	kitRef.current = kit;
	const onHandleRef = useRef(onHandle);
	onHandleRef.current = onHandle;
	const latest = useRef(props);
	latest.current = props;

	const ready = kit !== undefined && seats.length > 0;
	// The scene mounts once there is something to seat, and again when its shape changes.
	useEffect(() => {
		const element = host.current;
		if (!ready || !element) return;
		let current = true;
		let table: TableHandle | undefined;
		const exchange = createExpressionSwaps({
			setAvatar: (id, state) => {
				const spec = specOf.current(id);
				const kitNow = kitRef.current;
				const index = rosterRef.current.findIndex((view) => view.name === id);
				if (!spec || !kitNow || index < 0) return;
				void table?.setAvatar(
					id,
					seatPicture(
						kitNow,
						spec,
						styleRef.current.look,
						state,
						seatUid(index, id),
						skinsRef.current,
					),
				);
			},
		});
		swaps.current = exchange;
		void (async () => {
			const { mountRoundTable } = await import("../table/entry.ts");
			const first = seatsRef.current.map((seat) => ({
				...seat,
				state: statesRef.current[seat.id] ?? "idle",
			}));
			const made = await mountRoundTable(element, {
				theme: optionsRef.current.look,
				scheme: optionsRef.current.scheme,
				seats: first,
				onSeatClick: ({ id }) => {
					const seat = latest.current.onSeat;
					if (seat) {
						seat(id);
						return;
					}
					const view = rosterRef.current.find((one) => one.name === id);
					if (view) navigate("room", view.key);
				},
				...(latest.current.onSeatMenu
					? { onSeatMenu: (request) => latest.current.onSeatMenu?.(request) }
					: {}),
				ownerName: latest.current.ownerName ?? t("You"),
				focus: latest.current.focus ?? null,
				onFocus: (id) => latest.current.onFocus?.(id),
				onMore: () => latest.current.onMore?.(),
				reducedMotion: "auto",
				lowPower: "auto",
				variant,
				listBelow,
				labels: tableLabels(),
			});
			if (!current) {
				made.dispose();
				return;
			}
			table = made;
			handle.current = made;
			for (const seat of first) exchange.seed(seat.id, seat.state ?? "idle");
			onHandleRef.current?.(made);
			setMounted((count) => count + 1);
		})();
		return () => {
			current = false;
			exchange.dispose();
			swaps.current = undefined;
			handle.current = undefined;
			onHandleRef.current?.(undefined);
			table?.dispose();
		};
	}, [ready, variant, listBelow]);

	// The page names the agent the camera is on: the scene turns to it, or back to the whole ring.
	const wanted = props.focus ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `mounted` says the handle exists
	useEffect(() => {
		const table = handle.current;
		if (table && table.focused() !== wanted) table.focus(wanted);
	}, [wanted, mounted]);

	// A new roster, character, look or scheme: the pictures are drawn again and the swaps start over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `mounted` says the handle exists
	useEffect(() => {
		const table = handle.current;
		if (!table || seats.length === 0) return;
		const current = statesRef.current;
		table.setSeats(
			seats.map((seat) => ({ ...seat, state: current[seat.id] ?? "idle" })),
		);
		for (const seat of seats)
			swaps.current?.seed(seat.id, current[seat.id] ?? "idle");
	}, [seats, mounted]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `mounted` says the handle exists, which may be after the theme changed
	useEffect(() => {
		const table = handle.current;
		if (table) table.setTheme(look, style.scheme);
	}, [look, style.scheme, mounted]);

	// A state change moves the seat now, and its face after the swap's delay.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `mounted` says the handle exists
	useEffect(() => {
		const table = handle.current;
		if (!table) return;
		for (const seat of seatsRef.current) {
			const state = states[seat.id] ?? "idle";
			table.setState(seat.id, state);
			swaps.current?.update(seat.id, state);
		}
	}, [states, mounted]);

	if (roster.length === 0)
		return <p className="table-empty">{t("No agents are seated yet.")}</p>;
	return (
		<section className="table-host" ref={host} aria-label={t("Round table")} />
	);
}
