import type { ChannelKey, Logger } from "pi-roundtable";
import { viewerOfSocket } from "../app/socket.ts";
import type { AppSocket, Sockets } from "../app/sockets.ts";
import type {
	HostRoomAccess,
	RoomAccess,
	Viewer,
	WebAppRegistry,
} from "../web-app.ts";

/** How long an answer of a kind's `access` is trusted: 10 seconds. */
export const ACCESS_TTL_MS = 10_000;

interface Entry {
	at: number;
	/** What the kind said then; undefined = no access. */
	access: RoomAccess | undefined;
}

export interface HostAccessOptions {
	registry: Pick<WebAppRegistry, "hostKindOf">;
	sockets: Pick<Sockets, "each">;
	logger: Logger;
	/** The clock, in milliseconds; default `Date.now`. */
	now?: () => number;
	/** How long an answer is trusted; default 10 s. */
	ttlMs?: number;
	/** Hears that a person's reading of a room was cut off, so their page can be told. */
	revoked?(connection: AppSocket, room: string): void;
}

/**
 * What decides who reads a host room right now: the kind's `access`, asked again at least every
 * ten seconds for as long as anyone follows the room, and at once when the host says access
 * changed. A frame is delivered only to a socket whose person the memo says may read, so a revoked
 * reader stops receiving within the TTL even if the host never says so, and an error of the
 * kind's is a refusal, never a pass.
 */
export class HostAccess implements HostRoomAccess {
	readonly #options: HostAccessOptions;
	readonly #memo = new Map<string, Entry>();
	readonly #inflight = new Map<string, Promise<RoomAccess | undefined>>();
	readonly #ttl: number;
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: HostAccessOptions) {
		this.#options = options;
		this.#ttl = options.ttlMs ?? ACCESS_TTL_MS;
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	static #key(principalId: string, room: string): string {
		return `${principalId}\u0000${room}`;
	}

	/** Re-asks about the rooms that are followed, a few times per TTL. */
	start(): void {
		if (this.#timer) return;
		this.#timer = setInterval(
			() => this.#refresh(this.#ttl / 2),
			Math.max(50, this.#ttl / 4),
		);
		this.#timer.unref?.();
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#memo.clear();
	}

	/** What the kind grants the viewer in the room now, from the memo when it is fresh; undefined for no access. */
	async of(viewer: Viewer, room: string): Promise<RoomAccess | undefined> {
		const key = HostAccess.#key(viewer.principalId, room);
		const found = this.#memo.get(key);
		if (found && this.#now() - found.at <= this.#ttl) return found.access;
		return this.#ask(viewer, room);
	}

	async read(viewer: Viewer, room: ChannelKey): Promise<boolean> {
		return (await this.of(viewer, room)) !== undefined;
	}

	/** Whether the memo, still fresh, says this socket's person may read the room. */
	readNow(connection: AppSocket, room: string): boolean {
		const found = this.#memo.get(
			HostAccess.#key(connection.principal.id, room),
		);
		return (
			found !== undefined &&
			found.access !== undefined &&
			this.#now() - found.at <= this.#ttl
		);
	}

	#ask(viewer: Viewer, room: string): Promise<RoomAccess | undefined> {
		const key = HostAccess.#key(viewer.principalId, room);
		const running = this.#inflight.get(key);
		if (running) return running;
		const found = this.#options.registry.hostKindOf(room);
		const answer = (async () => {
			let access: RoomAccess | undefined;
			if (found) {
				try {
					access = await found.kind.access(viewer, found.id);
				} catch (error) {
					this.#options.logger.warn(
						{ kind: found.kind.kind, err: error },
						"a kind of room could not say who may read; the room stays closed",
					);
				}
			}
			this.#memo.set(key, { at: this.#now(), access });
			return access;
		})().finally(() => this.#inflight.delete(key));
		this.#inflight.set(key, answer);
		return answer;
	}

	/** Re-asks for every followed room whose answer is older than `olderThan`. */
	#refresh(olderThan: number): Promise<unknown> {
		const asks: Promise<unknown>[] = [];
		this.#options.sockets.each(
			(connection) => connection.subscriptions.size > 0,
			(connection) => {
				const viewer = viewerOfSocket(connection);
				for (const room of [...connection.subscriptions]) {
					const found = this.#memo.get(
						HostAccess.#key(viewer.principalId, room),
					);
					if (found && this.#now() - found.at < olderThan) continue;
					asks.push(
						this.#ask(viewer, room).then((access) => {
							if (access) return;
							// The person lost the room: stop following it and tell their page.
							connection.subscriptions.delete(room);
							if (connection.focus === room) connection.focus = undefined;
							this.#options.revoked?.(connection, room);
						}),
					);
				}
			},
		);
		return Promise.allSettled(asks);
	}

	/** Drops what is remembered of a room, of everyone's or one person's, and asks the followers again at once. */
	forget(where: { room?: string; principalId?: string }): Promise<unknown> {
		for (const key of [...this.#memo.keys()]) {
			const [principalId, room] = key.split("\u0000");
			if (where.room !== undefined && room !== where.room) continue;
			if (where.principalId !== undefined && principalId !== where.principalId)
				continue;
			this.#memo.delete(key);
		}
		return this.#refresh(0);
	}
}
