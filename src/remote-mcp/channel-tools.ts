import {
	CHANNEL_TOOLS,
	type ChannelExecutor,
	ChannelToolError,
} from "pi-roundtable/discord";
import type { ChannelBundle, ChannelGrantStore } from "./channel-grants.ts";

/**
 * Runs one tool call for a bundle. The grant and the bundle's token are read after Discord
 * is inspected, so a revoke or token rotation during that network call still stops it.
 */
export async function runGrantedTool(
	bundle: ChannelBundle,
	tool: string,
	args: Record<string, unknown>,
	store: ChannelGrantStore,
	executor: ChannelExecutor,
): Promise<unknown> {
	const spec = CHANNEL_TOOLS[tool];
	const channelId = args.channelId;
	if (!spec || typeof channelId !== "string")
		throw new ChannelToolError("INVALID_CHANNEL_OPERATION");
	const { guildId } = await executor.inspect(channelId, spec.operation);
	const [grant, current] = await Promise.all([
		store.grant(bundle.id, channelId),
		store.bundleByTokenHash(bundle.tokenHash),
	]);
	if (current?.id !== bundle.id) throw new ChannelToolError("ENDPOINT_REVOKED");
	if (
		!grant ||
		grant.guildId !== guildId ||
		!grant.operations.includes(spec.operation)
	)
		throw new ChannelToolError("CHANNEL_NOT_AUTHORIZED");
	const receipt = await store.startCall(bundle.id, guildId, tool, args);
	let result: unknown;
	try {
		result = await executor.execute(tool, args);
	} catch {
		await store.finishCall(receipt, "failed");
		throw new ChannelToolError(
			`DISCORD_OPERATION_FAILED: audit entry ${receipt}`,
		);
	}
	try {
		await store.finishCall(receipt, "succeeded");
	} catch {
		throw new ChannelToolError(
			`DISCORD_OUTCOME_UNRECORDED: the operation may have completed, so do not retry automatically. Audit entry ${receipt}`,
		);
	}
	return result;
}
