// Unstable before 1.0; not covered by semver. Helpers for owner commands, claims, and naming existing core parts.

export type { ChannelQueue } from "./channels.ts";
export {
	attachmentsOf,
	channelQueue,
	channelSegment,
	discordKey,
	outcome,
	ownerAttachmentDir,
	settleTurn,
	withAttachmentsBlock,
	withReference,
} from "./channels.ts";
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
export {
	SHELL_TOOLS,
	shellHoldRule,
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
	McpEndpoint,
	PromptSlot,
	VirtualServer,
} from "./worker.ts";
export {
	approvalCard,
	archiveSessions,
	canonicalJson,
	mcpAdapterExtension,
	mcpExtension,
	promptSlot,
	readAttachmentExtension,
	runWorkerTask,
	workTimeout,
} from "./worker.ts";
