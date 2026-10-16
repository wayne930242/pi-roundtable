import {
	channelOf,
	guildRoutes,
	logThread,
	type Route,
} from "./discord-api-emulator-guild.ts";
import { messageRoutes } from "./discord-api-emulator-messages.ts";
import {
	auditId,
	BOT_TOKEN,
	type EmuChannel,
	type EmuMessage,
	type EmuState,
	HttpError,
	object,
} from "./discord-api-emulator-state.ts";

/** A request body that is not JSON is Discord's 400. */
function parseJson(text: string): Record<string, unknown> {
	try {
		return object(JSON.parse(text));
	} catch {
		throw new HttpError(400, 50109, "The request body contains invalid JSON.");
	}
}

/** One request that reached the emulated Discord. */
export interface EmulatedRequest {
	method: string;
	path: string;
	query: string;
	/** The `Authorization` header, if the request had one. */
	authorization: string | null;
}

/**
 * A small Discord on `127.0.0.1`, for testing a REST client without the network: it answers the
 * routes the poster uses, in Discord's shapes and with its error codes. It is our model of Discord,
 * built from what it was seen to answer, and says nothing about the real one.
 */
export class DiscordEmulator {
	readonly state: EmuState = {
		guilds: new Map(),
		channels: new Map(),
		webhooks: new Map(),
		audit: new Map(),
		closedDirects: new Set(),
		auditReadable: true,
		pinNotices: false,
		categoryLimit: 50,
		guildLimit: 500,
		renameRetryAfter: 600,
		next: 9_100_000_000_000_000_000n,
	};
	/** The bot token the emulated Discord accepts. */
	token = BOT_TOKEN;
	/** Every request received, in order. */
	readonly log: EmulatedRequest[] = [];
	/** The bodies of requests, parsed, by request index. */
	readonly bodies: Record<string, unknown>[] = [];
	readonly #routes: Route[];
	readonly #failures: number[] = [];
	#pins = { at: Date.now() - 10_000_000 };
	#server: ReturnType<typeof Bun.serve> | undefined;

	constructor() {
		this.#routes = [
			...guildRoutes(this.state),
			...messageRoutes(this.state, this.#pins),
		];
	}

	/** The address to give discord.js' REST client as `api`. */
	get api(): string {
		if (!this.#server) throw new Error("the emulator is not running");
		return `http://127.0.0.1:${this.#server.port}/api`;
	}

	get requests(): number {
		return this.log.length;
	}

	start(): void {
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => this.#handle(request),
		});
	}

	stop(): void {
		this.#server?.stop(true);
		this.#server = undefined;
	}

	/** The next `count` requests are answered with a server error. */
	failNext(count = 1): void {
		for (let i = 0; i < count; i += 1) this.#failures.push(500);
	}

	// The world, as a scenario arranges it.

	addGuild(id: string, ownerId: string): void {
		this.state.guilds.set(id, {
			id,
			ownerId,
			members: new Map(),
			// @everyone has the guild's id and View Channel.
			roles: [{ id, permissions: String(1n << 10n) }],
		});
	}

	addChannel(
		id: string,
		guildId: string,
		options: { type?: number; parentId?: string; name?: string } = {},
	): EmuChannel {
		const channel: EmuChannel = {
			id,
			type: options.type ?? 0,
			name: options.name ?? `channel-${id.slice(-4)}`,
			guildId,
			...(options.parentId ? { parentId: options.parentId } : {}),
			overwrites: [],
			messages: [],
			pins: [],
			renames: [],
		};
		this.state.channels.set(id, channel);
		return channel;
	}

	/** Removes the bot's webhook of that name, as a person deleting it by hand. */
	deleteWebhook(channelId: string, name: string): void {
		for (const [id, hook] of this.state.webhooks)
			if (hook.channelId === channelId && hook.name === name)
				this.state.webhooks.delete(id);
	}

	/** A person archives (and perhaps locks) a thread; `skewMs` moves the audit entry's time from the archive's. */
	personArchives(
		threadId: string,
		userId: string,
		options: { lock?: boolean; skewMs?: number } = {},
	): void {
		const thread = channelOf(this.state, threadId);
		if (!thread.thread) throw new Error("that channel is not a thread");
		thread.thread.archived = true;
		thread.thread.archiveTimestamp = Date.now();
		if (options.lock) thread.thread.locked = true;
		const at = Date.now() + (options.skewMs ?? 0);
		logThread(
			this.state,
			thread,
			userId,
			{ key: options.lock ? "locked" : "archived", value: true },
			auditId(this.state, at),
		);
	}

	/** Discord archives a quiet thread on its own: the audit log gets no entry. */
	autoArchives(threadId: string): void {
		const thread = channelOf(this.state, threadId).thread;
		if (!thread) throw new Error("that channel is not a thread");
		thread.archived = true;
		thread.archiveTimestamp = Date.now();
	}

	/** What a message was allowed to ping, as the request that made it said. */
	mentionsOf(channelId: string, messageId: string) {
		return channelOf(this.state, channelId).messages.find(
			(message) => message.id === messageId,
		)?.allowedMentions;
	}

	/** The direct messages sent to a user. */
	directsTo(userId: string): EmuMessage[] {
		return [...this.state.channels.values()]
			.filter((channel) => channel.type === 1 && channel.recipientId === userId)
			.flatMap((channel) => channel.messages);
	}

	// The server.

	async #handle(request: Request): Promise<Response> {
		const url = URL.parse(request.url);
		if (!url) return new Response(null, { status: 400 });
		const path = url.pathname.replace(/^\/api(\/v\d+)?/, "");
		this.log.push({
			method: request.method,
			path,
			query: url.search,
			authorization: request.headers.get("authorization"),
		});
		try {
			if (this.#failures.shift() !== undefined)
				throw new HttpError(500, 0, "Internal Server Error");
			const isWebhook = path.startsWith("/webhooks/");
			if (
				!isWebhook &&
				request.headers.get("authorization") !== `Bot ${this.token}`
			)
				throw new HttpError(401, 0, "401: Unauthorized");
			const body = await this.#body(request);
			for (const [method, pattern, handle] of this.#routes) {
				const match = method === request.method ? pattern.exec(path) : null;
				if (!match) continue;
				const out = handle({
					params: match.slice(1),
					query: url.searchParams,
					body,
				});
				if (out === undefined) return new Response(null, { status: 204 });
				return Response.json(out);
			}
			throw new HttpError(404, 0, "404: Not Found");
		} catch (error) {
			if (error instanceof HttpError)
				return Response.json(
					{
						code: error.code,
						message: error.message,
						...(error.errors ? { errors: error.errors } : {}),
						...error.extra,
					},
					{ status: error.status, headers: error.headers },
				);
			throw error;
		}
	}

	/** A JSON body, or a multipart one: `payload_json` and the files, whose sizes and names are kept. */
	async #body(request: Request): Promise<Record<string, unknown>> {
		if (request.method === "GET" || request.method === "DELETE") return {};
		const type = request.headers.get("content-type") ?? "";
		if (type.startsWith("multipart/form-data")) {
			const form = await request.formData();
			const payload = form.get("payload_json");
			const json = typeof payload === "string" ? parseJson(payload) : {};
			const files = [...form.entries()].flatMap(([key, value]) =>
				key.startsWith("files[") && typeof value !== "string" ? [value] : [],
			);
			return { ...json, __files: files };
		}
		const text = await request.text();
		return text ? parseJson(text) : {};
	}
}
