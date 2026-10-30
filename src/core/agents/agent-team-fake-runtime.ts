import type { ContextUse } from "../contract/runtime.ts";
import type {
	ChannelKey,
	PendingConfirmation,
	TurnResult,
} from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import type { TurnRequest } from "../domain/ports.ts";
import type { AgentTurnRunner } from "./agent-ports.ts";

/** Answers every turn with a scripted reply; records what each turn received. */
export class FakeRuntime implements AgentTurnRunner {
	turns: TurnRequest[] = [];
	reply: (request: TurnRequest) => string = (r) => `${r.agent?.name} ok`;
	held = new Map<ChannelKey, PendingConfirmation>();
	fresh: ChannelKey[] = [];
	/** Runs inside a turn, like a tool call the model makes. */
	during?: (request: TurnRequest) => unknown;
	/** The next turn ends as if the owner pressed stop. */
	stopNext = false;
	async runTurn(request: TurnRequest): Promise<TurnResult> {
		this.turns.push(request);
		await this.during?.(request);
		if (this.stopNext) {
			this.stopNext = false;
			return {
				ok: false,
				error: new AgentRunError("stopped by the owner"),
				stopped: true,
			};
		}
		return { ok: true, text: this.reply(request) };
	}
	async heldActions(session: ChannelKey) {
		return this.held.get(session);
	}
	async startFresh(session: ChannelKey) {
		this.fresh.push(session);
	}
	deleted: ChannelKey[] = [];
	async deleteConversation(session: ChannelKey) {
		this.deleted.push(session);
	}
	usage = new Map<ChannelKey, ContextUse>();
	contextUsage(session: ChannelKey) {
		return this.usage.get(session);
	}
}
