import type { InterimMessage, InterimPosts } from "../domain/interim.ts";
import type { TurnRequest } from "../domain/ports.ts";
import type { Logger } from "../log.ts";
import {
	DISCORD_MESSAGE_LIMIT,
	splitReply,
} from "../presentation/reply-splitter.ts";
import { textOf } from "../shared/session-messages.ts";
import type { PiAgentRuntimeOptions } from "./runtime-types.ts";

/** An intermediate text this long or longer is posted as an ordinary message. */
export const PRIMARY_CHARS = 400;
/** The progress message is edited at most this often; its last state always lands. */
export const PROGRESS_EDIT_MS = 1_500;

const STRUCTURE = /^\s{0,3}(#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s|\|.*\|)/m;

/**
 * Whether an intermediate text is content the owner must read, such as a proposal or findings:
 * long, or written with a Markdown heading, list, table, or code fence. Shorter narration
 * between tool calls goes to the progress message instead.
 */
export function isPrimaryText(
	text: string,
	primaryChars = PRIMARY_CHARS,
): boolean {
	return text.length >= primaryChars || STRUCTURE.test(text);
}

/**
 * A run's progress message: its narration lines, then the tools it called, all in Discord's
 * small text and kept inside one message by dropping the oldest lines behind a "…" marker.
 */
export function progressText(
	lines: readonly string[],
	tools: ReadonlyMap<string, number>,
): string {
	const small = (line: string) => `-# ${line}`;
	const toolLine =
		tools.size > 0
			? small(
					[...tools]
						.map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
						.join(" · "),
				).slice(0, DISCORD_MESSAGE_LIMIT)
			: undefined;
	const body = lines
		.flatMap((text) => text.split("\n"))
		.map((line) => line.trim())
		.filter(Boolean)
		.map(small);
	const tail = toolLine ? [toolLine] : [];
	const fits = (kept: string[]) =>
		[...kept, ...tail].join("\n").length <= DISCORD_MESSAGE_LIMIT;
	if (fits(body)) return [...body, ...tail].join("\n");
	const marker = small("…");
	let kept = body;
	while (kept.length > 0 && !fits([marker, ...kept])) kept = kept.slice(1);
	if (kept.length === 0 && body.length > 0) {
		// One line alone is too long: keep its end.
		const room =
			DISCORD_MESSAGE_LIMIT - [marker, ...tail].join("\n").length - 4;
		const last = body.at(-1) ?? "";
		kept = room > 0 ? [small(`…${last.slice(-room)}`)] : [];
		return [...kept, ...tail].join("\n");
	}
	return [marker, ...kept, ...tail].join("\n");
}

interface Run {
	lines: string[];
	tools: Map<string, number>;
	message?: InterimMessage;
	shown?: string;
	lastAt: number;
	timer?: ReturnType<typeof setTimeout>;
}

export interface InterimPosterOptions {
	logger: Logger;
	channel: string;
	primaryChars?: number;
	editMs?: number;
}

/**
 * Posts a turn's intermediate text as it goes. A tool-calling assistant message whose text is
 * primary is posted as ordinary messages; shorter text joins the run's progress message with
 * the tools called, edited in place. A primary post or a card starts a new run. Posts go out
 * in order, and a failed one is logged, never thrown.
 */
export class InterimPoster {
	readonly #posts: InterimPosts;
	readonly #options: InterimPosterOptions;
	#queue: Promise<void> = Promise.resolve();
	#run: Run = newRun();

	constructor(posts: InterimPosts, options: InterimPosterOptions) {
		this.#posts = posts;
		this.#options = options;
	}

	/** A finished message of the turn; only a tool-calling assistant message is posted. */
	messageEnd(message: {
		role: string;
		content?: unknown;
		stopReason?: string;
	}): void {
		if (message.role !== "assistant" || message.stopReason !== "toolUse")
			return;
		const text = textOf(message.content).trim();
		if (!text) return;
		if (isPrimaryText(text, this.#options.primaryChars)) {
			this.#endRun();
			for (const chunk of splitReply(text))
				this.#enqueue(async () => {
					await this.#posts.post(chunk);
				}, "interim text not posted");
			return;
		}
		this.#run.lines.push(text);
		this.#changed();
	}

	/** A tool the turn started, counted on the run's tool line. */
	toolStart(name: string): void {
		const { tools } = this.#run;
		tools.set(name, (tools.get(name) ?? 0) + 1);
		this.#changed();
	}

	/**
	 * Brings every post up to date and waits for them, then starts a new run: before a card, so
	 * the text written before it shows above it, and when the turn ends, before its final reply.
	 */
	async flush(): Promise<void> {
		this.#endRun();
		await this.#queue;
	}

	#endRun(): void {
		const run = this.#run;
		this.#run = newRun();
		clearTimeout(run.timer);
		run.timer = undefined;
		this.#render(run);
	}

	/** The run changed: shown now, or once the edit interval has passed. */
	#changed(): void {
		const run = this.#run;
		if (run.timer) return;
		const wait =
			run.lastAt + (this.#options.editMs ?? PROGRESS_EDIT_MS) - now();
		if (wait <= 0) {
			this.#render(run);
			return;
		}
		run.timer = setTimeout(() => {
			run.timer = undefined;
			this.#render(run);
		}, wait);
	}

	#render(run: Run): void {
		if (run.lines.length === 0 && run.tools.size === 0) return;
		run.lastAt = now();
		const text = progressText(run.lines, run.tools);
		this.#enqueue(async () => {
			if (text === run.shown) return;
			if (run.message) await run.message.edit(text);
			else run.message = await this.#posts.post(text);
			run.shown = text;
		}, "progress message not posted");
	}

	#enqueue(step: () => Promise<void>, failure: string): void {
		const { logger, channel } = this.#options;
		this.#queue = this.#queue.then(step).catch((error: unknown) => {
			logger.warn({ channel, err: error }, failure);
		});
	}
}

/** The turn's poster, when its caller gave a place for interim posts and the host left them on. */
export function interimPoster(
	request: Pick<TurnRequest, "interim" | "channel">,
	options: Pick<
		PiAgentRuntimeOptions,
		"interimText" | "interimPrimaryChars" | "logger"
	>,
): InterimPoster | undefined {
	if (!request.interim || options.interimText === "off") return undefined;
	return new InterimPoster(request.interim, {
		logger: options.logger,
		channel: request.channel,
		...(options.interimPrimaryChars
			? { primaryChars: options.interimPrimaryChars }
			: {}),
	});
}

function newRun(): Run {
	return { lines: [], tools: new Map(), lastAt: 0 };
}

const now = () => Date.now();
