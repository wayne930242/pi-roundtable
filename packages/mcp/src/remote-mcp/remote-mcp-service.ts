import type { Client } from "discord.js";
import { serviceKey } from "pi-roundtable";
import {
	CHANNEL_OPERATIONS,
	type ChannelOperation,
	OwnerFacingError,
	operationLabel,
} from "pi-roundtable/discord";
import type { ChannelGrant, ChannelGrantStore } from "./channel-grants.ts";
import {
	type Authorized,
	type AuthorizeInput,
	type BundleView,
	GrantOperations,
} from "./grant-operations.ts";
import { describeGrant } from "./mcp-grant-panels.ts";
import type { RemoteMcpMessages } from "./messages.ts";

/** A refusal the owner can act on, in the configured wording; `refusal` marks it for a host that does not know this class. */
export class RemoteMcpError extends Error {
	readonly refusal = true;
}

/** What a host reads to show the owner which channels outside agents may use, and to manage them as `/<root> mcp` does. */
export interface RemoteMcpService {
	/** The owner's bundles and their channel grants, read only. */
	grants: Pick<ChannelGrantStore, "bundles" | "grants">;
	/** One grant as lines of text: the agent's name for the channel, where it is, its purpose, and the allowed operations. */
	describeGrant(client: Client, grant: ChannelGrant): Promise<string>;
	/** Every operation a grant may allow, in order, with its label. */
	readonly operations: readonly { id: ChannelOperation; label: string }[];
	/** Every bundle with its channels, their operations, and each channel's recent audit entries. */
	bundles(client: Client): Promise<BundleView[]>;
	/** Removes a channel from a bundle; refuses an unknown bundle or a channel not in it. */
	revoke(bundle: string, channelId: string): Promise<void>;
	/** Changes the channel name and purpose an agent sees; give either or both. */
	describe(
		bundle: string,
		channelId: string,
		change: { displayName?: string; description?: string },
	): Promise<void>;
	/** Replaces a bundle's MCP URL; the new URL is returned this once and only its hash is kept. */
	rotate(bundle: string): Promise<{ url: string }>;
	/**
	 * Adds a channel to a bundle with the chosen operations, creating the bundle when it does not
	 * exist, under the checks `/<root> mcp authorize` makes: the channel is a server text or
	 * announcement channel, `userId` (the acting owner's Discord ID) may manage it, and they and
	 * the bot both hold the permissions behind each operation. A new bundle's URL is in the result
	 * this once.
	 */
	authorize(client: Client, input: AuthorizeInput): Promise<Authorized>;
}

export const REMOTE_MCP = serviceKey<RemoteMcpService>(
	"pi-roundtable-mcp.remote-mcp",
);

/** The flow's refusals, as this service's. */
async function refused<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		if (error instanceof OwnerFacingError)
			throw new RemoteMcpError(error.message);
		throw error;
	}
}

/** The service over the plugin's grant store and its wording. */
export function remoteMcpService(
	grants: ChannelGrantStore,
	text: RemoteMcpMessages,
	publicUrl: string,
	root: string,
): RemoteMcpService {
	const ops = new GrantOperations(grants, publicUrl, root, text);
	return {
		grants: {
			bundles: () => grants.bundles(),
			grants: (...args) => grants.grants(...args),
		},
		describeGrant: (client, grant) => describeGrant(client, grant, text),
		operations: CHANNEL_OPERATIONS.map((id) => ({
			id,
			label: operationLabel(id),
		})),
		bundles: (client) => ops.bundles(client),
		revoke: (bundle, channelId) =>
			refused(async () => {
				const found = await ops.bundle(bundle);
				if (!(await ops.revoke(found, ops.channelId(channelId))))
					throw new OwnerFacingError(text.revokeNotInBundle(found.name));
			}),
		describe: (bundle, channelId, change) =>
			refused(async () => {
				const found = await ops.bundle(bundle);
				if (!(await ops.describe(found, ops.channelId(channelId), change)))
					throw new OwnerFacingError(text.notInBundle(found.name));
			}),
		rotate: (bundle) =>
			refused(async () => ({
				url: await ops.rotate((await ops.bundle(bundle)).id),
			})),
		authorize: (client, input) =>
			refused(async () => {
				const done = await ops.authorize(client, {
					...input,
					bundle: ops.bundleName(input.bundle),
					channelId: ops.channelId(input.channelId),
					operations: ops.operations(input.operations),
				});
				return {
					bundle: done.bundle,
					channelName: done.channelName,
					operations: done.operations,
					...(done.url ? { url: done.url } : {}),
				};
			}),
	};
}
