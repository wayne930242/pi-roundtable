import type { OwnerIdentity } from "../identity.ts";
import { ownerMemoryExtension } from "../modules/memory/owner-memory.ts";
import { PgMemoryStore } from "../modules/memory/owner-memory-store.ts";
import { memoryPrecheckRegistry } from "../modules/schedules/prechecks.ts";
import { PgScheduleStore } from "../modules/schedules/schedule-store.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { MEMORY, type MemoryStore, PRECHECKS, SCHEDULES } from "../services.ts";
import type { SessionTool } from "../sessions.ts";
import { THE_SPEAKER, type Tier } from "../speakers.ts";
import { fixed } from "./session-tool.ts";

export interface MemoryOptions {
	/** The owner: whose memory the first rows belong to, and whom the tools serve in the owner's own sessions. */
	owner: OwnerIdentity & { id: string };
}

/** Each speaker keeps a memory of their own, so every tier may use the tools; the owner's reaches only the owner's turns. */
export const MEMORY_TIERS: Readonly<Record<string, Tier>> = {
	memory_add: "member",
	memory_search: "member",
	memory_remove: "member",
};

/** The memory tools and prompt block of every conversation, over the given store. */
export function memorySessionTool(
	memory: MemoryStore,
	owner: MemoryOptions["owner"],
): SessionTool {
	return fixed("owner-memory", (session) => {
		// An agent session serves every speaker, so its tools name none.
		if (session.agent)
			return ownerMemoryExtension(
				memory,
				owner.id,
				THE_SPEAKER,
				session.speaker,
			);
		// Any other conversation may admit a member or an admin, who reads and changes their own
		// memory; an owner-tier speaker, such as remote MCP, speaks as the owner.
		const speaker = () => {
			const current = session.speaker();
			return current?.tier === "owner" ? undefined : current;
		};
		// Its tools keep the owner's words, so the owner's own chats read as before.
		return ownerMemoryExtension(memory, owner.id, owner, speaker, false);
	});
}

/**
 * The remembered facts of each speaker: the table, the store over it provided as `MEMORY`, and
 * the memory tools and prompt block of every conversation. An addon; `memory: false` leaves it
 * out. The host migrates the table over its one pool before any setup.
 */
export function memoryPlugin(options: MemoryOptions): RoundtablePlugin {
	const { owner } = options;
	return {
		name: "memory",
		migrations: PgMemoryStore.migrations(owner.id),
		provides: [MEMORY],
		setup: ({ database, services }) => {
			const memory = PgMemoryStore.attach(database(), owner.id);
			services.provide(MEMORY, memory);
			return {
				sessionTools: [memorySessionTool(memory, owner)],
				toolTiers: MEMORY_TIERS,
			};
		},
	};
}

/** The scheduled turns' table, and the store over it provided as `SCHEDULES`. */
export function scheduleStorePlugin(): RoundtablePlugin {
	return {
		name: "schedule-store",
		migrations: PgScheduleStore.migrations(),
		provides: [SCHEDULES],
		setup: async ({ database, services }) => {
			services.provide(SCHEDULES, await PgScheduleStore.attach(database()));
			return {};
		},
	};
}

/**
 * The registry of the host's prechecks, provided as `PRECHECKS`; the plugins after it register
 * theirs during setup. Apart from the store, so a plugin that replaces the store need not provide it.
 */
export function precheckPlugin(): RoundtablePlugin {
	return {
		name: "prechecks",
		provides: [PRECHECKS],
		setup: ({ services }) => {
			services.provide(PRECHECKS, memoryPrecheckRegistry());
			return {};
		},
	};
}
