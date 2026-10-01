import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ChannelKey } from "../domain/conversation.ts";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../log.ts";

const PREFIX = "discord:";
/** Discord's limit on a thread name. */
const THREAD_NAME_LIMIT = 100;

/** The chat side of dispatch threads; the Discord surface implements it. */
export interface ThreadHost {
	/**
	 * Posts the start line in the parent and opens a public thread from it; `line` gets the
	 * thread's mention once it exists. Undefined when the parent cannot host threads, such as a
	 * DM or a thread; throws when Discord refuses.
	 */
	open(
		parentId: string,
		name: string,
		line: (thread?: string) => string,
	): Promise<string | undefined>;
	post(threadId: string, text: string): Promise<void>;
	/** Archives the thread, and locks it when allowed. */
	close(threadId: string): Promise<void>;
}

/** One background dispatch's thread: its progress while it runs, then its report. */
export interface DispatchThread {
	readonly id: string;
	/** The thread as a conversation channel, where its owner cards are posted. */
	readonly channel: ChannelKey;
	/** `<#id>`, for the report turn and the start line. */
	readonly mention: string;
	/** Posts in the thread; a failure is logged. */
	post(text: string): Promise<void>;
	/** Posts the final report, if any, then archives the thread. Runs once; never rejects. */
	close(report?: string): Promise<void>;
}

export interface DispatchThreadsOptions {
	host: ThreadHost;
	/** Threads still open, so a start after a crash can archive them. */
	ledgerPath: string;
	/** Channels whose claims keep reports in place rather than opening threads. */
	excluded?: (channel: ChannelKey) => boolean;
	logger: Logger;
}

interface LedgerEntry {
	title: string;
	parent: ChannelKey;
	startedAt: string;
}

/** The thread's name: the title on one line, within Discord's limit. */
export function threadName(title: string): string {
	const line = title.replace(/\s+/g, " ").trim() || "dispatch";
	return line.length > THREAD_NAME_LIMIT
		? `${line.slice(0, THREAD_NAME_LIMIT - 1)}…`
		: line;
}

/**
 * Background dispatches (coding tasks, delegated tasks, messages between agents) each get a
 * thread in the channel that started them, leaving one start line there. A channel that cannot
 * host one, or a failed creation, gets no thread, and the dispatch posts as before.
 */
export class DispatchThreads {
	readonly #options: DispatchThreadsOptions;
	readonly #open = new Map<string, LedgerEntry>();

	constructor(options: DispatchThreadsOptions) {
		this.#options = options;
		const { ledgerPath } = options;
		if (!existsSync(ledgerPath)) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
		} catch (error) {
			throw new Error(`${ledgerPath} is not valid JSON`, { cause: error });
		}
		if (typeof parsed !== "object" || parsed === null)
			throw new Error(`${ledgerPath} must hold a JSON object`);
		for (const [id, entry] of Object.entries(parsed))
			this.#open.set(id, entry as LedgerEntry);
	}

	/** Opens the dispatch's thread under `origin`, posting `intro` first; never rejects. */
	async open(
		origin: ChannelKey | undefined,
		title: string,
		intro?: string,
	): Promise<DispatchThread | undefined> {
		const { host, excluded, logger } = this.#options;
		if (!origin?.startsWith(PREFIX) || excluded?.(origin)) return undefined;
		const name = threadName(title);
		let id: string | undefined;
		try {
			id = await host.open(origin.slice(PREFIX.length), name, (thread) =>
				messages().threadStarted(name, thread),
			);
		} catch (error) {
			logger.warn({ origin, err: error }, "dispatch thread not opened");
			return undefined;
		}
		if (!id) return undefined;
		this.#open.set(id, {
			title: name,
			parent: origin,
			startedAt: new Date().toISOString(),
		});
		this.#write();
		logger.info({ origin, thread: id }, "dispatch thread opened");
		const thread = this.#thread(id);
		if (intro) await thread.post(intro);
		return thread;
	}

	/** Archives the threads a restart left open; their dispatches never report. */
	async sweep(): Promise<void> {
		for (const id of [...this.#open.keys()])
			await this.#thread(id).close(messages().restartNotice);
	}

	#thread(id: string): DispatchThread {
		const { host, logger } = this.#options;
		let closed = false;
		const post = async (text: string) => {
			try {
				await host.post(id, text);
			} catch (error) {
				logger.warn({ thread: id, err: error }, "dispatch thread post failed");
			}
		};
		return {
			id,
			channel: `${PREFIX}${id}`,
			mention: `<#${id}>`,
			post,
			close: async (report) => {
				if (closed) return;
				closed = true;
				if (report) await post(report);
				try {
					await host.close(id);
				} catch (error) {
					logger.warn(
						{ thread: id, err: error },
						"dispatch thread not archived",
					);
				}
				this.#open.delete(id);
				this.#write();
			},
		};
	}

	#write(): void {
		const path = this.#options.ledgerPath;
		try {
			mkdirSync(dirname(path), { recursive: true });
			const temporary = `${path}.tmp`;
			writeFileSync(
				temporary,
				`${JSON.stringify(Object.fromEntries(this.#open), null, 2)}\n`,
				{ mode: 0o600 },
			);
			renameSync(temporary, path);
		} catch (error) {
			this.#options.logger.warn({ err: error }, "dispatch threads not saved");
		}
	}
}
