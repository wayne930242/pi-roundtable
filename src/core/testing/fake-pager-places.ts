import type {
	PlaceCheck,
	PlaceProvider,
	PlaceRef,
} from "../contract/places.ts";
import { channelKey, parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { PluginError } from "../kernel/errors.ts";
import type { PlaceSeen } from "./place-contract.ts";

/** The surface of the fake pager network. */
export const PAGER = "pager";

interface Page {
	name: string;
	topic: string;
	/** The page this one was made under, for a temp knight's thread. */
	parent?: string;
	archived: boolean;
	messages: { id: number; author: string; text: string }[];
}

/**
 * A chat network the core has never heard of, whose places are pages it makes with ids of its
 * own: a stored provider with `ensure`, `remove`, `check`, `describe`, `onRemoved` and `mention`,
 * and a person's view of it. An id that starts with `other-` is a page of another network.
 */
export class FakePager {
	readonly pages = new Map<string, Page>();
	readonly #listeners: ((id: string) => void)[] = [];
	#next = 1;
	#message = 1;
	readonly #prefix: string;

	/** `prefix` starts the ids of the pages it makes (`pg-1`), so a test that binds ids of its own cannot meet them. */
	constructor(prefix = "pg") {
		this.#prefix = prefix;
	}

	readonly provider: PlaceProvider = {
		surface: PAGER,
		storage: "stored",
		key: (_ref: PlaceRef, id?: string): ChannelKey => {
			if (id === undefined)
				throw new PluginError("a pager place is keyed by its page id");
			return channelKey(PAGER, id);
		},
		placeOf: (key) => {
			if (!key.includes(":")) return undefined;
			const parsed = parseChannelKey(key);
			return parsed.surface === PAGER ? { id: parsed.id } : undefined;
		},
		post: async (key, post) => {
			const page = this.#page(key);
			if (post.thinking) this.#add(page, post.author.name, post.thinking);
			for (const chunk of post.chunks) this.#add(page, post.author.name, chunk);
		},
		interim: (key, author) => ({
			post: async (text) => {
				const page = this.#page(key);
				const message = this.#add(page, author.name, text);
				return {
					edit: async (change) => {
						message.text = change;
					},
				};
			},
		}),
		ensure: async (spec) => {
			const existing =
				spec.existing === undefined ? undefined : this.pages.get(spec.existing);
			if (spec.existing !== undefined && existing) {
				existing.archived = false;
				return spec.existing;
			}
			const id = `${this.#prefix}-${this.#next++}`;
			this.pages.set(id, {
				name: spec.name,
				topic: spec.topic,
				...(spec.parent === undefined ? {} : { parent: spec.parent }),
				archived: false,
				messages: [],
			});
			return id;
		},
		remove: async (id) => {
			const page = this.pages.get(id);
			if (page) page.archived = true;
			return `; its page ${id} is kept.`;
		},
		check: async (id): Promise<PlaceCheck> => {
			if (id.startsWith("other-")) return "foreign";
			return this.pages.has(id) ? "ok" : "gone";
		},
		describe: async (id, topic) => {
			const page = this.pages.get(id);
			if (page) page.topic = topic;
		},
		onRemoved: (listener) => {
			this.#listeners.push(listener);
		},
		mention: (key) => `page ${parseChannelKey(key).id}`,
	};

	/** The network already has a page `id` that the team did not make, as a bound place would be. */
	adopt(id: string, name: string, topic = name): void {
		this.pages.set(id, { name, topic, archived: false, messages: [] });
	}

	/** Everything a person reading the page of `key` has seen. */
	seen(key: ChannelKey): readonly PlaceSeen[] {
		return (this.pages.get(parseChannelKey(key).id)?.messages ?? []).map(
			({ author, text }) => ({ author, text }),
		);
	}

	/** A person deletes the page, and the network tells the listeners. */
	delete(id: string): void {
		this.pages.delete(id);
		for (const listener of this.#listeners) listener(id);
	}

	#page(key: ChannelKey): Page {
		const page = this.pages.get(parseChannelKey(key).id);
		if (!page) throw new PluginError(`no page ${key}`);
		return page;
	}

	#add(page: Page, author: string, text: string) {
		const message = { id: this.#message++, author, text };
		page.messages.push(message);
		return message;
	}
}
