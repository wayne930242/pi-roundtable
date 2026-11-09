import type { CharacterSpec } from "../../characters/index.ts";
import type { HttpRoute } from "../http/listeners.ts";

/**
 * The directories the agents work in, as configured. Every agent shares them: the core has no
 * workspace per agent. Read-only data for a plugin that shows or serves the files; they may not exist yet.
 */
export interface AgentWorkspace {
	/** The shell's shared working directory (`config.workDir`), where agents write without a hold. */
	readonly workDir: string;
	/** The agents' scratch dir (TMPDIR), when the host sets one; writes there are unheld too. */
	readonly scratchDir?: string;
}

/** Agent pictures: rendered from the agent's character, kept and served by content hash. */
export interface AvatarStudio {
	/** @deprecated Agents are no longer drawn, so this only tells whether an image provider is configured (it gates the generate_image hint); removed in 1.0. */
	readonly canDraw: boolean;
	/** The public URL of a picture, or of the default when there is none. */
	url(hash: string | undefined): string;
	/**
	 * Renders a character as the agent's picture (512 px PNG, modern light disc, idle face), stores
	 * it by content hash, and returns the hash; the same spec gives the same hash.
	 */
	render(spec: CharacterSpec): Promise<string>;
	/** @deprecated Agents are composed characters and no longer drawn; removed in 1.0. Draws a new picture from an avatar prompt; returns its hash. */
	draw(avatarPrompt: string): Promise<string>;
	/** @deprecated Removed in 1.0. Edits a stored picture by an instruction; returns the new picture's hash. */
	edit(hash: string | undefined, instruction: string): Promise<string>;
	/** @deprecated Removed in 1.0. A picture made from an agent's display name and name, for a host without an image provider; returns its hash. */
	fallback(displayName: string, name: string): Promise<string>;
	/** The pictures, public on the named listener. */
	route(listener: string): HttpRoute;
	/** Serves `/avatars/<hash>.png`; undefined for any other path. */
	serve(pathname: string): Response | undefined;
}
