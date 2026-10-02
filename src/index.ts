// The plugin author's stable entry; internals remain behind package exports.

export {
	AGENT_SERVER_PRIORITY,
	OWNER_TARGET,
} from "./core/agents/agent-claim.ts";
export type {
	Agent,
	AgentGroup,
	AgentSeed,
	AgentStatus,
} from "./core/agents/agent-store.ts";
export type { AvatarMode } from "./core/agents/agent-tools.ts";
export type {
	AgentStatus as TeamAgentStatus,
	GroupStatus,
	TeamStatus,
} from "./core/agents/team-status.ts";
export {
	AGENT_SERVER_PLUGIN,
	AGENT_TEAM_SERVICE,
} from "./core/builtin/agent-server.ts";
export type {
	Pronouns,
	RoundtableConfig,
	TierConfig,
} from "./core/config/config.ts";
export type {
	Admission,
	AttachmentRef,
	BackgroundTarget,
	BackgroundTurn,
	ChannelClaim,
	ConversationKind,
	ConversationPort,
	InboundMessage,
	QueuePort,
	ScheduledOutcome,
} from "./core/contract/channels.ts";
export type {
	ImageDrawer,
	Judge,
	Providers,
	ReferenceImage,
	ResolvedProviders,
} from "./core/contract/providers.ts";
export type {
	AgentRuntime,
	AgentSessions,
	ContextUse,
	HeldActionStore,
	LoadedSkill,
	RuntimeDeps,
	RuntimeFactory,
} from "./core/contract/runtime.ts";
export type { ServiceKey, Services } from "./core/contract/services.ts";
export { serviceKey } from "./core/contract/services.ts";
export type { ChatSurface, SurfacePort } from "./core/contract/surface.ts";
export { channelKey, parseChannelKey } from "./core/contract/surface.ts";
export type { Migration, MigrationReport } from "./core/db/migrations.ts";
export { migrateDatabase } from "./core/db/migrations.ts";
export type { ToolContribution, ToolSpec, ToolTurn } from "./core/define.ts";
export { definePlugin, defineTool, ToolRefusal } from "./core/define.ts";
export type {
	DefinedRoundtable,
	DefineOverrides,
} from "./core/define-roundtable.ts";
export { defineRoundtable } from "./core/define-roundtable.ts";
export type {
	AttachmentFailure,
	ModelImage,
	StoredAttachment,
	TurnAttachments,
} from "./core/domain/attachment.ts";
export { NO_ATTACHMENTS } from "./core/domain/attachment.ts";
export type {
	HeldCall,
	OutboundReply,
	PendingConfirmation,
	ReplyFile,
	TranscriptEntry,
	TurnResult,
} from "./core/domain/conversation.ts";
export {
	AgentRunError,
	ConfigError,
	DelegationError,
	MemoryError,
	ScheduleError,
} from "./core/domain/errors.ts";
export type {
	Approval,
	AskOption,
	OwnerAnswer,
	OwnerPrompts,
	OwnerQuestion,
} from "./core/domain/owner-prompts.ts";
export type { TurnRequest } from "./core/domain/ports.ts";
export type { DrainOptions } from "./core/drain.ts";
export {
	JudgeError,
	MigrationError,
	NotLinkedError,
	PluginError,
	ProviderError,
} from "./core/errors.ts";
export type { HoldCheck, HoldContext, HoldRule } from "./core/holds.ts";
export type { HostEnvironment, RoundtableOptions } from "./core/host.ts";
export { Roundtable } from "./core/host.ts";
export type {
	HttpRoute,
	ListenerAddress,
	ListenerConfig,
} from "./core/http/listeners.ts";
export type { Locale } from "./core/i18n/index.ts";
export type { JudgeModel } from "./core/judging/model-judge.ts";
export type { LogEntry, LogFn, Logger } from "./core/log.ts";
export type { ThinkingLevel, ThinkingSetting } from "./core/models.ts";
export type {
	DelegationJob,
	DelegationOutcome,
} from "./core/modules/delegation/delegator.ts";
export type {
	Memory,
	MemoryKind,
	PromptMemory,
} from "./core/modules/memory/owner-memory-store.ts";
export { MEMORY_KINDS } from "./core/modules/memory/owner-memory-store.ts";
export type {
	Recurrence,
	Weekday,
} from "./core/modules/schedules/recurrence.ts";
export type {
	NewSchedule,
	Schedule,
	ScheduleChange,
} from "./core/modules/schedules/schedule-store.ts";
export type {
	ResolvedSkill,
	SkillCatalogEntry,
	SkillSet,
	SkillSource,
} from "./core/modules/skills/skill-rules.ts";
export type {
	Contribution,
	EventHandlers,
	EventSink,
	HostEnv,
	LinkedSessions,
	Persona,
	PluginContext,
	PromptSection,
	PromptTurn,
	RoundtablePlugin,
	Service,
	ServiceStartedEvent,
	ServiceStartOutcome,
	TurnEndEvent,
	TurnEvent,
} from "./core/plugin.ts";
export {
	attachReplyFile,
	REPLY_FILE_LIMITS,
	ReplyFileError,
} from "./core/reply-files.ts";
export type {
	ConversationTurnInput,
	ConversationTurns,
} from "./core/routing/conversation-turns.ts";
export type {
	AgentChange,
	AgentDirectory,
	AgentServer,
	AgentTeam,
	AvatarStudio,
	BackgroundTurns,
	DelegationRequest,
	Delegator,
	MemoryStore,
	ScheduleStore,
	SkillRegistry,
	SpeakerMemory,
} from "./core/services.ts";
export {
	AGENTS,
	BACKGROUND_TURNS,
	DELEGATION,
	MEMORY,
	SCHEDULES,
	SKILLS,
} from "./core/services.ts";
export type {
	AgentTurnScope,
	ChannelKey,
	SessionContext,
	SessionPlan,
	SessionTool,
	SessionToolSnapshot,
	ToolSelection,
	TransientTask,
	TurnSelection,
} from "./core/sessions.ts";
export type { Speaker, Tier } from "./core/speakers.ts";
export { THE_SPEAKER, TIERS } from "./core/speakers.ts";
export type { ToolTiers, ToolTierTable } from "./core/tool-tiers.ts";
