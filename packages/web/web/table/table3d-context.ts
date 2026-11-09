import type {
	AmbientLight,
	DirectionalLight,
	Group,
	PerspectiveCamera,
	Scene,
	WebGLRenderer,
} from "three";
import type { Move, Shot, Slots } from "./camera";
import type { Effects } from "./fx3d";
import type { Hall } from "./hall";
import type { Built } from "./hall3d";
import type { Loop } from "./loop";
import type { Names } from "./names3d";
import type { Podium, PodiumKit } from "./podium3d";
import type { SeatingPlan } from "./seating";
import type { SpeedLines } from "./speed";
import type { Toon } from "./toon";
import type {
	Scheme,
	SeatInit,
	SeatState,
	TableOptions,
	TableStats,
	ThemeName,
} from "./types";

/** Where a podium stands on the floor. */
export interface Place {
	x: number;
	z: number;
	yaw: number;
}

/** The height a podium rests at, on the dais. */
export const REST_Y = 0.2;
/** Where the middle of the smoke hangs over a leaving seat. */
export const PUFF_Y = 2;

/** A podium's identity across rings: an agent's id, or the owner's or the "+N" podium. */
export const keyOf = (p: Podium): string => p.init.id ?? p.init.kind;

/** One change of the ring in progress: who goes, who comes, and the shows that carry them. */
export interface Show {
	plan: SeatingPlan;
	start: number;
	next: SeatInit[];
	leavers: Podium[];
	swapped: boolean;
	fx: Effects | undefined;
	slides: Array<{ podium: Podium; from: Place; to: Place }>;
	risers: Podium[];
	timers: Array<ReturnType<typeof setTimeout>>;
}

export interface World {
	hall: Hall;
	toon: Toon;
	kit: PodiumKit;
	built: Built;
	group: Group;
	slots: Slots;
	podiums: Podium[];
	/** Seat id to its slot on the ring. */
	slotOf: Map<string, number>;
	/** The ids in slot order, for the neighbours of a close-up. */
	order: string[];
}

/** Everything the parts of the hall share: its objects, the state that changes, and the calls one part makes of another. */
export interface Table3DContext {
	container: HTMLElement;
	opts: TableOptions;
	onLost: (() => void) | undefined;
	renderer: WebGLRenderer;
	canvasEl: HTMLCanvasElement;
	names: Names;
	speed: SpeedLines;
	scene: Scene;
	camera: PerspectiveCamera;
	ambient: AmbientLight;
	key: DirectionalLight;
	lowPower: boolean;
	states: Map<string, SeatState>;
	marks: Map<string, string>;
	svgs: Map<string, string>;
	talks: Map<string, string>;

	reduced: boolean;
	theme: ThemeName;
	scheme: Scheme;
	seats: SeatInit[];
	world: World | undefined;
	building: number;
	show: Show | undefined;
	focusId: string | null;
	overviewAz: number;
	shot: Shot;
	camFrom: Shot;
	camTo: Shot;
	moveStart: number;
	moveMs: number;
	moveDive: boolean;
	dragging: { az: number } | undefined;
	primed: boolean;
	renders: number;
	stats: TableStats;
	loop: Loop;

	countNow(): number;
	targetShot(): Shot;
	applyCamera(): void;
	moveTo(target: Shot, cut: boolean, dive?: boolean): Move;
	setFocus(id: string | null, cut: boolean, fromPerson: boolean): void;
	step(direction: 1 | -1): void;
	zoom(delta: number): void;
	build(glide?: {
		from: ReadonlyMap<string, Place>;
		joining: ReadonlySet<string>;
	}): void;
	stickerOf(id: string, expected: number): Promise<void>;
	applyState(p: Podium, state: SeatState): void;
	disposeWorld(): void;
	resize(): void;
	stepShow(now: number): boolean;
	endShow(): void;
	startShow(next: SeatInit[], plan: SeatingPlan): void;
	shownIds(list: readonly SeatInit[]): string[];
	hit(
		clientX: number,
		clientY: number,
	): { seat: string | null; kind: string } | undefined;
}
