import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
	AgentTurnScope,
	SessionTool,
	SessionToolSnapshot,
} from "../sessions.ts";

/** A session tool whose extension never changes. */
export function fixed(
	name: string,
	factory: SessionToolSnapshot["factory"],
): SessionTool {
	return { name, phase: "tools", snapshot: () => ({ revision: 0, factory }) };
}

/** A session tool whose extension never changes, for agent sessions only. */
export function agentOnly(
	name: string,
	factory: (scope: AgentTurnScope) => ExtensionFactory,
): SessionTool {
	return fixed(name, (session) =>
		session.agent ? factory(session.agent) : null,
	);
}
