import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ChannelKey } from "pi-roundtable";

/** A Discord snowflake, which is what Discord sets as the space of a guild's channels and threads. */
const GUILD_ID = /^\d{17,20}$/;
/** Channels the store remembers asking about for a listed guild, least recently seen dropped. */
const REMEMBERED_CHANNELS = 20_000;

export interface SandboxChannelStoreOptions {
	/** Discord guild ids whose every channel and thread is a sandbox channel. */
	guilds?: readonly string[];
}

/** Host-only routing state. The file is never mounted into a worker. Invalid state fails closed. */
export class SandboxChannelStore {
	readonly #path: string;
	readonly #channels: Set<ChannelKey>;
	readonly #guilds: ReadonlySet<string>;
	/** In process only: nothing is stored for a configured guild's channel. */
	readonly #remembered = new Set<ChannelKey>();
	constructor(
		path: string,
		initial: readonly ChannelKey[] = [],
		options: SandboxChannelStoreOptions = {},
	) {
		for (const guild of options.guilds ?? []) {
			if (typeof guild !== "string" || !GUILD_ID.test(guild))
				throw new Error(
					`guilds: ${JSON.stringify(guild)} is not a Discord guild id`,
				);
		}
		this.#guilds = new Set(options.guilds);
		this.#path = path;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const parent = statSync(dirname(path));
		if (parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)
			throw new Error(
				"routing state directory must be private and service-owned",
			);
		if (
			existsSync(path) &&
			(!lstatSync(path).isFile() || lstatSync(path).uid !== process.getuid?.())
		)
			throw new Error("routing state must be a service-owned regular file");
		let raw: unknown = [...initial];
		if (existsSync(path)) {
			try {
				raw = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				throw new Error("invalid sandbox channel state");
			}
		}
		if (
			!Array.isArray(raw) ||
			raw.some(
				(key) => typeof key !== "string" || !/^[a-z][a-z0-9_-]*:.+$/.test(key),
			)
		)
			throw new Error("invalid sandbox channel state");
		this.#channels = new Set(raw as ChannelKey[]);
		if (!existsSync(path)) this.#save();
	}
	/** Whether the channel was enabled by command; a configured guild's channels are not. */
	has(channel: ChannelKey): boolean {
		return this.#channels.has(channel);
	}
	/** Whether the guild is listed in the `guilds` option. */
	configured(guild: string | undefined): boolean {
		return guild !== undefined && this.#guilds.has(guild);
	}
	/**
	 * Whether the channel is a sandbox channel, enabled by command or in a listed `guild`. A
	 * channel asked about with a listed guild is remembered, so later questions that carry no
	 * guild (stop, start fresh) still find it; asking again changes nothing but its recency.
	 */
	owns(channel: ChannelKey, guild?: string): boolean {
		if (this.#channels.has(channel)) return true;
		if (guild !== undefined) {
			// Only Discord sets a guild id; another surface's space is not one.
			if (!channel.startsWith("discord:") || !this.#guilds.has(guild))
				return false;
			this.#remembered.delete(channel);
			this.#remembered.add(channel);
			if (this.#remembered.size > REMEMBERED_CHANNELS) {
				const oldest = this.#remembered.values().next().value;
				if (oldest !== undefined) this.#remembered.delete(oldest);
			}
			return true;
		}
		return this.#remembered.has(channel);
	}
	list(): ChannelKey[] {
		return [...this.#channels];
	}
	enable(channel: ChannelKey): void {
		if (!/^[a-z][a-z0-9_-]*:.+$/.test(channel))
			throw new Error("invalid channel key");
		const existed = this.#channels.has(channel);
		this.#channels.add(channel);
		try {
			this.#save();
		} catch (error) {
			if (!existed) this.#channels.delete(channel);
			throw error;
		}
	}
	disable(channel: ChannelKey): void {
		const existed = this.#channels.delete(channel);
		try {
			this.#save();
		} catch (error) {
			if (existed) this.#channels.add(channel);
			throw error;
		}
	}
	#save(): void {
		writeFileSync(`${this.#path}.tmp`, JSON.stringify([...this.#channels]), {
			mode: 0o600,
		});
		renameSync(`${this.#path}.tmp`, this.#path);
	}
}
