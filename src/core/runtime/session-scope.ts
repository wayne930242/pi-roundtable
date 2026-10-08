import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TurnConversation } from "../domain/ports.ts";
import { archiveSessions } from "./session-archive.ts";

/** The custom entry a session's history records whom it served in. */
const SCOPE_ENTRY = "roundtable-conversation";

/** Whom a conversation serves, as a session's history records it. */
type Scope = Pick<TurnConversation, "visibility"> & { principalId?: string };

function scopeOf(conversation: Scope): TurnConversation {
	return conversation.visibility === "private" &&
		conversation.principalId !== undefined
		? { visibility: "private", principalId: conversation.principalId }
		: { visibility: "shared" };
}

/** Whether two scopes are the same: shared both, or private to the same principal. */
export function sameScope(a: Scope, b: Scope): boolean {
	return JSON.stringify(scopeOf(a)) === JSON.stringify(scopeOf(b));
}

/** The scope the history last recorded, or undefined when it records none, as before 0.9. */
function recordedScope(manager: SessionManager): TurnConversation | undefined {
	const entry = manager
		.getEntries()
		.findLast(
			(entry) => entry.type === "custom" && entry.customType === SCOPE_ENTRY,
		);
	return entry?.type === "custom"
		? scopeOf(entry.data as TurnConversation)
		: undefined;
}

/**
 * The latest history in `dir` for a session of the scope. A history recorded in another scope is
 * archived, so the session starts with none: one person's conversation never replays for someone
 * else, nor a private one in a shared one or the other way. A history that records no scope, as
 * one made before 0.9, carries on. The history the session continues records its scope.
 */
export function scopedHistory(
	dir: string,
	cwd: string,
	scope: Scope,
): { history: SessionManager; archived: number } {
	let history = SessionManager.continueRecent(cwd, dir);
	const recorded = recordedScope(history);
	let archived = 0;
	if (recorded && !sameScope(recorded, scope)) {
		archived = archiveSessions(dir);
		history = SessionManager.continueRecent(cwd, dir);
	}
	if (!recorded || archived > 0)
		history.appendCustomEntry(SCOPE_ENTRY, scopeOf(scope));
	return { history, archived };
}

/**
 * The messages of the latest history in `dir`, read without opening a session, so reading them
 * fixes no scope; none when it was recorded in another scope than `scope`.
 */
export function historyMessages(dir: string, cwd: string, scope: Scope) {
	if (!existsSync(dir)) return [];
	const history = SessionManager.continueRecent(cwd, dir);
	const recorded = recordedScope(history);
	if (recorded && !sameScope(recorded, scope)) return [];
	return history.buildSessionContext().messages;
}
