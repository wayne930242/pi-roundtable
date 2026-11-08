import { Worker } from "node:worker_threads";

/** The most source a diagram may have to be drawn as text; a longer one is shown as its source. */
export const MAX_DIAGRAM_TEXT_BYTES = 3 * 1024;
/** The longest the host waits for the drawings of one reply. The drawing is not bounded by the size of its source. */
export const DIAGRAM_TEXT_DEADLINE_MS = 500;
/** The most diagrams drawn afresh for one reply; the others are shown as their source. */
export const MAX_DRAWN_PER_REPLY = 3;
/** How long the first drawing of a worker may take to start, with the drawing library loading. */
const START_MS = 5_000;
const KEPT = 200;
/** How long a source that overran stays undrawn before it is tried again: on a loaded host an overrun is no verdict on the source. */
const OVERRUN_KEPT_MS = 10 * 60_000;
const RESULT_BYTES = 256 * 1024;

interface Drawer {
	worker: Worker;
	head: Int32Array;
	body: Uint8Array;
}

let drawer: Drawer | undefined;
/** Set once a worker could not be started: the host does not try again for the life of the process. */
let unavailable = false;
/** What was drawn, by source; `null` for one that could not be, so it is not tried again. */
const drawn = new Map<string, string | null>();
/** When each source that overran may be tried again. */
const overran = new Map<string, number>();

function start(): Drawer | undefined {
	const shared = new SharedArrayBuffer(16 + RESULT_BYTES);
	const head = new Int32Array(shared, 0, 4);
	const worker = new Worker(
		new URL("./diagram-text-worker.ts", import.meta.url),
		{ workerData: { shared } },
	);
	// An idle drawer does not keep the host running.
	worker.unref();
	worker.on("error", () => {
		if (drawer?.worker === worker) drawer = undefined;
	});
	if (Atomics.wait(head, 0, 0, START_MS) === "timed-out") {
		void worker.terminate();
		unavailable = true;
		return undefined;
	}
	return { worker, head, body: new Uint8Array(shared, 16) };
}

function stop(current: Drawer): void {
	void current.worker.terminate();
	if (drawer === current) drawer = undefined;
}

type Drawn = { text: string } | "refused" | "slow" | "unavailable";

/** What a test replaces: the drawing itself and the clock that measures it, so no test depends on real elapsed time. */
export interface DrawerSeams {
	draw?: (source: string, waitMs: number) => Drawn;
	now?: () => number;
}

/**
 * A drawer of Mermaid diagrams as Unicode box drawing for one reply: it gives undefined for a source
 * that cannot be shown right (see `mermaidText` of `pi-better-show/server`), is longer than
 * `MAX_DIAGRAM_TEXT_BYTES`, or does not fit the reply's budget. The text drawing grows with the shape
 * of the diagram, not its size (a 250-byte chain of states needs about a minute), so it runs in a
 * worker the host waits on, and the worker is dropped when it overruns. The host's thread is held for
 * `DIAGRAM_TEXT_DEADLINE_MS` in all across the reply's sources, and at most `MAX_DRAWN_PER_REPLY` are
 * drawn afresh; a source seen before answers from memory. Callers fall back to the source.
 *
 * What is remembered: a source the worker refused, and for ten minutes one that overran a whole deadline; a source
 * left undrawn for the budget, or because no worker could be started, is no verdict and is tried
 * again in a later reply.
 */
export function diagramDrawer(
	seams: DrawerSeams = {},
): (source: string) => string | undefined {
	const drawOne = seams.draw ?? draw;
	const now = seams.now ?? (() => performance.now());
	let left = DIAGRAM_TEXT_DEADLINE_MS;
	let fresh = 0;
	return (source) => {
		if (Buffer.byteLength(source) > MAX_DIAGRAM_TEXT_BYTES) return undefined;
		const known = drawn.get(source);
		if (known === null && (overran.get(source) ?? Infinity) <= Date.now()) {
			drawn.delete(source);
			overran.delete(source);
		} else if (known !== undefined) {
			drawn.delete(source);
			drawn.set(source, known);
			return known ?? undefined;
		}
		if (fresh >= MAX_DRAWN_PER_REPLY || left <= 0) return undefined;
		fresh += 1;
		const waitMs = left;
		const started = now();
		const result = drawOne(source, waitMs);
		left -= now() - started;
		if (typeof result === "object") remember(source, result.text);
		else if (result === "refused") remember(source, null);
		else if (result === "slow" && waitMs >= DIAGRAM_TEXT_DEADLINE_MS) {
			remember(source, null);
			overran.set(source, Date.now() + OVERRUN_KEPT_MS);
		}
		return typeof result === "object" ? result.text : undefined;
	};
}

/** One source on its own, with a whole reply's budget. */
export function diagramText(source: string): string | undefined {
	return diagramDrawer()(source);
}

function remember(source: string, text: string | null): void {
	drawn.set(source, text);
	if (drawn.size > KEPT)
		for (const oldest of drawn.keys()) {
			drawn.delete(oldest);
			overran.delete(oldest);
			break;
		}
}

function draw(source: string, waitMs: number): Drawn {
	if (unavailable) return "unavailable";
	drawer ??= start();
	const current = drawer;
	if (!current) return "unavailable";
	Atomics.store(current.head, 0, 1);
	current.worker.postMessage(source);
	if (Atomics.wait(current.head, 0, 1, waitMs) === "timed-out") {
		stop(current);
		return "slow";
	}
	const length = current.head[1] ?? -1;
	if (length < 0) return "refused";
	return { text: new TextDecoder().decode(current.body.slice(0, length)) };
}
