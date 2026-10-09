import type {
	ExtensionFactory,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	hidesPrivateExchange,
	memoryProjection,
	privateCompaction,
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
	const messages = session.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	if (
		!hidesPrivateExchange(messages, {
			shared: true,
			reader: turn.authorPrincipalId ?? turn.authorId,
		})
	)
		return undefined;
	return "claude-bridge cannot replay private exchanges hidden from this sandbox reader; use another provider or a fresh conversation";
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
