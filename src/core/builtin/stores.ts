import { AgentStore } from "../agents/agent-store.ts";
import { OwnerMemoryStore } from "../modules/memory/owner-memory-store.ts";
import { ScheduleStore } from "../modules/schedules/schedule-store.ts";
import { SkillStore } from "../modules/skills/skill-store.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { PendingConfirmationStore } from "../runtime/pending-confirmation-store.ts";

export interface StoresOptions {
	/** The owner's Discord id: the speaker whose memory the first rows belong to. */
	ownerId: string;
	/** The agent server's guild; every agent-server row carries it. */
	guildId: string;
}

/**
 * The core's own tables and the stores over them. The host migrates them over its one pool
 * before any setup, in this order, and closes the pool after every service has stopped.
 */
export function storesPlugin(options: StoresOptions): RoundtablePlugin {
	const { ownerId, guildId } = options;
	return {
		name: "stores",
		migrations: [
			...OwnerMemoryStore.migrations(ownerId),
			ScheduleStore.migration,
			PendingConfirmationStore.migration,
			...AgentStore.migrations(guildId),
			...SkillStore.migrations(guildId),
		],
		setup: async ({ database, core }) => {
			const sql = database();
			core.provide("stores", {
				memory: OwnerMemoryStore.attach(sql, ownerId),
				schedules: await ScheduleStore.attach(sql),
				confirmations: await PendingConfirmationStore.attach(sql),
				agents: await AgentStore.attach(sql, guildId),
				skills: await SkillStore.attach(sql, guildId),
			});
			return {};
		},
	};
}
