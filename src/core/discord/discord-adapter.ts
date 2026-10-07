import type { DiscordAdapterConfig, DiscordConfig } from "../config/config.ts";

/**
 * The Discord adapter, for `adapters: [discord({ ... })]` in roundtable.config.ts: the same
 * settings, and the same host, as the top-level `discord`.
 */
export function discord(options: DiscordConfig): DiscordAdapterConfig {
	return { adapter: "discord", discord: options };
}
