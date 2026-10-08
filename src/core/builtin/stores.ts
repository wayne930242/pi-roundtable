import type { OwnerIdentity } from "../identity.ts";
import { ownerMemoryExtension } from "../modules/memory/owner-memory.ts";
import { PgMemoryStore } from "../modules/memory/owner-memory-store.ts";
import { memoryPrecheckRegistry } from "../modules/schedules/prechecks.ts";
import { PgScheduleStore } from "../modules/schedules/schedule-store.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { memoryReader } from "../runtime/session-conversation.ts";
import { MEMORY, type MemoryStore, PRECHECKS, SCHEDULES } from "../services.ts";
import type { SessionContext, SessionTool } from "../sessions.ts";
import type { Tier } from "../speakers.ts";
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

/**
 * Whose memory a session's running turn reads: a private conversation's person's, whoever speaks
 * in it, and in a shared one each turn's speaker's; never by tier, so a second owner reads their
 * own. The host's own turns read no one's in a shared conversation.
 */
function memoryOwner(
	session: SessionContext,
): { principalId: string; name: string } | undefined {
	const speaker = session.speaker();
	const { conversation } = session;
	const principalId = memoryReader(conversation, speaker);
	if (principalId === undefined) return undefined;
	// A principal 0.8 left is named by their id until someone names them; their speaker has a name.
	const principal =
		conversation.visibility === "private" ? conversation.principal : undefined;
	const named =
		principal && principal.displayName !== principal.id
			? principal.displayName
			: undefined;
	const name =
		named ??
		(speaker?.principalId === principalId ? speaker.name : principalId);
	return { principalId, name };
}

/** The memory tools and prompt block of every conversation, over the given store; none for a persona without memory. */
export function memorySessionTool(
	memory: MemoryStore,
	owner: MemoryOptions["owner"],
): SessionTool {
	return fixed("owner-memory", (session) =>
		session.memory === "none"
			? null
			: ownerMemoryExtension(memory, {
					ownerId: owner.id,
					addressee: session.addressee,
					describesSpeakers: session.conversation.visibility === "shared",
					whose: () => memoryOwner(session),
				}),
	);
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
