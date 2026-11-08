import {
	type AgentDirectory,
	agentRoomKey,
	type InboundMessage,
	isHelper,
	type Logger,
} from "pi-roundtable";
import type { RoomMessage } from "../api-types.ts";
import { coreMessageId } from "../app/queued-delivery.ts";
import type { NewRoomMessage } from "../app/room-log.ts";
import { readLimited } from "../request-body.ts";
import { postOf } from "./post-body.ts";
import { type StoredWebhook, viewOf, type WebhookStore } from "./store.ts";
import {
	type CreatedWebhookView,
	MAX_EXPIRING_WEBHOOKS,
	MAX_LASTING_WEBHOOKS,
	MAX_WEBHOOK_MINUTES,
	MAX_WEBHOOK_NAME,
	type WebhookOverviewView,
	type WebhookView,
} from "./types.ts";

/** The largest body a webhook post may have. */
export const MAX_POST_BYTES = 16 * 1024;
/** Posts one webhook may make in a minute. */
export const POSTS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

/** A request about webhooks that cannot be done, with the English reason; its `status` is the HTTP one. */
export class WebhookError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface WebhooksOptions {
	store: WebhookStore;
	directory: Pick<AgentDirectory, "agent">;
	/** The app's surface: where a post is shown and handed to the host. */
	surface: {
		publish(row: NewRoomMessage): Promise<RoomMessage>;
		deliver(message: InboundMessage): void;
	};
	/** The key prefix of the rooms, such as `app`. */
	surfaceName: string;
	/** The public origin and mount a webhook's URL starts with, such as `https://hooks.example.com/app`. */
	base: string;
	now?: () => number;
	logger: Logger;
}

const notFound = () =>
	new Response("Not found", {
		status: 404,
		headers: { "cache-control": "no-store" },
	});
const status = (code: number, text: string) =>
	new Response(text, {
		status: code,
		headers: { "cache-control": "no-store" },
	});

/**
 * The incoming webhooks of the agent rooms: a post to a webhook's URL shows in its agent's room
 * as an `integration` message and starts the agent's report turn, as a Discord webhook's post in
 * its channel does. Only a permanent knight that is active has webhooks that answer.
 */
export class Webhooks {
	readonly #options: WebhooksOptions;
	/** The times of each webhook's recent posts, for the rate limit. */
	readonly #recent = new Map<string, number[]>();

	constructor(options: WebhooksOptions) {
		this.#options = options;
	}

	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}

	/** Whether the name is a permanent knight's that is active, which alone has webhooks. */
	permanent(agent: string): boolean {
		const found = this.#options.directory.agent(agent);
		return found?.status === "active" && !isHelper(found);
	}

	/** The URL a webhook is posted to; only its maker sees it, once. */
	urlOf(id: string, token: string): string {
		return `${this.#options.base}/hooks/${id}/${token}`;
	}

	async list(agent: string): Promise<WebhookView[]> {
		return (await this.#options.store.list(agent)).map(viewOf);
	}

	/** The live webhooks of every active permanent knight, by knight and then the oldest first. */
	async listAll(): Promise<WebhookOverviewView[]> {
		return (await this.#options.store.listAll()).flatMap((hook) =>
			this.permanent(hook.agent)
				? [
						{
							agent: hook.agent,
							agentDisplayName:
								this.#options.directory.agent(hook.agent)?.displayName ??
								hook.agent,
							...viewOf(hook),
						},
					]
				: [],
		);
	}

	/** Makes a webhook of the agent's room; throws WebhookError for a name, expiry or count it refuses. */
	async create(
		agent: string,
		given: { name: unknown; expiresInMinutes?: unknown; once?: unknown },
		createdBy: string,
	): Promise<CreatedWebhookView> {
		const name = typeof given.name === "string" ? given.name.trim() : "";
		if (!name || name.length > MAX_WEBHOOK_NAME)
			throw new WebhookError(
				400,
				"A webhook needs a name of 1 to 80 characters.",
			);
		const minutes = given.expiresInMinutes;
		if (
			minutes !== undefined &&
			minutes !== null &&
			(typeof minutes !== "number" ||
				!Number.isInteger(minutes) ||
				minutes < 1 ||
				minutes > MAX_WEBHOOK_MINUTES)
		)
			throw new WebhookError(
				400,
				"A webhook expires after 1 minute to 7 days, in whole minutes.",
			);
		if (given.once !== undefined && typeof given.once !== "boolean")
			throw new WebhookError(400, "once must be true or false.");
		const expiring = typeof minutes === "number";
		const live = await this.#options.store.list(agent);
		const same = live.filter(
			(hook) => (hook.expiresAt !== undefined) === expiring,
		);
		if (expiring && same.length >= MAX_EXPIRING_WEBHOOKS)
			throw new WebhookError(
				409,
				"This knight already has 20 expiring webhooks. Revoke one first.",
			);
		if (!expiring && same.length >= MAX_LASTING_WEBHOOKS)
			throw new WebhookError(
				409,
				"This knight already has 10 webhooks that never expire. Revoke one first.",
			);
		const { hook, token } = await this.#options.store.create({
			agent,
			name,
			createdBy,
			...(expiring
				? { expiresAt: new Date(this.#now() + minutes * MINUTE_MS) }
				: {}),
			once: given.once === true,
		});
		return { webhook: viewOf(hook), url: this.urlOf(hook.id, token) };
	}

	revoke(agent: string, id: string): Promise<boolean> {
		return this.#options.store.revoke(agent, id);
	}

	/**
	 * Answers `hooks/<id>/<token>` below the mount, which needs no session: the token is the
	 * credential. Every webhook that does not answer, for whatever reason, gets the same 404.
	 */
	async post(request: Request, rest: string): Promise<Response> {
		if (request.method !== "POST") return status(405, "Method not allowed");
		const [, id, token, ...more] = rest.split("/");
		if (!id || !token || more.length > 0) return notFound();
		const hook = await this.#options.store.verify(id, token);
		if (!hook || !this.permanent(hook.agent)) return notFound();
		if (!this.#allowed(hook.id))
			return status(429, "Too many posts; try again in a minute");
		const raw = await readLimited(request, MAX_POST_BYTES);
		if (!raw) return status(413, "The body is over 16 KB");
		let body: unknown;
		try {
			body = JSON.parse(raw.toString("utf8"));
		} catch {
			return status(400, "The body is not JSON");
		}
		const post = postOf(body);
		if (!post) return status(400, "The body is not a JSON object or array");
		if (!(await this.#options.store.accept(hook.id))) return notFound();
		await this.#show(hook, post.text, post.author ?? hook.name);
		return new Response(null, { status: 204 });
	}

	/** Shows the post in the agent's room, and hands it to the host as a webhook's. */
	async #show(
		hook: StoredWebhook,
		text: string,
		author: string,
	): Promise<void> {
		const room = agentRoomKey(this.#options.surfaceName, hook.agent);
		const { surface } = this.#options;
		const shown = await surface.publish({
			room,
			kind: "integration",
			author,
			text,
			files: [],
		});
		// The turn names the webhook as its maker named it; the name a post gives itself is only shown.
		surface.deliver({
			channel: room,
			messageId: coreMessageId(shown.id),
			authorId: `webhook:${hook.id}`,
			authorName: hook.name,
			authorIsBot: true,
			integration: { id: hook.id, own: false },
			isDirect: false,
			mentionsBot: false,
			repliesToBot: false,
			text,
			attachments: [],
		});
	}

	/** Counts a post against the webhook's limit; false when it has made its posts this minute. */
	#allowed(id: string): boolean {
		const now = this.#now();
		// The limit's memory is kept small: a webhook quiet for a minute is forgotten.
		if (this.#recent.size > 256)
			for (const [key, times] of this.#recent)
				if (!times.some((at) => at > now - MINUTE_MS)) this.#recent.delete(key);
		const recent = (this.#recent.get(id) ?? []).filter(
			(at) => at > now - MINUTE_MS,
		);
		if (recent.length >= POSTS_PER_MINUTE) {
			this.#recent.set(id, recent);
			return false;
		}
		recent.push(now);
		this.#recent.set(id, recent);
		return true;
	}
}
