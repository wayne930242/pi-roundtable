import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ResolvedHelpers } from "../config/helpers.ts";
import type { ResolvedRouting } from "../config/routing.ts";
import type { ModelRef } from "../domain/models.ts";
import type { OwnerIdentity } from "../identity/owner-identity.ts";
import type { ErrorReporter } from "../ops/error-reporter.ts";
import type { AgentSessionsSlot } from "../runtime/runtime-plugin.ts";

/**
 * The id of a team that has no id of its own and no Discord guild: the rows the team keeps are
 * stored under it.
 */
export const LOCAL_TEAM_ID = "local";

export interface AgentServerOptions {
	/**
	 * The spaces whose stored places the team lives in, by surface, such as a Discord guild: the
	 * rows moved from a former team id keep their places only in these, and a host with none has
	 * its agents in the rooms of the surfaces that host them. Each surface's place provider must be
	 * contributed by a plugin, or the host refuses to start.
	 */
	placeSpaces?: readonly { surface: string; space: string }[];
	/**
	 * @deprecated The Discord guild the team's channels live in: give it as a `placeSpaces` entry
	 * of the legacy channel surface, and the Discord plugin the entry channel. Without `teamId` the
	 * team is stored under it. Removed in 1.0.
	 */
	guildId?: string;
	/**
	 * The id the team's rows are stored under, independent of the guild; default `guildId`, else
	 * `LOCAL_TEAM_ID`.
	 */
	teamId?: string;
	/**
	 * The ids the team was stored under before, such as a guild it no longer lives in: their rows
	 * move to `teamId` at every boot (`moveTeam`), and, without Discord channels, lose the channel
	 * ids they carried.
	 */
	formerTeamIds?: readonly string[];
	/**
	 * @deprecated The channel the coordinator lives in, a Discord channel of `guildId`: the Discord
	 * plugin's `entryChannel` gives it through its place provider. Never set with `coordinator`.
	 * Removed in 1.0.
	 */
	entryChannelId?: string;
	/**
	 * The coordinator's name on a host where no place provider names one (Discord's entry channel);
	 * the first seed when absent. Refused with `entryChannelId`.
	 */
	coordinator?: string;
	owner: OwnerIdentity & { id: string };
	/** The assistant's display name, as the confirmation judge names it. */
	assistant: string;
	/** Shared with the rest of the host, so logins refresh in one place; lists the models an agent may run. */
	modelRuntime: ModelRuntime;
	dataDir: string;
	/** The model of agents and of the assistant. */
	model: ModelRef;
	/** How sure the confirmation judge must be before its answer is used. */
	judgeThreshold: number;
	/** Where the agent server hands the runtime plugin its per-agent settings. */
	agents?: AgentSessionsSlot;
	/** The shell's shared working directory. */
	workDir: string;
	/**
	 * The agents' scratch dir, created with mode 0700 when the agent server starts: their shell's
	 * TMPDIR, where writes and removals run without a hold.
	 */
	scratchDir?: string;
	/** The host account the agents' shell and file tools run as. */
	shellUser: string;
	/**
	 * Whose turns in the agents' channels load memory: `"everyone"` (the default) or `"owners"`;
	 * see `AgentSessions.memory`.
	 */
	memory?: "everyone" | "owners";
	/**
	 * Who the agents answer in their channels and groups' channels: `"everyone"` (the default) or
	 * `"owners"`, which leaves a speaker below the owner tier unanswered.
	 */
	speakers?: "everyone" | "owners";
	/**
	 * Limits of the downloads of a message's files (`discord.attachmentDownload`): `deadlineMs`
	 * for all of a message's files together (default 60 s), `idleMs` for one file to send no byte
	 * (default 10 s).
	 */
	attachmentDownload?: { deadlineMs?: number; idleMs?: number };
	/** The prompt every agent starts with, and the one for speakers other than the owner. */
	prompts: { shared: string; guest?: string };
	/** The listener the avatar pictures are served on; none mounts no route, and a surface serves them through `AGENTS.avatars.serve`. */
	avatarListener?: string;
	/**
	 * The origin the agents' pictures are served from. Without one a picture's URL is
	 * `/avatars/<hash>.png`, which the surface that serves the pictures resolves against its origin.
	 */
	avatarUrl?: string;
	/**
	 * Render every agent's picture again at start (`characters.refreshAvatars`) and set it where
	 * its hash differs from the stored one; default false.
	 */
	refreshAvatars?: boolean;
	/** The assistant's neutral avatar: the style reference and the picture of an agent without one. */
	avatarReference: string;
	/** The picture used instead when `avatarReference` cannot be read as one; the failure is logged. */
	avatarNeutral?: string;
	/** Reports the process's own errors to an agent; without one nothing is reported. */
	errorReporter?: ErrorReporter;
	/** The checked `routing` block: where work no person started lands. Without it every place is what it was before `routing`. */
	routing?: ResolvedRouting;
	/** The temp knights' limits; `false` leaves `helper_create` and `helper_end` out. Without it the defaults apply. */
	helpers?: ResolvedHelpers | false;
}
