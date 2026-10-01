import type { AgentRuntime, ChannelKey, TurnRequest } from "pi-roundtable";

/** An `AgentRuntime` that answers `pong`, remembers what it was asked, and holds no actions. */
export interface RecordingRuntime extends AgentRuntime {
	turns: TurnRequest[];
	fresh: ChannelKey[];
	deleted: ChannelKey[];
	stopped: ChannelKey[];
}

export function recordingRuntime(): RecordingRuntime {
	const runtime: RecordingRuntime = {
		turns: [],
		fresh: [],
		deleted: [],
		stopped: [],
		runTurn: async (request) => {
			runtime.turns.push(request);
			return { ok: true, text: "pong" };
		},
		steer: async () => false,
		stop: (channel) => {
			runtime.stopped.push(channel);
			return true;
		},
		startFresh: async (channel) => {
			runtime.fresh.push(channel);
		},
		deleteConversation: async (channel) => {
			runtime.deleted.push(channel);
		},
		pendingConfirmation: () => undefined,
		heldActions: async () => undefined,
		recentTranscript: async () => [],
	};
	return runtime;
}
