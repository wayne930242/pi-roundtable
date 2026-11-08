import type { HoldRule } from "pi-roundtable";
import type { McpToolHints, VirtualServer } from "pi-roundtable/kit";
import { CONNECTOR_MESSAGES, type ConnectorMessages } from "./messages.ts";

export interface ToolHintsOptions {
	/** The virtual servers whose hints decide, read at every call. */
	servers: () => readonly VirtualServer[];
	/** The card's wording; English by default. */
	messages?: Pick<ConnectorMessages, "toolHintHold">;
}

/** Why a tool's hints hold it, or undefined when they leave it to run. */
function holdFor(
	hints: McpToolHints | undefined,
): "destructive" | "writes" | undefined {
	if (hints?.destructiveHint === true) return "destructive";
	if (hints?.readOnlyHint === false) return "writes";
	return undefined;
}

/** The call's `kind` and `id` when it has them as text, so an approval card names what it acts on. */
function target(input: Record<string, unknown>): string {
	const parts = (["kind", "id"] as const).flatMap((key) =>
		typeof input[key] === "string" ? [`${key} ${input[key]}`] : [],
	);
	return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * Holds a call to an MCP tool whose server marks it `destructiveHint: true` or `readOnlyHint:
 * false`. A tool with no hint, no hints at all, or that no server lists runs unasked: only a tool
 * that says it changes things waits for the owner. Where several servers list one tool, any that
 * marks it holds it. Yolo mode never approves such a call (`HoldRule.yolo`), and a turn nobody
 * can answer fails it closed like any held call. The hints are the upstream server's claim;
 * trusting them is trusting the connector.
 */
export function toolHintsHoldRule({
	servers,
	messages = CONNECTOR_MESSAGES,
}: ToolHintsOptions): HoldRule {
	return {
		name: "mcp-hints",
		yolo: "never",
		describe: (tool, input) => {
			for (const server of servers()) {
				if (!server.tools.includes(tool)) continue;
				const why = holdFor(server.hints?.[tool]);
				if (why)
					return `${messages.toolHintHold(tool, server.name, why)}${target(input)}`;
			}
			return undefined;
		},
	};
}
