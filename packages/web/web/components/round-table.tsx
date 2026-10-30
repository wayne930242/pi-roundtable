import type { CharacterSpec } from "pi-roundtable/characters";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { useSelector } from "../lib/app-store.ts";
import { suggestionFor } from "../lib/character-spec.ts";
import { useCharacters, useRoomStates } from "../lib/characters.ts";
import { hostUi } from "../lib/frame-taps.ts";
import { useHostedTable, useHostSeats } from "../lib/host-seats.ts";
import { useKit } from "../lib/kit.ts";
import { useCharacterStyle, useLook } from "../lib/look.ts";
import { translate as t, wording } from "../lib/messages.ts";
import { marksOf, speakerOfRound } from "../lib/round-view.ts";
import { navigate } from "../lib/router.ts";
import { cancelDive, diveInto } from "../lib/seat-dive.ts";
import {
	createExpressionSwaps,
	type ExpressionSwaps,
	type GroupRound,
	seatPicture,
	seatStates,
	seatUid,
} from "../lib/seats.ts";
import { useSkins } from "../lib/skins.ts";
import { MAX_SEATED } from "../table/camera.ts";
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

/** A host's room page loads on demand; the dive starts it so the room is there when the zoom ends. */
const warmHostRooms = (): void => {
	hostUi().catch(() => undefined);
};

/**
 * The agents of the room list, the coordinator first, as `RoomView`s. Who sits is not mute's say:
 * an owner's table seats `members` (a council's), or the first agents of the list when no members
 * are named, and never more than the ring holds. A person below the owners has no agent rooms: the
 * rooms their kinds list, newest first, sit instead.
 */
export function useRoster(members: readonly string[] | undefined): RoomView[] {
	const hosted = useHostedTable();
	const { views: hostRooms } = useHostSeats();
	const owned = useSelector((state) => {
		const agents = state.order
			.map((key) => state.rooms[key]?.view)
			.filter(
				(view): view is RoomView => view !== undefined && view.kind === "agent",
			);
		const seated = members
			? members
					.slice(0, MAX_SEATED)
					.map((name) => agents.find((view) => view.name === name))
					.filter((view): view is RoomView => view !== undefined)
			: agents;
		return [...seated]
			.sort((a, b) => Number(b.home) - Number(a.home))
			.slice(0, MAX_SEATED);
	}, members?.join("\n") ?? "");
	return hosted ? hostRooms.slice(0, MAX_SEATED) : owned;
}

/** Every agent of the room list, in its order: whom a council can be made of. */
export function useAgents(): RoomView[] {
	return useSelector(
		(state) =>
			state.order
				.map((key) => state.rooms[key]?.view)
				.filter(
					(view): view is RoomView =>
						view !== undefined && view.kind === "agent",
				),
		"agents",
	);
}

/**
 * The rounds of the group rooms that count for this table: one group's, or every group's. The member
 * a running round says speaks is the speaker, since the room's `agent` only names the author of the
 * last reply.
 */
function useRounds(groupRoom: string | undefined): GroupRound[] {
	return useSelector(
		(state) =>
			Object.values(state.rooms)
				.filter((room) =>
					groupRoom ? room.key === groupRoom : room.view?.kind === "group",
				)
				.map((room) => {
					const speaking = speakerOfRound(room.round);
					const agent = speaking ?? room.agent;
					return {
						typing: room.typing || speaking !== undefined,
						...(agent === undefined ? {} : { agent }),
					};
				}),
		groupRoom ?? "",
	);
}

/** The signs the seats of a group's table wear for its round: who has spoken, who is next. */
function useRoundMarks(
	groupRoom: string | undefined,
): Readonly<Record<string, string>> {
	return useSelector(
		(state) => marksOf(groupRoom ? state.rooms[groupRoom]?.round : undefined),
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
	/** A seat was tapped; by default the page dives into the agent's room. */
	onSeat?(name: string): void;
	/** A seat was held, right-clicked or given the Menu key; by default it has no menu. */
	onSeatMenu?(request: SeatMenuRequest): void;
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
	const marks = useRoundMarks(props.groupRoom);
	const attention = useHostSeats().attention;
	const hosted = useHostedTable();
	const hostedRef = useRef(hosted);
	hostedRef.current = hosted;
	const listBelow = variant === "full" && props.list === true;

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
				onSeatClick: ({ id, at }) => {
					const seat = latest.current.onSeat;
					if (seat) {
						seat(id);
						return;
					}
					const view = rosterRef.current.find((one) => one.name === id);
					if (!view) return;
					const open = () => navigate("room", view.key);
					const frame = host.current;
					// A tap or a key press dives into the seat, and the room opens as the zoom ends.
					if (at && frame)
						diveInto(
							frame,
							at,
							open,
							hostedRef.current ? warmHostRooms : undefined,
						);
					else open();
				},
				...(latest.current.onSeatMenu
					? { onSeatMenu: (request) => latest.current.onSeatMenu?.(request) }
					: {}),
				ownerName: latest.current.ownerName ?? t("You"),
				focus: latest.current.focus ?? null,
				onFocus: (id) => latest.current.onFocus?.(id),
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
			// A dive that has not left yet goes with the table that started it.
			cancelDive(element);
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

	// The seats wear the round's signs, the same as the strip over the box.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `mounted` says the handle exists
	useEffect(() => {
		const table = handle.current;
		if (!table) return;
		for (const seat of seatsRef.current)
			table.setMark(seat.id, marks[seat.id] ?? null);
	}, [marks, seats, mounted]);

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
		return <p className="table-empty">{t("No knights are seated yet.")}</p>;
	return (
		<section className="table-host" ref={host} aria-label={t("Round table")} />
	);
}
