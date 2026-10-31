export type SeatState =
	| "idle"
	| "thinking"
	| "working"
	| "waiting"
	| "speaking"
	| "done"
	| "error";
export type ThemeName = "modern" | "camelot";
export type Scheme = "light" | "dark";

export const SEAT_STATES: SeatState[] = [
	"idle",
	"thinking",
	"working",
	"waiting",
	"speaking",
	"done",
	"error",
];

/**
 * Where an activation was: the pointer for a click or a tap, the middle of the element for a key
 * press (a keyboard click reports no position).
 */
export function pointOf(
	event: { clientX: number; clientY: number; detail?: number },
	element: Element,
): { x: number; y: number } {
	if (event.detail !== 0 && (event.clientX !== 0 || event.clientY !== 0))
		return { x: event.clientX, y: event.clientY };
	const box = element.getBoundingClientRect();
	return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

export interface SeatInit {
	id: string;
	name: string;
	/** agent accent, #rrggbb */
	color: string;
	/** composed character SVG (from the art lab); placeholder bust is drawn until set */
	avatarSvg?: string;
	/** The same figure with its mouth open: while the seat speaks the table alternates it with `avatarSvg`, unless motion is reduced. */
	talkSvg?: string;
	state?: SeatState;
	/** The seat is asleep or away: its standee is dimmed. */
	dim?: boolean;
}

/** What the table says to a screen reader, as the page words it. */
export interface TableLabels {
	/** The name of the table itself. */
	table: string;
	/** A seat as a button: its name and what it is doing. */
	seat(name: string, state: SeatState): string;
}

export const ENGLISH_TABLE_LABELS: TableLabels = {
	table: "Round table",
	seat: (name, state) => `${name} (${state})`,
};

/** A seat's menu was asked for: a hold of a finger, a right click or the Menu key. */
export interface SeatMenuRequest {
	id: string;
	name: string;
	/** Where the press was, in viewport coordinates. */
	at: { x: number; y: number };
	via: "hold" | "contextmenu" | "key";
	/** What was pressed; it gets focus back when the menu closes. */
	source: HTMLElement;
}

export interface TableOptions {
	theme: ThemeName;
	scheme: Scheme;
	seats: SeatInit[];
	onSeatClick: (seat: {
		id: string;
		name: string;
		/** Where the seat was tapped, or the middle of the seat when it was reached by keyboard; viewport coordinates. */
		at?: { x: number; y: number };
	}) => void;
	/** A seat was held, right-clicked or given the Menu key; the page opens its menu. A press that long is no tap. */
	onSeatMenu?: (request: SeatMenuRequest) => void;
	/** 'auto' follows prefers-reduced-motion */
	reducedMotion?: boolean | "auto";
	/** 'auto' = coarse pointer / narrow viewport / few cores */
	lowPower?: boolean | "auto";
	/** 'compact' is always the 2D strip: 120 px high, no camera, no controls */
	variant?: "full" | "compact";
	/** show the seats as visible buttons under a shorter canvas (phones with many seats) */
	listBelow?: boolean;
	/** Told whether the canvas can carry names a person reads (11 px or more); the page lists the seats when it cannot. */
	onNames?: (readable: boolean) => void;
	/** The screen-reader words; English when absent. */
	labels?: TableLabels;
	/** The name on the owner's own podium, the camera's home; "You" when absent. */
	ownerName?: string;
	/** The seat the camera starts on; the whole ring when absent. */
	focus?: string | null;
	/** The camera was turned by the person (a zoom, a swipe in a close-up), not by the page: the page follows it. `null` is back to the whole ring. */
	onFocus?: (id: string | null) => void;
}

export interface TableStats {
	kind: "webgl" | "svg";
	/** rendered frames over the last second */
	fps: number;
	/** mean CPU time of update+render per frame, ms */
	frameMs: number;
	/** worst frame in the last second, ms */
	frameMsMax: number;
	drawCalls: number;
	triangles: number;
	textures: number;
	geometries: number;
	dpr: number;
	lowPower: boolean;
	reduced: boolean;
	/** 'live' = looping, 'idle' = nothing scheduled, 'paused' = hidden/offscreen */
	loop: "live" | "idle" | "paused";
	seats: number;
	renders: number;
}

export interface TableHandle {
	readonly kind: "webgl" | "svg";
	setTheme(theme: ThemeName, scheme: Scheme): void;
	setSeats(seats: SeatInit[]): void;
	setState(id: string, state: SeatState): void;
	/** A short sign before a seat's name that says where it stands in a round (a check for who has spoken, a number for who is next); `null` takes it away. */
	setMark(id: string, mark: string | null): void;
	/** The seam for the composed characters: replace one seat's picture, and its open-mouthed frame for speaking (none when absent). */
	setAvatar(id: string, svg: string, talkSvg?: string): Promise<void>;
	setReducedMotion(reduced: boolean): void;
	resetCamera(): void;
	/** Turns the camera to a seat (a close-up) or back to the whole ring (`null`); cuts under reduced motion or when `cut`. */
	focus(id: string | null, options?: { cut?: boolean }): void;
	/** The seat the camera is on, or null for the whole ring. */
	focused(): string | null;
	/** The seat under a point of the viewport, if the scene can say (the 3D hall can; the 2D table's seats are elements). */
	seatAt?(x: number, y: number): string | null;
	getStats(): TableStats;
	dispose(): void;
}
