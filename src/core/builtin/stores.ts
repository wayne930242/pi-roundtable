import type { OwnerIdentity } from "../identity.ts";
import { ownerMemoryExtension } from "../modules/memory/owner-memory.ts";
import { PgMemoryStore } from "../modules/memory/owner-memory-store.ts";
import { PgScheduleStore } from "../modules/schedules/schedule-store.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { MEMORY, SCHEDULES } from "../services.ts";
import { THE_SPEAKER, type Tier } from "../speakers.ts";
import { fixed } from "./session-tool.ts";

export interface MemoryOptions {
	/** The owner: whose memory the first rows belong to, and whom the tools serve in the owner's own sessions. */
	owner: OwnerIdentity & { id: string };
}

/** Each speaker keeps a memory of their own, so every tier may use the tools; the owner's reaches only the owner's turns. */
const MEMORY_TIERS: Readonly<Record<string, Tier>> = {
	memory_add: "member",
	memory_search: "member",
	memory_remove: "member",
};

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
				sessionTools: [
					fixed("owner-memory", (session) =>
						ownerMemoryExtension(
							memory,
							owner.id,
							// An agent session serves every speaker, so its tools name none.
							session.agent ? THE_SPEAKER : owner,
							// The owner's own chats have one speaker; the agent server's have several.
							session.agent ? session.speaker : undefined,
						),
					),
				],
				toolTiers: MEMORY_TIERS,
			};
		},
	};
}

/** The scheduled turns' table, and the store over it provided as `SCHEDULES`. */
export function scheduleStorePlugin(): RoundtablePlugin {
	return {
		name: "schedule-store",
		migrations: [PgScheduleStore.migration],
		provides: [SCHEDULES],
		setup: async ({ database, services }) => {
			services.provide(SCHEDULES, await PgScheduleStore.attach(database()));
			return {};
		},
	};
}
