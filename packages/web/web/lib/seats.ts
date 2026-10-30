import type {
	AvatarState,
	CharacterLook,
	CharacterSpec,
	Expression,
	Hex,
} from "pi-roundtable/characters";
import type { SeatState } from "../table/types.ts";
import type { Kit } from "./kit.ts";

// What the round table needs from the page's state: seat states from presence, the speaker of a
// group round, the seat's picture and the swap of a picture when the face changes. All of it is pure
// or takes its clock, so it is tested without a browser; `components/round-table.tsx` wires it up.

/** The table has no `sleepy` seat: a sleepy agent sits there idle. */
export const seatStateOf = (state: AvatarState): SeatState =>
	state === "sleepy" ? "idle" : state;

/** Who is speaking in a group room: its `typing` and `agent` as the room's state holds them. */
export interface GroupRound {
	typing: boolean;
	agent?: string | undefined;
}

/**
 * The state of every seat. `agents` holds each agent's presence by name; the member a typing group
 * round names as `agent` is lit as `speaking`, unless it is waiting on a card or has failed, which
 * the table must keep showing.
 */
export function seatStates(
	agents: Readonly<Record<string, AvatarState>>,
	groups: readonly GroupRound[],
): Record<string, SeatState> {
	const states: Record<string, SeatState> = {};
	for (const [name, state] of Object.entries(agents))
		states[name] = seatStateOf(state);
	for (const round of groups) {
		const speaker = round.agent;
		if (!round.typing || speaker === undefined || !(speaker in states))
			continue;
		const now = states[speaker];
		if (now === "waiting" || now === "error") continue;
		states[speaker] = "speaking";
	}
	return states;
}

/** The face a seat shows: its state's expression, and a happy one for the speaker. */
export function seatExpressionOf(
	state: SeatState,
	kit?: Pick<Kit, "STATE_EXPRESSION">,
): Expression {
	if (state === "speaking") return "happy";
	return (kit?.STATE_EXPRESSION ?? FALLBACK_EXPRESSION)[state];
}

const FALLBACK_EXPRESSION: Readonly<Record<AvatarState, Expression>> = {
	idle: "neutral",
	thinking: "thinking",
	working: "determined",
	waiting: "curious",
	done: "proud",
	error: "apologetic",
	sleepy: "sleepy",
};

/** The suffix that keeps one picture's ids apart from the next one's on a page: the seat's place, then its name. */
export function seatUid(index: number, id: string): string {
	return `s${index}${id.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 16);
}

/** What the standee shows of the figure: the whole width and head-room for tall hats, down to the waist where the kit cuts it off. */
const STANDEE_BOX = { x: -7, y: -3, w: 114, h: 100 } as const;
const STANDEE_PX = 256;

/**
 * A seat's picture: the character from the waist up, without the round or shield frame, wearing the
 * face of its state. It is the figure on a standee board, so its edge is drawn by the table (a thin
 * light rim round the cut-out), not by a frame. The table draws its own badges, so the picture
 * carries none; the state shows as the expression only.
 */
export function seatPicture(
	kit: Kit,
	spec: CharacterSpec,
	look: CharacterLook,
	state: SeatState,
	uid: string,
	skins?: readonly Hex[],
): string {
	const figure = kit.composeSvg(spec, {
		bare: true,
		look,
		expr: seatExpressionOf(state, kit),
		state: "idle",
		still: true,
		size: STANDEE_PX,
		uid,
		skins,
	});
	const { x, y, w, h } = STANDEE_BOX;
	return figure
		.replace('viewBox="0 0 100 100"', `viewBox="${x} ${y} ${w} ${h}"`)
		.replace(
			`width="${STANDEE_PX}" height="${STANDEE_PX}"`,
			`width="${STANDEE_PX}" height="${Math.round((STANDEE_PX * h) / w)}"`,
		);
}

export interface Timers {
	set(run: () => void, ms: number): ReturnType<typeof setTimeout>;
	clear(timer: ReturnType<typeof setTimeout>): void;
}

export interface ExpressionSwaps {
	/** A seat's state now; the first time for a seat is its first picture and swaps nothing. */
	update(id: string, state: SeatState): void;
	/** The seat's picture was drawn for `state` by other means (a new look, a new roster): swap from there. */
	seed(id: string, state: SeatState): void;
	forget(id: string): void;
	dispose(): void;
}

/**
 * Redraws a seat's picture when its expression changes, once the change has stood for `delayMs`,
 * so a burst of states (thinking, working, done in a second) costs one atlas cell, and a change
 * that goes back before it lands costs none.
 */
export function createExpressionSwaps(options: {
	/** Called with the seat and the state whose expression it now shows. */
	setAvatar(id: string, state: SeatState): void;
	delayMs?: number;
	timers?: Timers;
}): ExpressionSwaps {
	const delay = options.delayMs ?? 300;
	const timers: Timers = options.timers ?? {
		set: (run, ms) => setTimeout(run, ms),
		clear: (timer) => clearTimeout(timer),
	};
	const shown = new Map<string, Expression>();
	const pending = new Map<string, ReturnType<typeof setTimeout>>();
	const cancel = (id: string) => {
		const timer = pending.get(id);
		if (timer === undefined) return;
		timers.clear(timer);
		pending.delete(id);
	};
	return {
		seed(id, state) {
			cancel(id);
			shown.set(id, seatExpressionOf(state));
		},
		update(id, state) {
			const wanted = seatExpressionOf(state);
			if (!shown.has(id)) {
				shown.set(id, wanted);
				return;
			}
			cancel(id);
			if (shown.get(id) === wanted) return;
			pending.set(
				id,
				timers.set(() => {
					pending.delete(id);
					shown.set(id, wanted);
					options.setAvatar(id, state);
				}, delay),
			);
		},
		forget(id) {
			cancel(id);
			shown.delete(id);
		},
		dispose() {
			for (const id of [...pending.keys()]) cancel(id);
			shown.clear();
		},
	};
}
