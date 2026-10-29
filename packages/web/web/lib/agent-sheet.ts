// The agent sheet of the page: a menu, the room's header or a link asks for it with
// `openAgentSheet`, and `AgentSheetHost` (mounted once, in the app) draws it.

import { signal } from "./signal.ts";

export interface AgentSheetRequest {
	/** The agent's name, not its room's key. */
	name: string;
	/** The sheet opens scrolled to the character creator. */
	look: boolean;
}

let current: AgentSheetRequest | undefined;
const { emit, use } = signal();

/** Opens the sheet for an agent; one that is open changes to the agent asked for. */
export function openAgentSheet(name: string, options: { look?: boolean } = {}) {
	current = { name, look: options.look === true };
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
