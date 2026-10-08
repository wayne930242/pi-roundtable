import { AsyncLocalStorage } from "node:async_hooks";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** The ids of the tool calls whose code is running, outermost first. */
const calls = new AsyncLocalStorage<readonly string[]>();

/**
 * The ids of the tool calls the code asking runs within, outermost first: the call of a session
 * part's tool, and the calls it runs within in turn, such as a worker's call inside the call that
 * started the worker. Empty outside every such call.
 */
export function runningCalls(): readonly string[] {
	return calls.getStore() ?? [];
}

/**
 * A session part's extension whose tools each run within their call's id, so what a call starts,
 * a task's worker among them, knows which call it serves rather than every call running at once.
 */
export function scopedCalls(factory: ExtensionFactory): ExtensionFactory {
	return (pi) =>
		factory(
			new Proxy(pi, {
				get(target, key) {
					if (key === "registerTool")
						return (tool: ToolDefinition) =>
							target.registerTool({
								...tool,
								execute: (toolCallId, ...rest) =>
									calls.run([...runningCalls(), toolCallId], () =>
										tool.execute(toolCallId, ...rest),
									),
							});
					const value: unknown = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) satisfies ExtensionAPI,
		);
}
