/** The built-in coordinator profiles; each owner connector adds one more at runtime. */
export const STATIC_PROFILE_IDS = [
	"general",
	"research",
	"workspace",
	"discord",
	"coding",
] as const;

export type StaticProfileId = (typeof STATIC_PROFILE_IDS)[number];

/** A built-in profile id, or `connector:<name>` for an owner connector. */
export type ProfileId = string;

export const DEFAULT_PROFILE: StaticProfileId = "general";

/** A coordinator profile: the same persona with a different set of active tools. */
export interface Profile {
	id: ProfileId;
	/** What the judge reads to decide whether a message belongs to this profile. */
	criterion: string;
	/** Exact names of the assistant's own and Pi package tools active while this profile handles a turn. */
	tools: readonly string[];
	/** MCP gateway virtual servers whose every tool is also active. */
	mcpServers: readonly string[];
}

/** The profiles a turn can be routed to right now. */
export interface ProfileCatalog {
	list(): Profile[];
	get(id: ProfileId): Profile | undefined;
}
