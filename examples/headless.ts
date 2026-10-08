import { definePlugin, type RoundtableConfig } from "pi-roundtable";
import type { FakeSurface } from "./fake-surface.ts";
import { studyRoom } from "./study-room.ts";

/** A plugin that brings a chat network and nothing else; the study room's claim answers its rooms. */
export function chatNetwork(surface: FakeSurface) {
	return definePlugin({
		name: "chat-network",
		setup: () => ({ surfaces: [surface] }),
	});
}

/**
 * A host without Discord: no `discord` key, so no Discord plugin, no agent server, no agents and
 * no skills; and no `http`, so no listener opens until a plugin needs one. Conversations come
 * through the plugins' own chat surfaces, and `context.turns` runs them on the host's runtime,
 * Pi's unless a plugin fills the `runtime` slot.
 */
export function studyHall(
	surface: FakeSurface,
	where: { databaseUrl: string; dataDir: string },
): RoundtableConfig {
	return {
		name: "Study Hall",
		access: {
			owners: [{ principal: "owner", name: "Ada" }],
			// Admit the fake surface's authors explicitly, not in the claim.
			members: { everyone: ["fake"] },
		},
		database: { url: where.databaseUrl },
		dataDir: where.dataDir,
		model: "anthropic/claude-sonnet-5-5",
		plugins: [chatNetwork(surface), studyRoom],
	};
}
