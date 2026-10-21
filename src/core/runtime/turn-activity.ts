import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** What a turn was doing at one moment: tools running and for how long, or compacting, or neither (the model). */
export interface TurnActivity {
	/** The tools running, the longest-running first, each with how long it has run. */
	running: { tool: string; ms: number }[];
	compacting: boolean;
	/** Every tool called so far, by name, with how often, in the order first called. */
	tools: [string, number][];
}

/** Follows a turn's events to say, when asked, what it is doing; never its inputs. */
export interface ActivityTracker {
	observe(event: AgentSessionEvent): void;
	now(at: number): TurnActivity;
}

export function activityTracker(
	clock: () => number = Date.now,
): ActivityTracker {
	const running = new Map<string, { tool: string; since: number }>();
	const tools = new Map<string, number>();
	let compacting = false;
	return {
		observe(event) {
			if (event.type === "tool_execution_start") {
				running.set(event.toolCallId, { tool: event.toolName, since: clock() });
				tools.set(event.toolName, (tools.get(event.toolName) ?? 0) + 1);
			} else if (event.type === "tool_execution_end") {
				running.delete(event.toolCallId);
			} else if (event.type === "compaction_start") compacting = true;
			else if (event.type === "compaction_end") compacting = false;
		},
		now: (at) => ({
			running: [...running.values()]
				.sort((a, b) => a.since - b.since)
				.map(({ tool, since }) => ({ tool, ms: at - since })),
			compacting,
			tools: [...tools],
		}),
	};
}
