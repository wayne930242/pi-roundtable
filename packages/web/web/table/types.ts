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

export interface SeatInit {
	id: string;
	name: string;
	/** agent accent, #rrggbb */
	color: string;
	/** composed character SVG (from the art lab); placeholder bust is drawn until set */
	avatarSvg?: string;
	state?: SeatState;
}

export interface TableOptions {
	theme: ThemeName;
	scheme: Scheme;
	seats: SeatInit[];
	onSeatClick: (seat: { id: string; name: string }) => void;
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
	/** The seam for the composed characters: replace one seat's picture. */
	setAvatar(id: string, svg: string): Promise<void>;
	setReducedMotion(reduced: boolean): void;
	resetCamera(): void;
	getStats(): TableStats;
	dispose(): void;
}
