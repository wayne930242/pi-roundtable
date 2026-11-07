import { Worker } from "node:worker_threads";

/** Why a diagram was not drawn. `busy` is no verdict on the source; the others are. */
export class DiagramRefusal extends Error {
	constructor(readonly why: "busy" | "invalid" | "slow") {
		super(`diagram not drawn: ${why}`);
	}
}

export interface DiagramRendererOptions {
	/** The longest one drawing may take once it starts, in milliseconds; default 3000. */
	timeoutMs?: number;
	/** How many drawings may wait behind the one running; default 4. More are refused as `busy`. */
	queue?: number;
	/** Starts a worker; default the drawing worker. For tests. */
	spawn?: () => Worker;
}

/** How long a new worker may take to load the drawing library; a worker that fails to start is no verdict on a source, so it is refused as `busy`. */
const START_MS = 15_000;

interface Reply {
	id?: number;
	ready?: boolean;
	svg?: string;
	refused?: boolean;
}

/**
 * Draws Mermaid sources as SVG in a worker thread, one at a time, so a diagram the drawing library
 * needs seconds for never holds the console's event loop. A drawing past `timeoutMs` ends the worker
 * (the drawing cannot be interrupted any other way) and a fresh one serves the next. Waiting is
 * bounded by `queue`.
 */
export class DiagramRenderer {
	readonly #timeoutMs: number;
	readonly #queue: number;
	#worker: Promise<Worker> | undefined;
	/** The worker `#worker` stands for, loaded or not; only it is ever forgotten. */
	#current: Worker | undefined;
	readonly #spawn: () => Worker;
	#waiting = 0;
	#tail: Promise<unknown> = Promise.resolve();
	#nextId = 1;

	constructor(options: DiagramRendererOptions = {}) {
		this.#timeoutMs = options.timeoutMs ?? 3000;
		this.#queue = options.queue ?? 4;
		this.#spawn =
			options.spawn ??
			(() => new Worker(new URL("./diagram-worker.ts", import.meta.url)));
	}

	/** The SVG of `source`, or rejects with a `DiagramRefusal`. */
	draw(source: string, scheme: "light" | "dark"): Promise<string> {
		if (this.#waiting > this.#queue)
			return Promise.reject(new DiagramRefusal("busy"));
		this.#waiting += 1;
		const turn = this.#tail.then(
			() => this.#run(source, scheme),
			() => this.#run(source, scheme),
		);
		this.#tail = turn.catch(() => undefined);
		return turn.finally(() => {
			this.#waiting -= 1;
		});
	}

	#start(): Promise<Worker> {
		this.#worker ??= new Promise<Worker>((resolve, reject) => {
			const worker = this.#spawn();
			this.#current = worker;
			// An idle worker does not keep the console's process running.
			worker.unref();
			const timer = setTimeout(() => {
				this.#drop(worker);
				reject(new DiagramRefusal("busy"));
			}, START_MS);
			worker.once("error", () => {
				clearTimeout(timer);
				this.#drop(worker);
				reject(new DiagramRefusal("busy"));
			});
			worker.once("exit", () => this.#forget(worker));
			worker.once("message", () => {
				clearTimeout(timer);
				resolve(worker);
			});
		});
		return this.#worker;
	}

	/** Forgets the worker if it is the current one; a later one is left alone. */
	#forget(worker: Worker): void {
		if (this.#current !== worker) return;
		this.#current = undefined;
		this.#worker = undefined;
	}

	/** Ends a worker; the next drawing starts a fresh one. */
	#drop(worker: Worker): void {
		this.#forget(worker);
		void worker.terminate();
	}

	async #run(source: string, scheme: "light" | "dark"): Promise<string> {
		const worker = await this.#start();
		const id = this.#nextId++;
		return new Promise<string>((resolve, reject) => {
			const done = () => {
				clearTimeout(timer);
				worker.off("message", onMessage);
				worker.off("error", onError);
			};
			const onMessage = (reply: Reply) => {
				if (reply.id !== id) return;
				done();
				if (reply.svg !== undefined) resolve(reply.svg);
				else reject(new DiagramRefusal("invalid"));
			};
			const onError = () => {
				done();
				this.#drop(worker);
				reject(new DiagramRefusal("invalid"));
			};
			const timer = setTimeout(() => {
				done();
				this.#drop(worker);
				reject(new DiagramRefusal("slow"));
			}, this.#timeoutMs);
			worker.on("message", onMessage);
			worker.on("error", onError);
			worker.postMessage({ id, source, scheme });
		});
	}
}
