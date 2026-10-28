import type { SurfaceThreads } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { InterimMessage } from "../domain/interim.ts";

/**
 * A surface's `threads` that records what happens, for a test of the core over a surface other
 * than Discord. A thread's id is `thread.<n>`, as the web's are `thread.<uuid>`, and its mention
 * is its name; parents in `hostless` cannot host threads.
 */
export class FakeSurfaceThreads implements SurfaceThreads {
	/** Start lines by parent key, as last edited. */
	readonly lines = new Map<ChannelKey, string>();
	readonly opened: { parent: ChannelKey; name: string; id: string }[] = [];
	readonly posts: { thread: string; text: string }[] = [];
	readonly closed: string[] = [];
	/** Edits of messages `send` posted, in order; each also changes its entry in `posts`. */
	readonly edits: { thread: string; text: string }[] = [];
	readonly hostless = new Set<ChannelKey>();
	failOpen = false;
	#next = 1;

	async open(
		parent: ChannelKey,
		name: string,
		line: (mention?: string) => string,
	): Promise<{ id: string; mention: string } | undefined> {
		if (this.hostless.has(parent)) return undefined;
		if (this.failOpen) throw new Error("the surface refused");
		const id = `thread.${this.#next++}`;
		this.opened.push({ parent, name, id });
		this.lines.set(parent, line(name));
		return { id, mention: name };
	}

	async post(thread: string, text: string): Promise<void> {
		this.posts.push({ thread, text });
	}

	async send(thread: string, text: string): Promise<InterimMessage> {
		const post = { thread, text };
		this.posts.push(post);
		return {
			edit: async (change) => {
				post.text = change;
				this.edits.push({ thread, text: change });
			},
		};
	}

	async close(thread: string): Promise<void> {
		this.closed.push(thread);
	}

	/** The texts posted in one thread, in order. */
	textsIn(thread: string): string[] {
		return this.posts.filter((p) => p.thread === thread).map((p) => p.text);
	}
}
