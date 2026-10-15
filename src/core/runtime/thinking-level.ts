import type {
	AgentSession,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ChannelKey } from "../domain/conversation.ts";
import type { TurnRequest } from "../domain/ports.ts";
import {
	AUTO_THINKING,
	type EffortPolicy,
	type ThinkingLevel,
} from "../models.ts";
import {
	type AgentModelSettings,
	useChosenAgentModel,
} from "./bridge-guard.ts";
import type { PiAgentRuntimeOptions } from "./runtime-types.ts";
import { lastReply } from "./turn-answer.ts";

function checkRequiredMass(mass: readonly number[]): void {
	if (
		!Array.isArray(mass) ||
		mass.length !== 4 ||
		!mass.every(
			(n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
		)
	) {
		throw new Error(
			`effortPolicy requiredMass must be four finite numbers in [0, 1], got ${JSON.stringify(mass)}`,
		);
	}
}

/** Uses the checked model snapshot; auto thinking keeps the last pick while the judge is unsure. */
export async function thinkingLevel(
	parts: {
		modelRuntime: ModelRuntime;
		effort: PiAgentRuntimeOptions["effort"];
		/** The level last judged for each conversation. */
		judged: Map<ChannelKey, ThinkingLevel>;
		/** The host's rule for a turn that thinks at the judge's choice. */
		policy?: EffortPolicy | undefined;
	},
	key: ChannelKey,
	session: AgentSession,
	request: TurnRequest,
	agentModel?: AgentModelSettings,
): Promise<ThinkingLevel> {
	const { modelRuntime, effort, judged } = parts;
	const setting = request.agent
		? await useChosenAgentModel(
				session,
				modelRuntime,
				request.agent.name,
				agentModel,
			)
		: AUTO_THINKING;
	if (setting !== AUTO_THINKING) {
		judged.delete(key);
		return setting;
	}
	const kind = request.kind ?? (request.agent ? "agent" : undefined);
	const rule = parts.policy?.({
		channel: request.channel,
		...(kind !== undefined ? { kind } : {}),
		...(request.agent ? { agent: request.agent.name } : {}),
		...(request.origin !== undefined ? { origin: request.origin } : {}),
	});
	if (rule && "requiredMass" in rule) checkRequiredMass(rule.requiredMass);
	if (rule && "fixed" in rule) {
		judged.delete(key);
		return rule.fixed;
	}
	const level = await effort.judge(
		request.text,
		{ reply: lastReply(session.messages), level: judged.get(key) },
		rule,
	);
	judged.set(key, level);
	return level;
}
