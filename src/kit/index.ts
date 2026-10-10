// Helpers for owner commands, claims, and naming existing core parts; versioned like the main entry.

export type { ChannelQueue } from "./channels.ts";
export {
	attachmentsOf,
	channelQueue,
	channelSegment,
	discordKey,
	ImagePreparationError,
	outcome,
	ownerAttachmentDir,
	prepareImageBytes,
	settleTurn,
	withAttachmentsBlock,
	withReference,
} from "./channels.ts";
export type {
	CompactionEngine,
	CompactionHistory,
	LatestCompaction,
	MemoryView,
} from "./compaction.ts";
export {
	bridgeHistoryHidesMemory,
	COMPACT_HEADROOM_TOKENS,
	CompactionTiers,
	carriesMemory,
	compactionEngine,
	HARD_COMPACT_TOKENS,
	hidesPrivateExchange,
	MEMORY_TURN_ENTRY,
	memoryProjection,
	privateCompaction,
	recordMemoryTurn,
	SOFT_COMPACT_TOKENS,
	summaryProjection,
} from "./compaction.ts";
export { scrubDiagnostic } from "./diagnostics.ts";
export type {
	ChoiceAnswer,
	ChoiceQuestion,
	ModelRef,
	OwnerIdentity,
	ScoreQuestion,
	YesNoQuestion,
} from "./domain.ts";
export {
	AgentError,
	AUTO_THINKING,
	formatModelRef,
	parseModelRef,
	THINKING_LEVELS,
	thinkingLabel,
} from "./domain.ts";
export { holdChain } from "./holds.ts";
export type {
	JevCompactInput,
	JevCompactOptions,
	JevCompactOutcome,
	JevCompactor,
	JevCompactRequest,
	JevExtensionOptions,
	JevSkipReason,
} from "./jev.ts";
export {
	isRuleLoad,
	JEV_COMPACTION_ENGINE,
	JEV_GOAL,
	JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS,
	jevCompact,
	jevCompactionExtension,
	jevCompactor,
} from "./jev.ts";
export type {
	EffortBrief,
	EffortJudgeOptions,
	EffortLevel,
	EffortPicker,
	PreviousTurn,
} from "./judging.ts";
export {
	effortJudge,
	JUDGE_WORK,
} from "./judging.ts";
export { searchTerms } from "./memory.ts";
export type {
	ScheduleToolContext,
	ScheduleToolName,
	ScheduleToolSpec,
	ScheduleToolWording,
} from "./mirror.ts";
export {
	callScheduleTool,
	DELEGATE_TOOL,
	DELEGATE_TOOL_SPEC,
	isScheduleTool,
	SCHEDULE_TOOLS,
	scheduleToolSpecs,
} from "./mirror.ts";
export {
	headline,
	quietLinks,
	splitReply,
	thinkingLine,
	zonedStamp,
} from "./presentation.ts";
export { packageDir, serveUnix } from "./process.ts";
export {
	type PushPolicy,
	SHELL_TOOLS,
	shellHoldRule,
	shellHoldRuleFor,
} from "./shell.ts";
export {
	checkRepoName,
	SKILL_LIST_TOOL,
	skillListExtension,
} from "./skills.ts";
export type {
	AgentCategory,
	AgentChannelLookup,
	AgentChannels,
	AgentModels,
	AgentOps,
	AgentPost,
	AgentTurnRunner,
	AssistantLike,
	Backlog,
	CategoryLayout,
	ChannelMessage,
	DashboardBoard,
	DelegationWorker,
	GroupMessage,
	Notifier,
	OwnerNotifier,
	SpeakerFacts,
	SpeakerPolicy,
	ThinkingPicker,
	ThreadHost,
} from "./support.ts";
export type {
	DispatchThread,
	DispatchThreads,
	DispatchThreadsOptions,
} from "./threads.ts";
export type {
	TextToolDef,
	ToolInput,
} from "./tools.ts";
export {
	activeToolsExtension,
	lastAssistant,
	requiredString,
	stringList,
	textOf,
	textToolsExtension,
	toolError,
	toolText,
} from "./tools.ts";
export type {
	CardLimits,
	InterimPosterOptions,
	McpEndpoint,
	PromptSlot,
	VirtualServer,
} from "./worker.ts";
export {
	approvalCard,
	approvalDetails,
	archiveSessions,
	canonicalJson,
	InterimPoster,
	mcpAdapterExtension,
	mcpExtension,
	promptSlot,
	readAttachmentExtension,
	runWorkerTask,
	workTimeout,
} from "./worker.ts";
