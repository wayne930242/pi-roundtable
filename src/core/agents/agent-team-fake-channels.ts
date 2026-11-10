import type {
	AgentCategory,
	AgentChannels,
	AgentPost,
	CategoryLayout,
	ChannelMessage,
} from "./agent-ports.ts";

/** The Discord channels of a team, recorded: what was posted, made, moved and read. */
export class FakeChannels implements AgentChannels {
	posts: { channelId: string; post: AgentPost }[] = [];
	created: string[] = [];
	deleted = new Set<string>();
	/** Channels that are another server's. */
	foreign = new Set<string>();
	#next = 2000;
	async post(channelId: string, post: AgentPost) {
		this.posts.push({ channelId, post });
	}
	/** The server's categories in order, each with its channels in order. */
	categories: CategoryLayout[] = [];
	#nextCategory = 9000;
	arranged: { layout: CategoryLayout[]; remove: string[] }[] = [];
	categoryOf(channelId: string) {
		return this.categories.find((c) => c.channelIds.includes(channelId))?.name;
	}
	/** Moves a channel to the end of the category, made when missing. */
	put(channelId: string, category: AgentCategory) {
		for (const c of this.categories)
			c.channelIds = c.channelIds.filter((id) => id !== channelId);
		let found = this.categories.find((c) => c.name === category);
		if (!found) {
			found = {
				id: String(this.#nextCategory++),
				name: category,
				channelIds: [],
			};
			this.categories.push(found);
		}
		found.channelIds.push(channelId);
	}
	async createChannel(name: string, topic: string, category: AgentCategory) {
		this.created.push(name);
		const id = String(this.#next++);
		this.topics.set(id, topic);
		this.put(id, category);
		return id;
	}
	/** The threads made under a channel for temp knights, by id; `archived` once closed. */
	threads = new Map<
		string,
		{ parent: string; name: string; archived: boolean }
	>();
	async createThread(parentChannelId: string, name: string) {
		const id = String(this.#next++);
		this.threads.set(id, { parent: parentChannelId, name, archived: false });
		return id;
	}
	async closeThread(threadId: string) {
		const thread = this.threads.get(threadId);
		if (thread) thread.archived = true;
	}
	async openThread(threadId: string) {
		const thread = this.threads.get(threadId);
		if (thread) thread.archived = false;
	}
	async placeIn(channelId: string, category: AgentCategory) {
		if (this.categoryOf(channelId) === category) return false;
		this.put(channelId, category);
		return true;
	}
	async layout() {
		return structuredClone(this.categories);
	}
	async arrange(layout: CategoryLayout[], remove: string[]) {
		this.arranged.push({ layout: structuredClone(layout), remove });
		this.categories = layout.map((c) => ({
			id: c.id ?? String(this.#nextCategory++),
			name: c.name,
			channelIds: [...c.channelIds],
		}));
	}
	history: ChannelMessage[] = [];
	reads: { channelId: string; limit: number; around?: string }[] = [];
	async read(channelId: string, options: { limit: number; around?: string }) {
		this.reads.push({ channelId, ...options });
		return this.history;
	}
	topics = new Map<string, string>();
	async setTopic(channelId: string, topic: string) {
		this.topics.set(channelId, topic);
	}
	async exists(channelId: string) {
		return !this.deleted.has(channelId);
	}
	webhooksRemoved: string[] = [];
	async removeWebhook(channelId: string) {
		this.webhooksRemoved.push(channelId);
	}
	texts(channelId: string) {
		return this.posts.flatMap((p) =>
			p.channelId === channelId
				? [`${p.post.name}: ${p.post.chunks.join("")}`]
				: [],
		);
	}
}
