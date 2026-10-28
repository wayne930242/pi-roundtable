import type { CharacterSpec } from "pi-roundtable/characters";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { useSelector } from "../lib/app-store.ts";
import { suggestionFor } from "../lib/character-spec.ts";
import { useCharacters, useRoomStates } from "../lib/characters.ts";
import { useKit } from "../lib/kit.ts";
import { useCharacterStyle, useLook } from "../lib/look.ts";
import { useMedia } from "../lib/media.ts";
import { translate as t } from "../lib/messages.ts";
import { navigate } from "../lib/router.ts";
import {
	createExpressionSwaps,
	type ExpressionSwaps,
	type GroupRound,
	seatPicture,
	seatStates,
	seatUid,
} from "../lib/seats.ts";
import type { SeatInit, TableHandle } from "../table/entry.ts";

/** More seats than this on a phone held upright are also listed as buttons: the pictures get small. */
const LIST_ABOVE = 10;

/** The agents of the room list, the coordinator first; only `members` of them when the table is a group's. */
function useRoster(members: readonly string[] | undefined): RoomView[] {
	return useSelector((state) => {
		const agents = state.order
			.map((key) => state.rooms[key]?.view)
			.filter(
				(view): view is RoomView => view !== undefined && view.kind === "agent",
			);
		const seated = members
			? members
					.map((name) => agents.find((view) => view.name === name))
					.filter((view): view is RoomView => view !== undefined)
			: agents;
		return [...seated].sort((a, b) => Number(b.home) - Number(a.home));
	}, members?.join("\n") ?? "");
}

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
	const characters = useCharacters();
	const roster = useRoster(props.members);
	const agentStates = useRoomStates(roster.map((view) => view.key));
	const rounds = useRounds(props.groupRoom);
	const upright = useMedia("(orientation: portrait)");
	const listBelow =
		variant === "full" &&
		(props.list === true || (upright && roster.length > LIST_ABOVE));

	const states = useMemo(
		() =>
			seatStates(
				Object.fromEntries(
					roster.map((view) => [view.name, agentStates[view.key] ?? "idle"]),
				),
				rounds,
			),
		[roster, agentStates, rounds],
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
				),
			};
		});
	}, [kit, roster, characters, style.look]);
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
	const kitRef = useRef(kit);
	kitRef.current = kit;
	const onHandleRef = useRef(onHandle);
	onHandleRef.current = onHandle;

	const ready = kit !== undefined && seats.length > 0;
	// The scene mounts once there is something to seat, and again when its shape changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the shape of the table remounts it; the rest goes through the handle
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
					const view = rosterRef.current.find((one) => one.name === id);
					if (view) navigate("room", view.key);
				},
				reducedMotion: "auto",
				lowPower: "auto",
				variant,
				listBelow,
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
