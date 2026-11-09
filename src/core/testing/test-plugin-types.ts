import type { SQL } from "bun";
import type { PeerBotsConfig } from "../config/peer-bots.ts";
import type { ConversationPort } from "../contract/channels.ts";
import type { Providers } from "../contract/providers.ts";
import type { AgentRuntime } from "../contract/runtime.ts";
import type { ChatSurface, SurfacePort } from "../contract/surface.ts";
import type { ClientPart, ClientPort } from "../domain/client.ts";
import type { ReplyFile } from "../domain/conversation.ts";
import type { ChannelKey, SessionContext } from "../domain/sessions.ts";
import type { ListenerConfig } from "../http/listeners.ts";
import type { OwnerIdentity } from "../identity/owner-identity.ts";
import type { Speaker } from "../identity/speakers.ts";
import type { HoldCheck } from "../plugin-api/holds.ts";
import type {
	Contribution,
	HostEnv,
	TurnEndEvent,
	TurnEvent,
} from "../plugin-api/plugin.ts";
import type { ConversationTurns } from "../routing/conversation-turns.ts";
import type { ToolTierTable } from "../runtime/tool-tiers.ts";
import type { ServicePair } from "./service-pair.ts";

export interface TestPluginOptions {
	/** The host environment the plugin sees; default en and UTC. */
	env?: Partial<HostEnv>;
	/**
	 * The owner the runtime's dependencies and the agent server's claim know; default `owner`,
	 * named Owner, who is addressed as they.
	 */
	owner?: { id: string; name: string; pronouns?: OwnerIdentity["pronouns"] };
	database?: SQL;
	providers?: Partial<Providers>;
	/**
	 * Chat surfaces besides the plugin's own, such as a fake one: they are in `context.surfaces`,
	 * started with the plugin's services (their messages reach `conversations`), and stopped last.
	 */
	surfaces?: readonly ChatSurface[];
	/**
	 * What the plugin reads from `context.services`, one `servicePair(KEY, { ... })` per service.
	 * `servicePair(RUNTIME, runtime)` is the runtime that `context.turns` runs turns on, given
	 * whole rather than member by member; `servicePair(AGENTS, { runtime })` still works when no
	 * `RUNTIME` is given. Without either, a plugin that fills the `runtime` slot gets the runtime its
	 * provider builds, under both keys. A service
	 * not given here reads as absent to `find`, and `get` names this option, except for what the
	 * host supplies anyway: `BACKGROUND_TURNS`, the real background turns over the test's router,
	 * and, once `AGENTS` is given, its `approvals` (the real confirmation judge over
	 * `providers.judge`, when the test gives a judge). Giving `AGENTS` a `team` adds the agent
	 * server's own claim to the router, answering as the host's would for the `owner`. The router
	 * resolves who wrote each message through a given `IDENTITY`; without one only the `owner` is
	 * anyone, at the owner tier, their principal their id.
	 */
	services?: readonly ServicePair[];
	/**
	 * The plugin's conversations: by default a router over the plugin's own `channels` claims, so a
	 * message a surface delivers reaches them. Methods given here replace the router's.
	 */
	conversations?: Partial<ConversationPort>;
	/** Replaces `context.turns`, which by default runs turns over the runtime and the surfaces. */
	turns?: ConversationTurns;
	/** The credentials `context.apiKey` returns, by provider name; a provider not listed reads as having none, as on a host not logged in to it. */
	apiKeys?: Readonly<Record<string, string>>;
	/** How long the router holds a bare forward for the message that follows it; the host option `conversations.forwardJoinMs`. */
	forwardJoinMs?: number;
	/** The peer bots the router answers, as the host option `peerBots` (`discord.peerBots`); default none. */
	peerBots?: PeerBotsConfig;
	/** The addresses `context.listener(id)` reports; a plugin that reads one gets `undefined` for any not listed. */
	listeners?: readonly ListenerConfig[];
}

export interface RecordedEvent {
	name: "turnStarted" | "turnEnded" | "changed";
	turn?: TurnEvent | TurnEndEvent;
}

export interface TestPluginResult {
	contribution: Contribution;
	/** The hold rules the plugin contributed, chained as the host links them: the description of a call that must be approved first, or undefined. `holds.inTurn(tool, input, context, turn)` asks them as a turn does, so a hold that looks things up (and may return a promise) is called with the turn; the plain call has no turn, and counts a hold that declares `turn` as held under `run <tool>`. */
	holds: HoldCheck;
	/** What the plugin sees as `context.conversations`, for a test to drive its claims. */
	conversations: ConversationPort;
	/** What the plugin sees as `context.turns`. */
	turns: ConversationTurns;
	/** What the plugin sees as `context.surfaces`: its own surfaces and the injected ones. */
	surfaces: SurfacePort;
	/** The runtime the plugin's `runtime` provider built, given stand-in dependencies; undefined when it fills no such slot. */
	runtime: AgentRuntime | undefined;
	tools: readonly string[];
	tiers: ToolTierTable;
	events: RecordedEvent[];
	/** Files accepted by successful runTool calls, copied and recorded with their channel. */
	files: { channel: ChannelKey; file: ReplyFile }[];
	/** Images returned by successful runTool calls, with their channel. */
	images: { channel: ChannelKey; image: ClientPart }[];
	runTool(
		name: string,
		args: Record<string, unknown>,
		/** `workspace` gives the session a workspace and scratch dir, as an agent's session has. */
		options?: {
			speaker?: Speaker;
			/** Where the turn's request came from, as `ToolTurn.origin` shows it to the tool. */
			origin?: string;
			/** What the party that started the turn can do for the tool, as `ToolTurn.client` shows it. */
			client?: ClientPort;
			channel?: ChannelKey;
			workspace?: SessionContext["workspace"];
		},
	): Promise<string>;
	stop(): Promise<void>;
}
