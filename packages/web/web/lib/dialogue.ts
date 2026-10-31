import type { RoomFile } from "../../src/api-types.ts";
import type { CardState, RoomState } from "./rooms.ts";

// What the scene's dialogue box shows of a room, and how its words appear. All of it is pure or takes
// its clock, so it is tested without a browser; `components/dialogue-box.tsx` wires it up.

/** The one line the box shows: the room's latest words, by the owner or by an agent. */
export interface Line {
	/** Tells one line from the next: a stored message's id, a live message's key, a pending send's id. */
	id: string;
	who: "owner" | "agent";
	/** The agent's name when an agent speaks. */
	agent?: string | undefined;
	author: string;
	text: string;
	files: readonly RoomFile[];
	/** The text is still arriving (an agent's interim message). */
	live: boolean;
	/** The owner's message the server has not taken yet. */
	pending: boolean;
}

/**
 * The newest thing said in a room: a message the owner sent that the server has not taken yet, then
 * what the agent is streaming now, then its interim message, then the last stored owner or agent
 * message. The server's own lines (a divider, a yolo approval) are not words and are skipped.
 * `agentName` says who is speaking in a room that has one agent (the room's own) or a group (the
 * member `room.agent` names) and `displayOf` gives a member's name to show.
 */
export function currentLine(
	room:
		| Pick<
				RoomState,
				"messages" | "live" | "pending" | "typing" | "progress" | "agent"
		  >
		| undefined,
	ownerName: string,
	displayOf: (agent: string | undefined) => string,
	roomAgent?: string,
): Line | undefined {
	if (!room) return undefined;
	const pending = room.pending.at(-1);
	if (pending && !pending.failed)
		return {
			id: `p${pending.id}`,
			who: "owner",
			author: ownerName,
			text: pending.text,
			files: [],
			live: false,
			pending: true,
		};
	if (room.typing && room.progress.text !== "") {
		const agent = room.agent ?? roomAgent;
		return {
			id: `s${room.messages.at(-1)?.id ?? 0}`,
			who: "agent",
			agent,
			author: displayOf(agent),
			text: room.progress.text,
			files: [],
			live: true,
			pending: false,
		};
	}
	const live = room.live.at(-1);
	if (live)
		return {
			id: `l${live.live ?? live.id}`,
			who: "agent",
			agent: live.agent,
			author: live.author,
			text: live.text,
			files: live.files,
			live: true,
			pending: false,
		};
	for (let at = room.messages.length - 1; at >= 0; at -= 1) {
		const message = room.messages[at];
		if (!message || message.kind === "system") continue;
		return {
			id: `m${message.id}`,
			who: message.kind === "owner" ? "owner" : "agent",
			agent: message.agent,
			author: message.author,
			text: message.text,
			files: message.files,
			live: false,
			pending: false,
		};
	}
	return undefined;
}

/** The open cards and the newest closed ones of a room, in the order they opened. */
export function boxCards(
	state: { cards: Record<string, CardState>; cardOrder: string[] },
	room: string,
	lastMessageId: number | undefined,
): Array<{ id: string; card: CardState }> {
	const found = state.cardOrder
		.map((id) => ({ id, card: state.cards[id] }))
		.filter(
			(entry): entry is { id: string; card: CardState } =>
				entry.card?.room === room,
		);
	return found.filter(
		(entry) =>
			entry.card.outcome === undefined ||
			lastMessageId === undefined ||
			entry.card.after >= lastMessageId,
	);
}

/** How fast the words appear, in characters a second; Chinese and Latin text alike are counted by character. */
export const REVEAL_CPS = 90;

/** How many characters of the text show after `dt` ms, from `shown`; the whole text at once when it is not moving (`instant`). */
export function revealStep(
	shown: number,
	total: number,
	dt: number,
	options: { cps?: number; instant?: boolean } = {},
): number {
	if (options.instant) return total;
	const next = shown + (dt / 1000) * (options.cps ?? REVEAL_CPS);
	return Math.min(total, Math.max(shown, next));
}

/**
 * The reveal of a line's text as a value that a component drives: `step` moves it on by the time
 * that passed, `finish` shows everything (a tap), and a new line starts again from nothing while the
 * same line growing (a stream) keeps what already shows.
 */
export interface Reveal {
	/** Whole characters (code points) showing. */
	readonly shown: number;
	/** Whether everything of the text shows. */
	readonly done: boolean;
	/** Feeds the line: its identity and full text. */
	feed(id: string, text: string): void;
	step(dt: number, instant: boolean): void;
	finish(): void;
}

export function createReveal(): Reveal {
	let id: string | undefined;
	let text = "";
	let total = 0;
	let at = 0;
	return {
		get shown() {
			return Math.floor(at);
		},
		get done() {
			return Math.floor(at) >= total;
		},
		feed(next, full) {
			if (next !== id) {
				// the stored reply that replaces its own stream or interim copy keeps what showed
				const same =
					text !== "" && (full.startsWith(text) || text.startsWith(full));
				id = next;
				if (!same) at = 0;
			}
			text = full;
			total = Array.from(full).length;
			if (at > total) at = total;
		},
		step(dt, instant) {
			at = revealStep(at, total, dt, { instant });
		},
		finish() {
			at = total;
		},
	};
}

/**
 * Who speaks in the box now: the agent whose words are being revealed, or still streaming in
 * (`streamer`, the member the room streams for, names who is writing them). Nobody while the turn
 * only thinks or runs its tools, and nobody once the words stand whole.
 */
export function voiceOf(
	line: Pick<Line, "who" | "agent" | "live"> | undefined,
	revealing: boolean,
	streamer: string | undefined,
): string | undefined {
	if (line?.who !== "agent") return undefined;
	if (line.live && streamer !== undefined) return streamer;
	return revealing ? line.agent : undefined;
}

/**
 * What the folded dialogue box shows of a line: its first line of words, without the marks of
 * Markdown, cut to `max` characters.
 */
export function linePreview(text: string, max = 80): string {
	const line =
		text
			.split("\n")
			.map((one) =>
				one
					.replace(/^\s*(?:#{1,6}\s|>\s?|[-*+]\s|\d+\.\s)+/, "")
					.replace(/[*_`~]/g, "")
					.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
					.replace(/\s+/g, " ")
					.trim(),
			)
			.find((one) => one !== "") ?? "";
	const chars = Array.from(line);
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}

/** The first `count` characters of a text, never half of a surrogate pair. */
export const sliceChars = (text: string, count: number): string =>
	Array.from(text).slice(0, count).join("");

/**
 * Which agent a route key names: the agent's own name, or the key of the agent's room; null when it
 * names nobody seated, which sends the page back to the whole ring.
 */
export function resolveFocus(
	key: string | undefined,
	roster: ReadonlyArray<{ key: string; name: string }>,
): string | null {
	if (!key) return null;
	const found = roster.find((seat) => seat.name === key || seat.key === key);
	return found ? found.name : null;
}

/**
 * The member the camera follows in a group room: whoever said the newest line, when they are one of
 * the group; while the owner speaks, or nobody yet, the camera rests on the whole ring (null).
 */
export function speakerOf(
	line: Pick<Line, "who" | "agent"> | undefined,
	members: readonly string[],
): string | null {
	if (!line || line.who !== "agent" || line.agent === undefined) return null;
	return members.includes(line.agent) ? line.agent : null;
}

/**
 * The camera's focus in a group scene: the member the person turned it to by hand while the line
 * they looked at stands, and the speaker as soon as a new line comes.
 */
export function followFocus(
	speaker: string | null,
	lineId: string | undefined,
	manual: { lineId: string | undefined; member: string | null } | undefined,
): string | null {
	return manual && manual.lineId === lineId ? manual.member : speaker;
}
