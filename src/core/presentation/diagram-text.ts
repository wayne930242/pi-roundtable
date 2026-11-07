import { Worker } from "node:worker_threads";

/** The most source a diagram may have to be drawn as text; a longer one is shown as its source. */
export const MAX_DIAGRAM_TEXT_BYTES = 3 * 1024;
/** The longest the host waits for one drawing. The drawing is not bounded by the size of its source. */
export const DIAGRAM_TEXT_DEADLINE_MS = 500;
/** How long the first drawing of a worker may take to start, with the drawing library loading. */
const START_MS = 5_000;
const KEPT = 200;
const RESULT_BYTES = 256 * 1024;

interface Drawer {
	worker: Worker;
	head: Int32Array;
	body: Uint8Array;
}

let drawer: Drawer | undefined;
/** What was drawn, by source; `null` for one that could not be, so it is not tried again. */
const drawn = new Map<string, string | null>();

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
		return undefined;
	}
	return { worker, head, body: new Uint8Array(shared, 16) };
}

function stop(current: Drawer): void {
	void current.worker.terminate();
	if (drawer === current) drawer = undefined;
}

/**
 * A Mermaid diagram as Unicode box drawing, or undefined when it cannot be shown right (see
 * `mermaidText` of `pi-better-show/server`), is longer than `MAX_DIAGRAM_TEXT_BYTES`, or takes
 * longer than `DIAGRAM_TEXT_DEADLINE_MS`: the text drawing grows with the shape of the diagram,
 * not its size (a 250-byte chain of states needs about a minute), so it runs in a worker the host
 * waits on for at most the deadline, and the worker is dropped when it overruns. The host's thread
 * is therefore held for no more than the deadline per new source; a source seen before answers from
 * memory. Callers fall back to the source.
 */
export function diagramText(source: string): string | undefined {
	if (Buffer.byteLength(source) > MAX_DIAGRAM_TEXT_BYTES) return undefined;
	const known = drawn.get(source);
	if (known !== undefined) {
		drawn.delete(source);
		drawn.set(source, known);
		return known ?? undefined;
	}
	const text = draw(source);
	drawn.set(source, text ?? null);
	if (drawn.size > KEPT)
		for (const oldest of drawn.keys()) {
			drawn.delete(oldest);
			break;
		}
	return text;
}

function draw(source: string): string | undefined {
	drawer ??= start();
	const current = drawer;
	if (!current) return undefined;
	Atomics.store(current.head, 0, 1);
	current.worker.postMessage(source);
	if (
		Atomics.wait(current.head, 0, 1, DIAGRAM_TEXT_DEADLINE_MS) === "timed-out"
	) {
		stop(current);
		return undefined;
	}
	const length = current.head[1] ?? -1;
	if (length < 0) return undefined;
	return new TextDecoder().decode(current.body.slice(0, length));
}
