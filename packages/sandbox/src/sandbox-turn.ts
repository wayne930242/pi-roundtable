import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ChannelKey, parseChannelKey } from "pi-roundtable";
import {
	type BrokerListener,
	SandboxBroker,
	type SandboxSpeaker,
} from "./broker.ts";
import {
	channelStateName,
	channelWorkspaceName,
	guildWorkspaceName,
} from "./layout.ts";
import {
	CHANNEL_PATH,
	type SandboxReply,
	type SandboxTurn,
} from "./protocol.ts";
import {
	DEFAULT_PROMPT,
	type ResolvedSandboxRuntimeOptions,
	resolveFiles,
} from "./runtime-options.ts";

interface SandboxTurnRequest {
	channel: ChannelKey;
	/** The message's guild, when it has one. */
	space?: string;
	speaker: SandboxSpeaker;
	text: string;
	reset: boolean;
	signal: AbortSignal;
}

/**
 * The directory names of a turn: the guild's shared workspace and the channel's own state
 * directory with `workspace: "server"` and a guild, the channel's own workspace otherwise.
 */
function directories(
	options: Pick<ResolvedSandboxRuntimeOptions, "workspace">,
	channel: ChannelKey,
	space: string | undefined,
): { workspace: string; state?: string } {
	if (options.workspace === "server" && space !== undefined)
		return {
			workspace: guildWorkspaceName(parseChannelKey(channel).surface, space),
			state: channelStateName(channel),
		};
	return { workspace: channelWorkspaceName(channel) };
}

/** What turns must not run alongside: the workspace they share. */
export function workspaceKey(
	options: Pick<ResolvedSandboxRuntimeOptions, "workspace">,
	channel: ChannelKey,
	space: string | undefined,
): string {
	return directories(options, channel, space).workspace;
}

/**
 * Owns one turn's broker mount, listener and driver call. The reply is delivered
 * before resource cleanup so the runtime acknowledges a successful reset at the
 * same point as the worker, even if subsequent cleanup fails.
 */
export async function runSandboxTurn(
	options: ResolvedSandboxRuntimeOptions,
	request: SandboxTurnRequest,
	onReply: (reply: SandboxReply) => void,
): Promise<SandboxReply> {
	const { channel, speaker, text, reset, signal } = request;
	// The container is named by its channel, which two turns of one workspace never share.
	const segment = channelWorkspaceName(channel);
	const files = resolveFiles(options.files);
	const names = directories(options, channel, request.space);
	const workspaceDir = join(options.workspaceRoot, names.workspace);
	mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
	const channelDir =
		names.state === undefined
			? undefined
			: join(options.workspaceRoot, names.state);
	if (channelDir) mkdirSync(channelDir, { recursive: true, mode: 0o700 });
	const runDir = mkdtempSync(join(options.runRoot, "turn-"));
	const socket = join(runDir, "broker.sock");
	if (socket.length > 100) {
		rmSync(runDir, { recursive: true });
		throw new Error("broker socket path too long");
	}
	let server: BrokerListener | undefined;
	try {
		server = await new SandboxBroker({
			...options,
			toolResultBytes: options.budgets?.toolResultBytes,
			context: { channel, speaker, signal },
		}).listen(socket);
		const turn: SandboxTurn = {
			text,
			// The worker reads who speaks; whose principal they are stays with the host.
			speaker: { id: speaker.id, name: speaker.name },
			model: options.model,
			prompt: options.prompt ?? DEFAULT_PROMPT,
			timeZone: options.timeZone ?? "UTC",
			reset,
			...(options.budgets ? { budgets: options.budgets } : {}),
			...(channelDir ? { historyDir: CHANNEL_PATH } : {}),
			...(files ? { files } : {}),
			tools: (options.tools ?? []).map(({ name, description, parameters }) => ({
				name,
				description,
				parameters,
			})),
			mcp: (options.mcp ?? []).map(({ name, tools }) => ({
				server: name,
				tools,
			})),
		};
		const reply = await options.driver.run(
			{
				name: `roundtable-sandbox-${segment.slice(0, 16)}-${randomUUID().slice(0, 8)}`,
				image: options.image,
				runDir,
				workspaceDir,
				...(channelDir ? { channelDir } : {}),
				uid: options.uid,
				gid: options.gid,
				...options.limits,
			},
			turn,
			signal,
		);
		onReply(reply);
		return reply;
	} finally {
		await server?.stop(true);
		// This mount was read-only to the container; workspace files are deliberately untouched.
		rmSync(runDir, { recursive: true, force: true });
	}
}
