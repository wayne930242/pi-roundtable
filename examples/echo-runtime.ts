import {
	AgentRunError,
	type AgentRuntime,
	type ChannelKey,
	definePlugin,
	type PendingConfirmation,
	type RuntimeDeps,
	type RuntimeFactory,
	type TranscriptEntry,
	type TurnRequest,
	type TurnResult,
} from "pi-roundtable";

/**
 * A runtime runs the conversations of the agent server and of every claim that calls
 * `context.turns.run`: one conversation per channel key, its history, and its held actions.
 * This one answers with the text it was given, and keeps each conversation's transcript in memory.
 */
export class EchoRuntime implements AgentRuntime {
	readonly #deps: RuntimeDeps;
	readonly #transcripts = new Map<ChannelKey, TranscriptEntry[]>();

	constructor(deps: RuntimeDeps) {
		this.#deps = deps;
	}

	async runTurn(request: TurnRequest): Promise<TurnResult> {
		// An agent's turn carries the agent's scope, and its conversation is the scope's session.
		const conversation = request.agent?.session ?? request.channel;
		const prompt = this.#promptOf(request);
		if (prompt === undefined)
			return {
				ok: false,
				error: new AgentRunError(
					`no persona for the conversation kind "${request.kind}": a plugin adds one with \`personas\``,
				),
			};
		const text = `[${prompt}] ${request.text}`;
		const transcript = this.#transcripts.get(conversation) ?? [];
		transcript.push(
			{ role: "user", text: request.text },
			{ role: "assistant", text },
		);
		this.#transcripts.set(conversation, transcript);
		return { ok: true, text };
	}

	/** What a model would get as its system prompt: the agent's name, or the persona of the kind. */
	#promptOf(request: TurnRequest): string | undefined {
		if (request.agent) return `agent ${request.agent.name}`;
		// Only the turn's kind picks the persona; "owner" is the kind of a turn that names none.
		const kind = request.kind ?? "owner";
		return kind === "owner"
			? (this.#deps.sessions().persona("owner") ?? "owner")
			: this.#deps.sessions().persona(kind);
	}

	/** Nothing runs long enough to take a steering message, so each waits for its own turn. */
	async steer(): Promise<boolean> {
		return false;
	}

	/** No turn outlives its `runTurn`, so there is never one to stop. */
	stop(): boolean {
		return false;
	}

	async startFresh(conversation: ChannelKey): Promise<void> {
		this.#transcripts.delete(conversation);
	}

	async deleteConversation(conversation: ChannelKey): Promise<void> {
		this.#transcripts.delete(conversation);
	}

	/** This runtime holds no actions for approval; a real one keeps them in `deps.confirmations`. */
	pendingConfirmation(): PendingConfirmation | undefined {
		return undefined;
	}

	async heldActions(): Promise<PendingConfirmation | undefined> {
		return undefined;
	}

	async recentTranscript(
		conversation: ChannelKey,
		limit: number,
	): Promise<TranscriptEntry[]> {
		return (this.#transcripts.get(conversation) ?? []).slice(-limit);
	}
}

/** The factory the agent server calls once, with what a runtime needs from the host. */
export const createEchoRuntime: RuntimeFactory = (deps) => {
	deps.logger.info("the echo runtime replaces Pi");
	return new EchoRuntime(deps);
};

/**
 * A plugin fills the `runtime` slot to replace the whole conversation runtime; without one the
 * runtime plugin builds the Pi runtime. One plugin may fill it.
 */
export const echoRuntime = definePlugin({
	name: "echo-runtime",
	providers: { runtime: createEchoRuntime },
	setup: () => ({}),
});
