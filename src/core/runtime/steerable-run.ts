import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TurnAttachments } from "../domain/attachment.ts";

export type PromptImages = NonNullable<Parameters<AgentSession["steer"]>[1]>;

/** A turn's images as Pi takes them with a prompt or a steer. */
export function promptImages(attachments: TurnAttachments): PromptImages {
	return attachments.images.map((image) => ({
		type: "image" as const,
		...image,
	}));
}

/** The part of a Pi session a steerable run drives. */
export type SteeringSession = Pick<
	AgentSession,
	| "isStreaming"
	| "steer"
	| "getSteeringMessages"
	| "clearQueue"
	| "abort"
	| "prompt"
	| "waitForIdle"
>;

/**
 * One turn of a Pi session that the owner may steer or stop. Pi checks its queue once more
 * after a run, but a steer whose input handling ends after the session settled stays queued,
 * where the next run would pick it up out of order; `run` answers it in the same turn instead.
 */
export class SteerableRun {
	readonly #session: SteeringSession;
	readonly #canSteer: () => boolean;
	/** Steered prompts in arrival order, each with its images. */
	readonly #steers: { text: string; images: PromptImages }[] = [];
	readonly #abort: () => void;
	#stopped = false;
	#done = false;

	/**
	 * `canSteer` is asked at each steer: the turn is the owner's and holds no actions. `abort`
	 * ends the session's run when the turn is stopped; by default the session's own abort.
	 */
	constructor(
		session: SteeringSession,
		canSteer: () => boolean,
		abort: () => void = () => void session.abort(),
	) {
		this.#session = session;
		this.#canSteer = canSteer;
		this.#abort = abort;
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	/** Whether any message was steered into the turn. */
	get steered(): boolean {
		return this.#steers.length > 0;
	}

	/** Runs the turn's first prompt, then any steer Pi left queued as the run ended. */
	async run(first: () => Promise<void>): Promise<void> {
		try {
			await first();
			for (
				let left = this.#leftovers();
				left.length > 0 && !this.#stopped;
				left = this.#leftovers()
			) {
				this.#session.clearQueue();
				await this.#session.waitForIdle();
				const images = left.flatMap((steer) => steer.images);
				await this.#session.prompt(
					left.map((steer) => steer.text).join("\n\n"),
					images.length > 0 ? { images } : undefined,
				);
			}
		} finally {
			// Synchronous with the last leftover check, so no steer slips between the two.
			this.#done = true;
		}
	}

	/** Adds the text to the running turn; false when it must wait for a turn of its own. */
	async steer(text: string, images: PromptImages): Promise<boolean> {
		if (
			this.#stopped ||
			this.#done ||
			!this.#session.isStreaming ||
			!this.#canSteer()
		)
			return false;
		const steer = { text, images };
		// Recorded first, so a run ending meanwhile finds it among the leftovers.
		this.#steers.push(steer);
		try {
			await this.#session.steer(text, images.length > 0 ? images : undefined);
		} catch (error) {
			this.#steers.splice(this.#steers.indexOf(steer), 1);
			throw error;
		}
		// Queued after the turn stopped taking steers: taken back to wait for its own turn.
		if (this.#done && this.#session.getSteeringMessages().includes(text)) {
			this.#session.clearQueue();
			this.#steers.splice(this.#steers.indexOf(steer), 1);
			return false;
		}
		return true;
	}

	/** Aborts the turn and drops what was steered into it; false once it has ended. */
	stop(): boolean {
		if (this.#done) return false;
		this.#stopped = true;
		this.#session.clearQueue();
		this.#abort();
		return true;
	}

	/** Steers still in Pi's queue: sent as the run ended, so the model never saw them. */
	#leftovers() {
		const queued = this.#session.getSteeringMessages();
		return this.#steers.filter((steer) => queued.includes(steer.text));
	}
}
