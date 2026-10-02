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

/** Host-only routing state. The file is never mounted into a worker. Invalid state fails closed. */
export class SandboxChannelStore {
	readonly #path: string;
	readonly #channels: Set<ChannelKey>;
	constructor(path: string, initial: readonly ChannelKey[] = []) {
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
	has(channel: ChannelKey): boolean {
		return this.#channels.has(channel);
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
