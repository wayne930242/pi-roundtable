import type {
	ExtensionFactory,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	bridgeHistoryHidesMemory,
	memoryProjection,
	privateCompaction,
	recordMemoryTurn,
} from "pi-roundtable/kit";
import type { PiTurnContext } from "../src/pi-protocol.ts";

/** Bridge's retained transcript bypasses projection, including exchanges Pi already compacted. */
export function sandboxBridgeRefusal(
	session: {
		model: { provider: string } | undefined;
		sessionManager: Pick<SessionManager, "getBranch">;
	},
	turn: PiTurnContext,
): string | undefined {
	if (session.model?.provider !== "claude-bridge") return undefined;
	if (
		!bridgeHistoryHidesMemory(
			session.sessionManager.getBranch(),
			turn.authorPrincipalId ?? turn.authorId,
		)
	)
		return undefined;
	return "claude-bridge cannot replay another reader's private-memory turns or private exchanges hidden from this sandbox reader; use another provider or a fresh conversation";
}

/** Record the declared privacy of the host's prompt block before any worker provider call. */
export function recordSandboxMemoryTurn(
	manager: Pick<SessionManager, "appendCustomEntry">,
	turn: PiTurnContext,
): () => void {
	return recordMemoryTurn(
		manager,
		turn.authorPrincipalId ?? turn.authorId,
		turn.memoryVisibility !== "shared" && turn.memory.length > 0,
	);
}

/**
 * Adds what the channel keeps about the current speaker to this run's system prompt. The
 * prompt is rebuilt every run, so the session history never piles up stale copies.
 */
export function speakerMemoryExtension(
	turn: () => PiTurnContext,
): ExtensionFactory {
	return (pi) => {
		// Sandbox sessions bypass the core SessionFactory; apply its shared-history projection here.
		pi.on("context_with_system", (event) => {
			const current = turn();
			const messages = memoryProjection(event.messages, {
				shared: true,
				reader: current.authorPrincipalId ?? current.authorId,
			});
			return messages ? { messages } : undefined;
		});
		// Registered before custom compactors, also protecting Pi's built-in fallback.
		pi.on("session_before_compact", (event) =>
			privateCompaction(
				event.preparation,
				event.branchEntries.flatMap((entry) =>
					entry.type === "message" ? [entry.message] : [],
				),
			),
		);
		pi.on("before_agent_start", (event) => {
			const { memory } = turn();
			if (!memory) return;
			const current = event.systemPromptOptions.appendSystemPrompt;
			event.systemPromptOptions.appendSystemPrompt = current
				? `${current}\n\n${memory}`
				: memory;
		});
	};
}
