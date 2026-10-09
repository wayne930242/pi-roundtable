// The core's compaction tiers, for a host that builds its own Pi session (a sandbox worker, say).

export type {
	CompactionEngine,
	CompactionHistory,
	LatestCompaction,
} from "../core/runtime/compaction-tiers.ts";
export {
	COMPACT_HEADROOM_TOKENS,
	CompactionTiers,
	compactionEngine,
	HARD_COMPACT_TOKENS,
	SOFT_COMPACT_TOKENS,
} from "../core/runtime/compaction-tiers.ts";
export type { MemoryView } from "../core/runtime/extensions/private-memory.ts";
export {
	hidesPrivateExchange,
	memoryProjection,
	privateCompaction,
	summaryProjection,
} from "../core/runtime/extensions/private-memory.ts";
export {
	bridgeHistoryHidesMemory,
	carriesMemory,
	MEMORY_TURN_ENTRY,
	recordMemoryTurn,
} from "../core/runtime/reader-history.ts";
