import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	channelKey,
	parseChannelKey,
	type SurfacePort,
	type SurfaceThreads,
} from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { InterimMessage, InterimPosts } from "../domain/interim.ts";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../log.ts";
import { threadsOfHost } from "./host-threads.ts";

/** The only surface a `ThreadHost` serves. */
const DISCORD_PREFIX = "discord:";
/** Discord's limit on a thread name. */
const THREAD_NAME_LIMIT = 100;

/**
 * The chat side of dispatch threads in Discord's terms: ids are Discord channel ids.
 *
 * @deprecated Until 1.0. A surface hosts dispatch threads with `ChatSurface.threads`
 * (`SurfaceThreads`), for any chat network; the Discord surface implements it. Pass `surfaces`
 * to `DispatchThreads` instead of a host.
 */
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
	/**
	 * Posts one message of at most Discord's 2000 characters and resolves to it, so it can be
	 * edited in place; without it a thread has no `interim` posts.
	 */
	send?(threadId: string, text: string): Promise<InterimMessage>;
	/** Archives the thread, and locks it when allowed. */
	close(threadId: string): Promise<void>;
}

/** One background dispatch's thread: its progress while it runs, then its report. */
export interface DispatchThread {
	/** The thread's id on its surface, such as the Discord thread's channel id. */
	readonly id: string;
	/** The thread as a conversation channel, `<surface>:<id>`, where its owner cards are posted. */
	readonly channel: ChannelKey;
	/** How the thread is named in text, such as `<#id>` on Discord: for the report turn and the start line. */
	readonly mention: string;
	/** Posts in the thread; a failure is logged. */
	post(text: string): Promise<void>;
	/**
	 * Where the dispatch posts its progress as it goes, under the same name as its report, such
	 * as a coding worker's interim text; absent when the surface cannot edit a message it posted.
	 * Unlike `post`, a failure rejects.
	 */
	readonly interim?: InterimPosts;
	/** Posts the final report, if any, then archives the thread. Runs once; never rejects. */
	close(report?: string): Promise<void>;
}

export interface DispatchThreadsOptions {
	/**
	 * The chat surfaces. A dispatch started in a channel opens its thread through the `threads` of
	 * the surface that serves the channel's prefix; a channel whose surface has none gets no thread.
	 * Give this or `host`, not both.
	 */
	surfaces?: Pick<SurfacePort, "of">;
	/**
	 * Discord's thread host, for the `discord:` channels only.
	 *
	 * @deprecated Until 1.0; use `surfaces`, which serves every surface that hosts threads.
	 */
	host?: ThreadHost;
	/** Threads still open, so a start after a crash can close them. */
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
 * thread in the channel that started them, leaving one start line there. The thread lives on the
 * surface of that channel, picked by the prefix of its key. A channel that cannot host one, or a
 * failed creation, gets no thread, and the dispatch posts as before.
 */
export class DispatchThreads {
	readonly #options: DispatchThreadsOptions;
	readonly #threadsOf: (channel: ChannelKey) => SurfaceThreads | undefined;
	/** The threads still open, by their channel key, `<surface>:<id>`. */
	readonly #open = new Map<ChannelKey, LedgerEntry>();

	constructor(options: DispatchThreadsOptions) {
		this.#options = options;
		const { surfaces, host, ledgerPath } = options;
		if (surfaces && host)
			throw new Error(
				"DispatchThreadsOptions takes surfaces or the deprecated host, not both",
			);
		if (surfaces) {
			this.#threadsOf = (channel) => surfaces.of(channel)?.threads;
		} else if (host) {
			const discord = threadsOfHost(host);
			this.#threadsOf = (channel) =>
				channel.startsWith(DISCORD_PREFIX) ? discord : undefined;
		} else {
			throw new Error(
				"DispatchThreadsOptions needs surfaces, the chat surfaces that host the threads",
			);
		}
		if (!existsSync(ledgerPath)) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
		} catch (error) {
			throw new Error(`${ledgerPath} is not valid JSON`, { cause: error });
		}
		if (typeof parsed !== "object" || parsed === null)
			throw new Error(`${ledgerPath} must hold a JSON object`);
		for (const [key, entry] of Object.entries(parsed))
			this.#open.set(this.#keyed(key, entry as LedgerEntry), entry);
	}

	/**
	 * The channel key of a ledger entry. Before 0.23 the ledger was keyed by the Discord thread's
	 * bare id; the surface then follows from the entry's parent.
	 */
	#keyed(key: string, entry: LedgerEntry): ChannelKey {
		const at = key.indexOf(":");
		if (at > 0) return channelKey(key.slice(0, at), key.slice(at + 1));
		const { ledgerPath } = this.#options;
		if (typeof entry?.parent !== "string" || !entry.parent.includes(":"))
			throw new Error(
				`${ledgerPath}: the thread ${key} has no parent channel to find its surface by`,
			);
		return channelKey(parseChannelKey(entry.parent).surface, key);
	}

	/** Opens the dispatch's thread under `origin`, posting `intro` first; never rejects. */
	async open(
		origin: ChannelKey | undefined,
		title: string,
		intro?: string,
	): Promise<DispatchThread | undefined> {
		const { excluded, logger } = this.#options;
		const threads = origin ? this.#threadsOf(origin) : undefined;
		if (!origin || !threads || excluded?.(origin)) return undefined;
		const name = threadName(title);
		let opened: { id: string; mention: string } | undefined;
		try {
			opened = await threads.open(origin, name, (mention) =>
				messages().threadStarted(name, mention),
			);
		} catch (error) {
			logger.warn({ origin, err: error }, "dispatch thread not opened");
			return undefined;
		}
		if (!opened?.id) return undefined;
		const channel = channelKey(parseChannelKey(origin).surface, opened.id);
		this.#open.set(channel, {
			title: name,
			parent: origin,
			startedAt: new Date().toISOString(),
		});
		this.#write();
		logger.info({ origin, thread: channel }, "dispatch thread opened");
		const thread = this.#thread(channel, threads, opened.mention);
		if (intro) await thread.post(intro);
		return thread;
	}

	/** Closes the threads a restart left open; their dispatches never report. */
	async sweep(): Promise<void> {
		for (const [channel, entry] of [...this.#open]) {
			const threads = this.#threadsOf(entry.parent);
			if (threads) {
				await this.#thread(channel, threads).close(messages().restartNotice);
				continue;
			}
			// Its surface is no longer installed or hosts no threads, so nothing can close it.
			this.#options.logger.warn(
				{ thread: channel, parent: entry.parent },
				"dispatch thread dropped: its surface hosts no threads",
			);
			this.#open.delete(channel);
			this.#write();
		}
	}

	#thread(
		channel: ChannelKey,
		threads: SurfaceThreads,
		mention = "",
	): DispatchThread {
		const { logger } = this.#options;
		const { id } = parseChannelKey(channel);
		let closed = false;
		const send = threads.send?.bind(threads);
		const post = async (text: string) => {
			try {
				await threads.post(id, text);
			} catch (error) {
				logger.warn(
					{ thread: channel, err: error },
					"dispatch thread post failed",
				);
			}
		};
		return {
			id,
			channel,
			mention,
			post,
			...(send ? { interim: { post: (text: string) => send(id, text) } } : {}),
			close: async (report) => {
				if (closed) return;
				closed = true;
				if (report) await post(report);
				try {
					await threads.close(id);
				} catch (error) {
					logger.warn(
						{ thread: channel, err: error },
						"dispatch thread not archived",
					);
				}
				this.#open.delete(channel);
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
