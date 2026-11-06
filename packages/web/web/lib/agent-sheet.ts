// The agent sheet of the page: a menu, the room's header or a link asks for it with
// `openAgentSheet`, and `AgentSheetHost` (mounted once, in the app) draws it.

import { signal } from "./signal.ts";

/** The sheet's tabs. */
export type AgentTab = "profile" | "skills" | "presets" | "look" | "more";

export interface AgentSheetRequest {
	/** The agent's name, not its room's key. */
	name: string;
	/** The sheet opens scrolled to the character creator. */
	look: boolean;
	/** The sheet opens scrolled to the skills the agent carries. */
	skills: boolean;
	/** The tab it opens on; without one, the tab last shown in this page's session. */
	tab: AgentTab | undefined;
	/** Counts the asks, so asking again for the same agent is a new open. */
	id: number;
}

let current: AgentSheetRequest | undefined;
let lastTab: AgentTab = "profile";
let asks = 0;
const { emit, use } = signal();

/** Opens the sheet for an agent; one that is open changes to the agent asked for. */
export function openAgentSheet(
	name: string,
	options: { tab?: AgentTab; look?: boolean; skills?: boolean } = {},
) {
	asks += 1;
	// `look` and `skills` are the older ways to ask for those tabs.
	const tab =
		options.tab ??
		(options.look ? "look" : options.skills ? "skills" : undefined);
	current = {
		name,
		look: tab === "look",
		skills: tab === "skills",
		tab,
		id: asks,
	};
	emit();
}

export function closeAgentSheet(): void {
	if (!current) return;
	current = undefined;
	emit();
}

/** The agent the sheet is open for, if it is open. */
export const currentAgentSheet = (): AgentSheetRequest | undefined => current;

export const useAgentSheet = (): AgentSheetRequest | undefined =>
	use(() => current);

/** The tab the sheet showed last, for whichever agent; the sheet opens on it when no tab is asked for. */
export const lastAgentTab = (): AgentTab => lastTab;

export function rememberAgentTab(tab: AgentTab): void {
	lastTab = tab;
}
