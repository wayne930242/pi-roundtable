import type { AgentRuntime, ContextUse } from "../contract/runtime.ts";
import type { ThinkingSetting } from "../domain/models.ts";

export type { ContextUse };

/** The part of the runtime the agent team drives. */
export type AgentTurnRunner = Pick<
	AgentRuntime,
	| "runTurn"
	| "heldActions"
	| "startFresh"
	| "deleteConversation"
	| "contextUsage"
>;

/** The models an agent can run on, and the assistant's own, which unset agents follow. */
export interface AgentModels {
	/** The assistant's thinking is `auto`: the judge picks each turn's level. */
	defaults: { model: string; thinking: ThinkingSetting };
	/** Every model the host can run, as `<provider>/<id>`. */
	usable(): Promise<string[]>;
}
