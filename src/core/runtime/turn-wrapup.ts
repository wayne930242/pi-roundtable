import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChannelKey } from "../domain/conversation.ts";
import type { TurnRequest } from "../domain/ports.ts";
import type { ConfirmationGate } from "./extensions/confirmation-gate.ts";
import type { PiAgentRuntimeOptions } from "./runtime-types.ts";

/**
 * What a turn leaves behind when it ends, whatever way it ended: the gate stops counting the turn,
 * the conversation's context usage and held actions are recorded, and the turn is logged. A
 * session disposed of under a turn that would not stop has no usage to read.
 */
export async function wrapUpTurn(parts: {
	key: ChannelKey;
	request: TurnRequest;
	session: AgentSession;
	gate: ConfirmationGate;
	toolCalls: readonly string[];
	options: Pick<PiAgentRuntimeOptions, "confirmations" | "logger">;
	recordUsage: (usage: {
		tokens: number | null;
		contextWindow: number;
	}) => void;
}): Promise<void> {
	const { key, request, session, gate, toolCalls, options, recordUsage } =
		parts;
	const { logger } = options;
	gate.endTurn();
	try {
		const usage = session.getContextUsage();
		if (usage)
			recordUsage({
				tokens: usage.tokens,
				contextWindow: usage.contextWindow,
			});
	} catch (error) {
		logger.warn({ channel: key, err: error }, "context usage not read");
	}
	const held = gate.pending();
	await options.confirmations
		.save(key, held)
		// pi-lens-ignore: no-unknown-parameters — a rejection reason is unknown; it only reaches the logger
		.catch((error: unknown) =>
			logger.error({ channel: key, err: error }, "held actions not saved"),
		);
	if (held)
		logger.info(
			{ channel: key, held: held.calls.map((call) => call.action) },
			"actions held for confirmation",
		);
	logger.info(
		{
			channel: key,
			selection: request.selection.id,
			toolCalls,
			thinking: session.thinkingLevel,
			// pi-lens-ignore: no-conditional-empty-object-spread — owner turns keep their log line without a model key
			...(request.agent
				? { model: `${session.model?.provider}/${session.model?.id}` }
				: {}),
		},
		"turn finished",
	);
}
