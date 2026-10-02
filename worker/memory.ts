import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord, type ToolSpec } from "../src/protocol.ts";

export const MEMORY_TOOLS: ToolSpec[] = [
	{
		name: "memory_set",
		description:
			"Remember a speaker fact or a channel note. Speaker entries belong to the current speaker.",
		parameters: {
			type: "object",
			properties: {
				scope: { type: "string", enum: ["speaker", "channel"] },
				key: { type: "string" },
				text: { type: "string" },
			},
			required: ["scope", "key", "text"],
			additionalProperties: false,
		},
	},
	{
		name: "memory_get",
		description:
			"Read or search current-speaker facts or shared channel notes. Omit key to list entries.",
		parameters: {
			type: "object",
			properties: {
				scope: { type: "string", enum: ["speaker", "channel"] },
				key: { type: "string" },
				query: { type: "string" },
			},
			required: ["scope"],
			additionalProperties: false,
		},
	},
	{
		name: "memory_remove",
		description: "Forget one current-speaker fact or shared channel note.",
		parameters: {
			type: "object",
			properties: {
				scope: { type: "string", enum: ["speaker", "channel"] },
				key: { type: "string" },
			},
			required: ["scope", "key"],
			additionalProperties: false,
		},
	},
];
interface Entry {
	scope: string;
	key: string;
	text: string;
}

/** All files remain in the container's one channel workspace; no host path is accepted. */
export class SandboxMemory {
	readonly #path: string;
	#entries: Entry[];
	constructor(workspace: string) {
		mkdirSync(workspace, { recursive: true });
		this.#path = join(workspace, "memory.json");
		const raw: unknown = existsSync(this.#path)
			? JSON.parse(readFileSync(this.#path, "utf8"))
			: [];
		if (
			!Array.isArray(raw) ||
			raw.length > 256 ||
			raw.some(
				(entry) =>
					!isRecord(entry) ||
					typeof entry.scope !== "string" ||
					typeof entry.key !== "string" ||
					typeof entry.text !== "string",
			)
		)
			throw new Error("invalid memory store");
		this.#entries = raw as Entry[];
	}

	call(
		name: string,
		input: Record<string, unknown>,
		speakerId: string,
	): string {
		if (input.scope !== "speaker" && input.scope !== "channel")
			throw new Error("scope must be speaker or channel");
		const scope =
			input.scope === "channel" ? "channel" : `speaker:${speakerId}`;
		const key = typeof input.key === "string" ? input.key.trim() : undefined;
		if (key !== undefined && (!key || key.length > 128))
			throw new Error("key must be 1 to 128 characters");
		if (name === "memory_get") {
			const query =
				typeof input.query === "string" ? input.query.toLowerCase() : "";
			return JSON.stringify(
				this.#entries
					.filter(
						(entry) =>
							entry.scope === scope &&
							(key === undefined || entry.key === key) &&
							`${entry.key} ${entry.text}`.toLowerCase().includes(query),
					)
					.map(({ key, text }) => ({ key, text })),
			);
		}
		if (!key) throw new Error("key is required");
		if (name !== "memory_set" && name !== "memory_remove")
			throw new Error("unknown memory tool");
		const next = this.#entries.filter(
			(entry) => entry.scope !== scope || entry.key !== key,
		);
		if (name === "memory_set") {
			if (
				typeof input.text !== "string" ||
				!input.text.trim() ||
				input.text.length > 2048
			)
				throw new Error("text must be 1 to 2048 characters");
			next.push({ scope, key, text: input.text });
		}
		if (
			next.length > 256 ||
			Buffer.byteLength(JSON.stringify(next)) > 512 * 1024
		)
			throw new Error("memory capacity reached");
		writeFileSync(`${this.#path}.tmp`, JSON.stringify(next), { mode: 0o600 });
		renameSync(`${this.#path}.tmp`, this.#path);
		this.#entries = next;
		return name === "memory_set" ? "Saved." : "Forgotten.";
	}
}
