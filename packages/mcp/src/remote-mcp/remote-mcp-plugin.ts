import {
	AGENTS,
	type ChannelKey,
	ConfigError,
	type Contribution,
	definePlugin,
	IDENTITY,
	type IdentityService,
	type PluginContext,
	PluginError,
	type RoundtablePlugin,
	type Speaker,
	type TurnResult,
} from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import { ChannelGrantStore } from "./channel-grants.ts";
import {
	DEFAULT_PERSONA,
	defaultConversation,
	MEMBER_PERSONA,
	REMOTE_KIND,
	type RemoteConversation,
} from "./default-conversation.ts";
import { McpGateway } from "./mcp-gateway.ts";
import { mcpGrantCommands } from "./mcp-grant-commands.ts";
import {
	DEFAULT_TOOL_NAMES,
	REMOTE_MCP_MESSAGES,
	type RemoteMcpMessages,
	type RemoteToolNames,
	remoteMcpMessages,
} from "./messages.ts";
import { RemoteAgent } from "./remote-agent.ts";
import { type RemoteClaimHooks, remoteClaim } from "./remote-claim.ts";
import { REMOTE_MCP, remoteMcpService } from "./remote-mcp-service.ts";
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
	/**
	 * The id of the principal the dispatch token stands for: whose memory, schedules, conversations,
	 * and tier the remote turns have. The primary owner, the first of `access.owners`, by default,
	 * as in 0.8. The token is the identity `token:<toolNames.dispatch, or remote-mcp>`, which the
	 * host links to this principal at every start; a principal that does not exist stops the start.
	 */
	principal?: string;
}

/** Remote turns run on the core's runtime: nothing more to give. */
export interface DefaultConversationOptions {
	/**
	 * The system prompt of the `remote` conversations. By default a short one that names the owner
	 * when the token stands for an owner at the start, and names no one otherwise.
	 */
	persona?: string;
	answer?: undefined;
	claim?: undefined;
}

/** The host runs the remote turns itself, and says what its conversations do. */
export interface HostConversationOptions {
	/**
	 * Runs one turn in the session's channel and never rejects. It runs inside the channel's queue
	 * (`context.queue.run`) itself, and the conversation it opens has a persona of the host's own.
	 * `speaker` is whom the turn is for: the principal the dispatch token stands for, from
	 * `IDENTITY.speakerFor`.
	 */
	answer(
		channel: ChannelKey,
		text: string,
		speaker: Speaker,
	): Promise<TurnResult>;
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

/** The identity the dispatch token is: `token:<toolNames.dispatch, or remote-mcp>`. */
const tokenIdentity = (options: RemoteMcpOptions): string =>
	`token:${options.toolNames?.dispatch ?? "remote-mcp"}`;

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
 * An MCP server over HTTP for outside agents: `/mcp/personal` relays turns, for the principal the
 * dispatch token stands for, to the agent and returns the result when polled, and
 * `/mcp/discord/<token>` offers the Discord channel tools granted to one bundle. Grants are
 * approved on Discord with `/<root> mcp`. Provides `REMOTE_MCP`.
 */
export function remoteMcp(options: RemoteMcpOptions): RoundtablePlugin {
	checkOptions(options);
	const text = remoteMcpMessages(options.messages);
	const toolNames = toolNamesOf(options);
	const identity = tokenIdentity(options);
	return definePlugin({
		name: "remote-mcp",
		requires: [DISCORD, IDENTITY],
		provides: [REMOTE_MCP],
		identities: [
			{
				identity,
				...(options.principal === undefined
					? {}
					: { principal: options.principal }),
			},
		],
		migrations: [
			ChannelGrantStore.migration,
			...RemoteSessionStore.migrations(),
		],
		setup: async (context) => {
			const { services, logger, conversations, database } = context;
			const discord = services.get(DISCORD);
			const identities = services.get(IDENTITY);
			const bound = await boundPrincipal(identities, identity);
			const conversation = conversationOf(options, context);
			const grants = await ChannelGrantStore.attach(database());
			const sessions = await RemoteSessionStore.attach(database());
			// 0.8's sessions were the owner's.
			const [primary] = await identities.owners();
			if (primary) await sessions.adopt(primary.id);
			const gateway = new McpGateway({
				dispatchToken: options.dispatchToken,
				agent: new RemoteAgent({
					sessions: {
						create: () => sessions.create(bound.id),
						touch: (id) => sessions.touch(id, bound.id),
					},
					answer: async (channel, relayed) =>
						conversation.answer(
							channel,
							relayed,
							await identities.speakerFor(bound.id),
						),
					logger,
					messages: { ...text, relayNote: relayNoteOf(options, bound) },
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
			services.provide(REMOTE_MCP, remoteMcpService(grants, text));
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
				...personaOf(options, bound),
			} satisfies Contribution;
		},
	});
}

/** The principal the dispatch token stands for, and whether they held the owner role at the start. */
interface Bound {
	id: string;
	owner: boolean;
}

/** Whom the identity plugin linked the dispatch token to at this start. */
async function boundPrincipal(
	identities: IdentityService,
	identity: string,
): Promise<Bound> {
	const id = await identities.principalOf(identity);
	if (id === undefined)
		throw new PluginError(
			`remote-mcp: ${identity}, the dispatch token's identity, is linked to no principal. The built-in identity plugin links it at the start; an IDENTITY that replaces it must link the identities plugins declare.`,
		);
	return { id, owner: (await identities.tierOf(id)) === "owner" };
}

/** The note opening every relayed message: the owner's, or for anyone else one that names no owner. */
function relayNoteOf(options: RemoteMcpOptions, bound: Bound): string {
	const given = options.messages;
	if (bound.owner) return given?.relayNote ?? REMOTE_MCP_MESSAGES.relayNote;
	return (
		given?.memberRelayNote ??
		given?.relayNote ??
		REMOTE_MCP_MESSAGES.memberRelayNote
	);
}

/** The host's own turns, or the default ones over the core's runtime. */
function conversationOf(
	options: RemoteMcpOptions,
	{ queue, turns, services }: PluginContext,
): RemoteConversation {
	if (options.answer) return { answer: options.answer, claim: options.claim };
	return defaultConversation({ queue, turns, server: services.lazy(AGENTS) });
}

/**
 * The persona of the default conversations, the owner's or one that names no owner, as the token
 * stands for at the start; a host that runs its own brings its own.
 */
function personaOf(
	options: RemoteMcpOptions,
	bound: Bound,
): Pick<Contribution, "personas"> {
	if (options.answer) return {};
	const prompt =
		options.persona ?? (bound.owner ? DEFAULT_PERSONA : MEMBER_PERSONA);
	return { personas: [{ kind: REMOTE_KIND, prompt: () => prompt }] };
}
