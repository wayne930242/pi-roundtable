import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CREATION_TOOL_ARGUMENTS } from "../contract/places.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import { type AgentOps, agentToolsExtension } from "./agent-tools.ts";

/** The property names each tool of the agent tools declares, with the skills addon on. */
function declared(): Map<string, string[]> {
	const names = new Map<string, string[]>();
	const pi = {
		registerTool: (tool: {
			name: string;
			parameters: { properties: Record<string, unknown> };
		}) => names.set(tool.name, Object.keys(tool.parameters.properties)),
	} as unknown as ExtensionAPI;
	agentToolsExtension({} as AgentOps, { name: "scout" } as never, TEST_OWNER, {
		skills: true,
	})(pi);
	return names;
}

test("CREATION_TOOL_ARGUMENTS names every argument agent_create and group_create take of their own", () => {
	const tools = declared();
	expect([...(tools.get("agent_create") ?? [])].sort()).toEqual(
		[...CREATION_TOOL_ARGUMENTS.agent].sort(),
	);
	expect([...(tools.get("group_create") ?? [])].sort()).toEqual(
		[...CREATION_TOOL_ARGUMENTS.group].sort(),
	);
});
