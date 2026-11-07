import { parentPort } from "node:worker_threads";
import { mermaidSvg } from "pi-better-show/server";

/** Draws the diagrams of `diagram-renderer.ts` off the console's thread, one request at a time. */
interface Job {
	id: number;
	source: string;
	scheme: "light" | "dark";
}

parentPort?.on("message", (job: Job) => {
	try {
		const svg = mermaidSvg(job.source, {
			scheme: job.scheme,
			transparent: true,
		});
		parentPort?.postMessage({ id: job.id, svg });
	} catch {
		parentPort?.postMessage({ id: job.id, refused: true });
	}
});
parentPort?.postMessage({ ready: true });
