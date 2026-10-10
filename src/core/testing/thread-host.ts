import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DispatchThreads,
	type ThreadHost,
} from "../discord/dispatch-threads.ts";
import type { InterimMessage } from "../domain/interim.ts";
import { silentLogger } from "../log.ts";

/** A ThreadHost that records what happens; parents in `hostless` cannot host threads. */
export class FakeThreadHost implements ThreadHost {
	/** Start lines by parent id, as last edited. */
	readonly lines = new Map<string, string>();
	readonly opened: { parentId: string; name: string; id: string }[] = [];
	readonly posts: { threadId: string; text: string }[] = [];
	readonly closed: string[] = [];
	/** Edits of messages `send` posted, in order; each also changes its entry in `posts`. */
	readonly edits: { threadId: string; text: string }[] = [];
	readonly hostless = new Set<string>();
	failOpen = false;
	#next = 900;

	async open(
		parentId: string,
		name: string,
		line: (thread?: string) => string,
	): Promise<string | undefined> {
		if (this.hostless.has(parentId)) return undefined;
		if (this.failOpen) throw new Error("Missing Permissions");
		const id = String(this.#next++);
		this.opened.push({ parentId, name, id });
		this.lines.set(parentId, line(`<#${id}>`));
		return id;
	}

	async post(threadId: string, text: string): Promise<void> {
		this.posts.push({ threadId, text });
	}

	async send(threadId: string, text: string): Promise<InterimMessage> {
		const post = { threadId, text };
		this.posts.push(post);
		return {
			edit: async (change) => {
				post.text = change;
				this.edits.push({ threadId, text: change });
			},
		};
	}

	async close(threadId: string): Promise<void> {
		this.closed.push(threadId);
	}

	/** The texts posted in one thread, in order. */
	textsIn(threadId: string): string[] {
		return this.posts.filter((p) => p.threadId === threadId).map((p) => p.text);
	}
}

/** Dispatch threads over a fake host, with a ledger in a fresh temporary directory. */
export function fakeThreads(host = new FakeThreadHost()) {
	const ledgerPath = join(
		mkdtempSync(join(tmpdir(), "roundtable-threads-")),
		"dispatch-threads.json",
	);
	const threads = new DispatchThreads({
		host,
		ledgerPath,
		logger: silentLogger(),
	});
	return { host, threads, ledgerPath };
}
