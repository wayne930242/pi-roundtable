/**
 * The scene's render loop: it runs while the scene is on screen and the page is visible, draws every
 * frame while something moves (a camera turn, a bob) and a few times a second otherwise, so a torch
 * still flickers without keeping the GPU busy. Hidden or off-screen, nothing is scheduled at all.
 */

export type LoopState = "live" | "idle" | "paused";

export interface LoopHost {
	request(run: (now: number) => void): number;
	cancel(handle: number): void;
	/** Whether the page is hidden. */
	hidden(): boolean;
}

export interface LoopOptions {
	/** Draws one frame; returns true while the scene is moving and wants the next frame at once. */
	frame(now: number, dt: number): boolean;
	host: LoopHost;
	/** The gap between frames while nothing moves, ms; 0 draws nothing until `wake`. */
	idleMs?: number | (() => number);
}

export interface Loop {
	readonly state: LoopState;
	/** Something changed: draw again soon. */
	wake(): void;
	/** Whether the scene is on screen; an off-screen scene is paused. */
	setVisible(visible: boolean): void;
	/** The page's visibility changed. */
	sync(): void;
	dispose(): void;
}

export function createLoop(options: LoopOptions): Loop {
	const gap = () => {
		const idle = options.idleMs ?? 80;
		return typeof idle === "function" ? idle() : idle;
	};
	const { host } = options;
	let onScreen = true;
	let handle: number | undefined;
	let last = 0;
	let moving = false;
	let lastDrawn = Number.NEGATIVE_INFINITY;
	let disposed = false;

	const paused = () => disposed || !onScreen || host.hidden();
	const stop = () => {
		if (handle === undefined) return;
		host.cancel(handle);
		handle = undefined;
	};
	const tick = (now: number) => {
		handle = undefined;
		if (paused()) return;
		if (moving || now - lastDrawn >= gap()) {
			const dt = last === 0 ? 16 : Math.min(now - last, 100);
			last = now;
			lastDrawn = now;
			moving = options.frame(now, dt);
		}
		if (moving || gap() > 0) handle = host.request(tick);
	};
	const start = () => {
		if (handle !== undefined || paused()) return;
		last = 0;
		handle = host.request(tick);
	};

	return {
		get state(): LoopState {
			if (paused()) return "paused";
			return moving ? "live" : "idle";
		},
		wake() {
			moving = true;
			start();
		},
		setVisible(visible) {
			onScreen = visible;
			if (paused()) stop();
			else start();
		},
		sync() {
			if (paused()) stop();
			else start();
		},
		dispose() {
			disposed = true;
			stop();
		},
	};
}
