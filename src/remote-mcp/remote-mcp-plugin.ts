import {
	AGENTS,
	type ChannelKey,
	ConfigError,
	type Contribution,
	definePlugin,
	type PluginContext,
	type RoundtablePlugin,
	type TurnResult,
} from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import { ChannelGrantStore } from "./channel-grants.ts";
import {
	DEFAULT_PERSONA,
	defaultConversation,
	REMOTE_KIND,
	type RemoteConversation,
} from "./default-conversation.ts";
import { McpGateway } from "./mcp-gateway.ts";
import { mcpGrantCommands } from "./mcp-grant-commands.ts";
import {
	DEFAULT_TOOL_NAMES,
	type RemoteMcpMessages,
	type RemoteToolNames,
	remoteMcpMessages,
} from "./messages.ts";
import { RemoteAgent } from "./remote-agent.ts";
import { type RemoteClaimHooks, remoteClaim } from "./remote-claim.ts";
import { RemoteSessionStore } from "./remote-session-store.ts";
import { RemoteSessionSweeper } from "./session-sweeper.ts";

/** The listener the host's `http` block opens; the endpoints are reachable wherever it is. */
const LISTENER = "public";

interface RemoteMcpBaseOptions {
	/** The bearer token an outside agent presents at `/mcp/personal`; keep it secret and long. */
	dispatchToken: string;
	/**
	 * The HTTPS address outside agents reach the host's `public` listener at. Granted-channel
	 * URLs are built on its origin: `<origin>/mcp/discord/<token>`.
	 */
	publicUrl: string;
	/** The Discord text, the relay note, and the tool descriptions in your wording; English by default. */
	messages?: Partial<RemoteMcpMessages>;
	/**
	 * The names of the two tools at `/mcp/personal`, for agents already set up with other names;
	 * `agent_dispatch` and `agent_result` by default. The default descriptions follow the names.
	 */
	toolNames?: Partial<RemoteToolNames>;
}

/** Remote turns run on the core's runtime: nothing more to give. */
export interface DefaultConversationOptions {
	/** The system prompt of the `remote` conversations; a short neutral one by default. */
	persona?: string;
	answer?: undefined;
	claim?: undefined;
}

/** The host runs the remote turns itself, and says what its conversations do. */
export interface HostConversationOptions {
	/**
	 * Runs one turn for the owner in the session's channel and never rejects. It runs inside the
	 * channel's queue (`context.queue.run`) itself, and the conversation it opens has a persona of
	 * the host's own.
	 */
	answer(channel: ChannelKey, text: string): Promise<TurnResult>;
	/** What the claim over the remote channels does with those conversations. */
	claim: RemoteClaimHooks;
	persona?: undefined;
}

export type RemoteMcpOptions = RemoteMcpBaseOptions &
	(DefaultConversationOptions | HostConversationOptions);

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The tool names with the host's overrides laid over the defaults; refuses names a client cannot use. */
function toolNamesOf(options: RemoteMcpOptions): RemoteToolNames {
	const names = { ...DEFAULT_TOOL_NAMES, ...options.toolNames };
	for (const name of Object.values(names))
		if (!TOOL_NAME.test(name))
			throw new ConfigError(
				`remote-mcp: toolNames: "${name}" is not a tool name (letters, digits, _ and -, up to 64)`,
			);
	if (names.dispatch === names.result)
		throw new ConfigError("remote-mcp: toolNames: the two names must differ");
	return names;
}

function checkOptions(options: RemoteMcpOptions): void {
	if (!options.dispatchToken)
		throw new ConfigError("remote-mcp: dispatchToken is empty");
	const base = URL.parse(options.publicUrl);
	if (base?.protocol !== "https:")
		throw new ConfigError("remote-mcp: publicUrl must be an https URL");
	if (Boolean(options.answer) !== Boolean(options.claim))
		throw new ConfigError(
			"remote-mcp: answer and claim go together: give both to run the remote turns yourself, or neither to use the core's runtime",
		);
}

/**
 * An MCP server over HTTP for outside agents: `/mcp/personal` relays turns to the owner's agent
 * and returns the result when polled, and `/mcp/discord/<token>` offers the Discord channel
 * tools granted to one bundle. Grants are approved on Discord with `/<root> mcp`.
 */
export function remoteMcp(options: RemoteMcpOptions): RoundtablePlugin {
	checkOptions(options);
	const text = remoteMcpMessages(options.messages);
	const toolNames = toolNamesOf(options);
	return definePlugin({
		name: "remote-mcp",
		requires: [DISCORD],
		migrations: [ChannelGrantStore.migration, RemoteSessionStore.migration],
		setup: async (context) => {
			const { services, logger, conversations, database } = context;
			const discord = services.get(DISCORD);
			const conversation = conversationOf(options, context);
			const grants = await ChannelGrantStore.attach(database());
			const sessions = await RemoteSessionStore.attach(database());
			const gateway = new McpGateway({
				dispatchToken: options.dispatchToken,
				agent: new RemoteAgent({
					sessions,
					answer: conversation.answer,
					logger,
					messages: text,
				}),
				grants,
				executor: () => discord.connection.channelExecutor(),
				logger,
				messages: text,
				toolNames,
			});
			const sweeper = new RemoteSessionSweeper({
				sessions,
				deleteConversation: (channel) =>
					conversations.deleteConversation(channel),
				logger,
			});
			discord.commands.add(
				mcpGrantCommands(discord.guard, grants, options.publicUrl, text),
			);
			return {
				services: [
					{
						name: "remote-sweeper",
						start: () => sweeper.start(),
						stop: () => sweeper.stop(),
					},
				],
				http: gateway.routes(LISTENER),
				channels: [remoteClaim(conversation.claim, sessions)],
				...personaOf(options),
			} satisfies Contribution;
		},
	});
}

/** The host's own turns, or the default ones over the core's runtime. */
function conversationOf(
	options: RemoteMcpOptions,
	{ queue, turns, services }: PluginContext,
): RemoteConversation {
	if (options.answer) return { answer: options.answer, claim: options.claim };
	return defaultConversation({ queue, turns, server: services.lazy(AGENTS) });
}

/** The persona of the default conversations; a host that runs its own brings its own. */
function personaOf(options: RemoteMcpOptions): Pick<Contribution, "personas"> {
	if (options.answer) return {};
	const prompt = options.persona ?? DEFAULT_PERSONA;
	return { personas: [{ kind: REMOTE_KIND, prompt: () => prompt }] };
}
