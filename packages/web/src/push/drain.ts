import type { Logger } from "pi-roundtable";
import type { DeliveryResult, OutboxRow, PushOutbox } from "./outbox.ts";

/** How a transport carries a push; a host adds its own beside `web-push`. */
export interface PushTransport {
	/** The name a notice's `via` uses, such as `web-push`. */
	name: string;
	send(
		row: OutboxRow,
		rendered: { title: string; body?: string },
		signal: AbortSignal,
	): Promise<DeliveryResult>;
}

export interface OutboxSenderOptions {
	outbox: Pick<PushOutbox, "claim" | "finish" | "sweep">;
	/** Tried in order for each row until one says `sent`. */
	transports: readonly PushTransport[];
	/** Words a row. With push.content `none` a row carries no text, so this is where it comes from. */
	render(row: OutboxRow): { title: string; body?: string };
	logger: Logger;
	/** How often the outbox is looked at; default 1 s. */
	intervalMs?: number;
	/** How long one transport may take for one row; default 20 s. */
	transportTimeoutMs?: number;
	/** The most rows taken at once; default 20. */
	batch?: number;
}

const SWEEP_EVERY_MS = 3_600_000;

/**
 * The loop that empties the push outbox: it takes queued rows, words each with `render`, offers it
 * to the row's transports in order until one says `sent`, and records what each said. A transport
 * that throws or runs out of time counts as `failed`; one row never stops the others.
 */
export class OutboxSender {
	readonly #options: OutboxSenderOptions;
	#timer: ReturnType<typeof setInterval> | undefined;
	#sweeper: ReturnType<typeof setInterval> | undefined;
	#running: Promise<number> | undefined;
	#stopped = false;

	constructor(options: OutboxSenderOptions) {
		this.#options = options;
	}

	start(): void {
		this.#stopped = false;
		this.#timer = setInterval(() => {
			this.drain().catch((error: unknown) =>
				this.#options.logger.warn(
					{ err: error },
					"the push outbox was not read",
				),
			);
		}, this.#options.intervalMs ?? 1000);
		this.#sweeper = setInterval(() => {
			this.#options.outbox
				.sweep()
				.catch((error: unknown) =>
					this.#options.logger.warn(
						{ err: error },
						"old pushes were not deleted",
					),
				);
		}, SWEEP_EVERY_MS);
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		clearInterval(this.#timer);
		clearInterval(this.#sweeper);
		await this.#running?.catch(() => undefined);
	}

	/** Takes and sends what is queued now; returns how many rows it finished. Calls do not overlap. */
	drain(): Promise<number> {
		this.#running ??= this.#drain().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	async #drain(): Promise<number> {
		let finished = 0;
		for (;;) {
			if (this.#stopped) return finished;
			const rows = await this.#options.outbox.claim(this.#options.batch ?? 20);
			if (rows.length === 0) return finished;
			for (const row of rows) {
				await this.#one(row);
				finished += 1;
			}
		}
	}

	async #one(row: OutboxRow): Promise<void> {
		const { transports, logger } = this.#options;
		const chosen = row.via
			? row.via.flatMap((name) => {
					const found = transports.find((t) => t.name === name);
					return found ? [found] : [];
				})
			: transports;
		const deliveries: { transport: string; result: DeliveryResult }[] = [];
		let rendered: { title: string; body?: string };
		try {
			// A row that clears a notice has no words.
			rendered =
				row.kind === "clear" ? { title: "" } : this.#options.render(row);
		} catch (error) {
			logger.warn({ err: error, kind: row.kind }, "a push was not worded");
			await this.#options.outbox.finish(row.id, [
				{ transport: "render", result: "failed" },
			]);
			return;
		}
		for (const transport of chosen) {
			let result: DeliveryResult;
			try {
				result = await transport.send(
					row,
					rendered,
					AbortSignal.timeout(this.#options.transportTimeoutMs ?? 20_000),
				);
			} catch (error) {
				logger.warn(
					{ err: error, transport: transport.name },
					"a push transport failed",
				);
				result = "failed";
			}
			deliveries.push({ transport: transport.name, result });
			if (result === "sent") break;
		}
		await this.#options.outbox.finish(row.id, deliveries);
	}
}
