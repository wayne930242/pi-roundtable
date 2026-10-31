// The plugin author's stable entry; internals remain behind package exports.

export {
	AGENT_SERVER_PRIORITY,
	OWNER_TARGET,
} from "./core/agents/agent-claim.ts";
export { characterOf, isHelper } from "./core/agents/agent-rules.ts";
export type {
	Agent,
	AgentGroup,
	AgentSeed,
	AgentStatus,
} from "./core/agents/agent-store.ts";
export type { AvatarMode } from "./core/agents/agent-tools.ts";
export type { HelpersEnded, HelperTeam } from "./core/agents/helper-ops.ts";
export type { RouteKind, RoutingTable } from "./core/agents/routes.ts";
export {
	agentRoomKey,
	groupRoomKey,
	roomOf,
} from "./core/agents/team-keys.ts";
export type {
	AgentStatus as TeamAgentStatus,
	GroupStatus,
	TeamStatus,
} from "./core/agents/team-status.ts";
export { MAX_ATTACHMENT_BYTES } from "./core/attachments/attachment-fetcher.ts";
export type { AttachmentRetention } from "./core/attachments/attachment-retention.ts";
export type {
	ToolAttachment,
	ToolAttachmentInfo,
} from "./core/attachments/tool-attachment.ts";
export {
	AGENT_SERVER_PLUGIN,
	AGENT_TEAM_SERVICE,
	LOCAL_TEAM_ID,
} from "./core/builtin/agent-server.ts";
export type {
	AccessConfig,
	AccessOwnerConfig,
	AccessTierConfig,
} from "./core/config/access.ts";
export type { AttachmentsConfig } from "./core/config/attachments.ts";
export type {
	AdapterConfig,
	BackgroundConfig,
	DiscordConfig,
	Pronouns,
	RoundtableConfig,
	TierConfig,
} from "./core/config/config.ts";
export type { ConversationsConfig } from "./core/config/conversations.ts";
export type { HelpersConfig } from "./core/config/helpers.ts";
export type { LimitsConfig } from "./core/config/limits.ts";
export type { ProfilesConfig } from "./core/config/profiles.ts";
export type {
	AgentRoutes,
	PlaceTarget,
	RoutingConfig,
	SurfaceRouting,
} from "./core/config/routing.ts";
export type { SkillsConfig } from "./core/config/skills-config.ts";
export type {
	AttachmentPort,
	AttachmentRefusalCode,
	AttachmentUpload,
	ExpiredAttachments,
	ExpireUsedOptions,
	TurnAttachmentOptions,
} from "./core/contract/attachments.ts";
export { AttachmentRefusal } from "./core/contract/attachments.ts";
export type {
	ChannelContextSource,
	ChannelContextSourceAttachment,
	ChannelContexts,
	ChannelContextVerdict,
} from "./core/contract/channel-context.ts";
export type {
	Admission,
	AttachmentContent,
	AttachmentFile,
	AttachmentRef,
	BackgroundRunsAs,
	BackgroundTarget,
	BackgroundTurn,
	ChannelClaim,
	ConversationKind,
	ConversationPort,
	InboundMessage,
	MessageObserver,
	ObserveFilter,
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
export type {
	ChatSurface,
	SurfaceMessageEvents,
	SurfacePort,
	SurfaceThreads,
} from "./core/contract/surface.ts";
export { channelKey, parseChannelKey } from "./core/contract/surface.ts";
export type {
	ConversationRecord,
	ConversationRegistration,
	ConversationRegistry,
	ConversationVisibility,
} from "./core/conversations/conversation-registry.ts";
export type { Migration, MigrationReport } from "./core/db/migrations.ts";
export { migrateDatabase } from "./core/db/migrations.ts";
export type {
	ToolContribution,
	ToolOutput,
	ToolSpec,
	ToolTurn,
} from "./core/define.ts";
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
	ClientCallError,
	ClientCallOptions,
	ClientCallResult,
	ClientPart,
	ClientPort,
} from "./core/domain/client.ts";
export type {
	HeldCall,
	IntercomCard,
	OutboundReply,
	PendingConfirmation,
	PostAuthor,
	ReplyFile,
	TranscriptEntry,
	TurnResult,
} from "./core/domain/conversation.ts";
export {
	AgentRunError,
	ConfigError,
	DelegationError,
	IdentityError,
	MemoryError,
	ScheduleError,
} from "./core/domain/errors.ts";
export type {
	InterimMessage,
	InterimPosts,
	InterimTextMode,
} from "./core/domain/interim.ts";
export type { TurnConversation, TurnRequest } from "./core/domain/ports.ts";
export type { HoldRefusal, TurnProgress } from "./core/domain/progress.ts";
export type { RoundEnd, RoundProgress } from "./core/domain/round.ts";
export {
	type TurnLimit,
	type TurnTimeout,
	type TurnTimeoutEnd,
	TurnTimeoutError,
} from "./core/domain/turn-timeout.ts";
export type { DrainOptions } from "./core/drain.ts";
export {
	HostStoppingError,
	JudgeError,
	MigrationError,
	NotLinkedError,
	PluginError,
	ProviderError,
} from "./core/errors.ts";
export type {
	ClassedHold,
	HoldCheck,
	HoldContext,
	HoldDescription,
	HoldRule,
} from "./core/holds.ts";
export type { HostEnvironment, RoundtableOptions } from "./core/host.ts";
export { Roundtable } from "./core/host.ts";
export type { RegistrationReport } from "./core/host-registration.ts";
export type {
	HttpRoute,
	ListenerAddress,
	ListenerConfig,
} from "./core/http/listeners.ts";
export { DEFAULT_MAX_REQUEST_BODY_BYTES } from "./core/http/listeners.ts";
export type {
	RouteSocket,
	WebSocketAccept,
	WebSocketRoute,
	WebSocketSendResult,
} from "./core/http/websocket.ts";
export type { Locale } from "./core/i18n/index.ts";
export type {
	AccessOwner,
	AccessRules,
	AccessTier,
	Provisioning,
	ProvisioningRule,
	SelfLinkRules,
} from "./core/identity/access-policy.ts";
export type { ActorFacts } from "./core/identity/actor-facts.ts";
export type { IdentityLinks } from "./core/identity/identity-links.ts";
export type { IdentityService } from "./core/identity/identity-service.ts";
export type {
	IdentityLink,
	IdentityRef,
	LinkSource,
	Principal,
	RoleGrant,
	RoleSource,
} from "./core/identity/principal-store.ts";
export { SYSTEM_PRINCIPAL } from "./core/identity/principal-store.ts";
export type {
	PersonDisplay,
	PersonProfiles,
	ProfileRules,
	ProfileSource,
} from "./core/identity/profiles.ts";
export type {
	Approval,
	ApprovalDetails,
	ApprovalFile,
	ApprovalOptions,
	ApprovalWording,
	ApprovedBy,
	AskOption,
	AskSupport,
	LateAnswer,
	OwnerAnswer,
	OwnerPrompts,
	OwnerQuestion,
	PromptScope,
	Prompts,
	PromptWait,
	Questionnaire,
	QuestionnaireAnswer,
} from "./core/interactions/prompts.ts";
export { promptScope, withdrawalNote } from "./core/interactions/prompts.ts";
export {
	checkAnswer,
	checkQuestionnaireAnswer,
	QUESTIONNAIRE_LIMITS,
	SINGLE_QUESTION,
	shapeFor,
	validateQuestionnaire,
} from "./core/interactions/questionnaire.ts";
export type { JudgeModel } from "./core/judging/model-judge.ts";
export type { LogEntry, LogFn, Logger } from "./core/log.ts";
export type { ThinkingLevel, ThinkingSetting } from "./core/models.ts";
export type {
	AutoApproval,
	ConversationMode,
	ConversationModes,
	ModeChange,
} from "./core/modes/conversation-modes.ts";
export {
	PERSONAL_TARGET,
	type PerPrincipalLimits,
} from "./core/modules/background/personal-target.ts";
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
	PromptDocumentSpec,
	PromptDocuments,
	PromptDocumentView,
	PromptHandle,
	PromptVersion,
} from "./core/modules/prompts/prompt-documents.ts";
export { PromptConflictError } from "./core/modules/prompts/prompt-documents.ts";
export type { PrecheckTool } from "./core/modules/schedules/precheck-tools.ts";
export type {
	Precheck,
	PrecheckContext,
	PrecheckFinding,
	PrecheckRegistry,
	PrecheckResult,
	PrecheckScope,
	PrecheckScriptContext,
	PrecheckScriptRunner,
} from "./core/modules/schedules/prechecks.ts";
export {
	PRECHECK_SCRIPT_CHARS,
	PRECHECK_TIMEOUT_MS,
} from "./core/modules/schedules/prechecks.ts";
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
	SkillDocument,
	SkillSet,
	SkillSource,
	SkillVersion,
} from "./core/modules/skills/skill-rules.ts";
export { SkillConflictError } from "./core/modules/skills/skill-rules.ts";
export type {
	ActionEvent,
	AgentTools,
	Contribution,
	EventHandlers,
	EventSink,
	HostEnv,
	LinkedSessions,
	Persona,
	PluginContext,
	PluginIdentity,
	PromptSection,
	PromptTurn,
	RoundtablePlugin,
	Service,
	ServiceStartedEvent,
	ServiceStartOutcome,
	TurnEndEvent,
	TurnEvent,
	TurnProgressEvent,
} from "./core/plugin.ts";
export type {
	DirectChannelProvider,
	DirectChannels,
	DirectReach,
} from "./core/presence/direct-channels.ts";
export {
	attachReplyFile,
	REPLY_FILE_LIMITS,
	ReplyFileError,
	withReplyFiles,
} from "./core/reply-files.ts";
export type {
	ConversationTurnInput,
	ConversationTurns,
} from "./core/routing/conversation-turns.ts";
export type {
	PeerBotEntry,
	PeerBotsConfig,
} from "./core/routing/peer-bots.ts";
export type {
	AgentChange,
	AgentDirectory,
	AgentServer,
	AgentTeam,
	AgentWorkspace,
	AvatarStudio,
	BackgroundTurns,
	DelegationRequest,
	Delegator,
	MemoryStore,
	NewAgent,
	ScheduleStore,
	SkillRegistry,
	SpeakerMemory,
	WorkerSessionRequest,
	WorkerSessions,
} from "./core/services.ts";
export {
	AGENTS,
	BACKGROUND_TURNS,
	CHANNEL_CONTEXT,
	CONVERSATIONS,
	DELEGATION,
	IDENTITY,
	IDENTITY_LINKS,
	MEMORY,
	MODES,
	PRECHECKS,
	PROFILES,
	PROMPTS,
	RUNTIME,
	SCHEDULES,
	SKILLS,
	THREADS,
	WORKER_SESSIONS,
} from "./core/services.ts";
export type {
	AgentTurnScope,
	ChannelKey,
	SessionContext,
	SessionConversation,
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
