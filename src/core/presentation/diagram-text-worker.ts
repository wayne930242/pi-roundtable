import { parentPort, workerData } from "node:worker_threads";
import { mermaidText } from "pi-better-show/server";

/**
 * Draws Mermaid sources as text off the host's thread (see `diagram-text.ts`). The result goes back
 * through shared memory, since the host waits on it without running its event loop: word 0 is the
 * state (1 = working, 2 = answered), word 1 the byte length of the text, or -1 for none.
 */
const shared = (workerData as { shared: SharedArrayBuffer }).shared;
const head = new Int32Array(shared, 0, 4);
const body = new Uint8Array(shared, 16);

parentPort?.on("message", (source: string) => {
	const text = mermaidText(source);
	const bytes = text === undefined ? undefined : new TextEncoder().encode(text);
	if (!bytes || bytes.length > body.length) head[1] = -1;
	else {
		body.set(bytes);
		head[1] = bytes.length;
	}
	Atomics.store(head, 0, 2);
	Atomics.notify(head, 0);
});
Atomics.store(head, 0, 1);
Atomics.notify(head, 0);
