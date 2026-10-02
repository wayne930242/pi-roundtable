import type { Client } from "discord.js";
import { serviceKey } from "pi-roundtable";
import type { ChannelGrant, ChannelGrantStore } from "./channel-grants.ts";
import { describeGrant } from "./mcp-grant-panels.ts";
import type { RemoteMcpMessages } from "./messages.ts";

/** What a host reads to show the owner which channels outside agents may use. */
export interface RemoteMcpService {
	/** The owner's bundles and their channel grants, read only. */
	grants: Pick<ChannelGrantStore, "bundles" | "grants">;
	/** One grant as lines of text: the agent's name for the channel, where it is, its purpose, and the allowed operations. */
	describeGrant(client: Client, grant: ChannelGrant): Promise<string>;
}

export const REMOTE_MCP = serviceKey<RemoteMcpService>(
	"pi-roundtable-mcp.remote-mcp",
);

/** The service over the plugin's grant store and its wording. */
export function remoteMcpService(
	grants: ChannelGrantStore,
	text: RemoteMcpMessages,
): RemoteMcpService {
	return {
		grants: {
			bundles: () => grants.bundles(),
			grants: (...args) => grants.grants(...args),
		},
		describeGrant: (client, grant) => describeGrant(client, grant, text),
	};
}
