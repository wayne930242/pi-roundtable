import { ASK_USER_TOOL } from "../runtime/extensions/ask-user.ts";
import { COMPACT_TOOL } from "../runtime/extensions/self-compact-guard.ts";
import { AGENTS } from "../services.ts";
import type { AgentTurnScope } from "../sessions.ts";
import type { TestHost } from "./test-host.ts";

export const scout: AgentTurnScope = {
	name: "scout",
	session: "discord:scout",
	home: "discord:scout",
};
export const seat: AgentTurnScope = {
	name: "scout",
	session: "discord:war-room",
	home: "discord:scout",
	group: "war-room",
};

/** Tools the core's own extensions and pi-web-access register, which no fake session here loads. */
const NAMED_ELSEWHERE = [
	ASK_USER_TOOL,
	COMPACT_TOOL,
	"read_attachment",
	"web_search",
	"fetch_content",
	"get_search_content",
];

export interface ToolSet {
	sessions: Record<string, { tools: string[]; selection?: string[] }>;
	tiers: Record<string, string>;
}

/** The tools each kind of session registers or selects under the host's plugins, and the tier each needs. */
export async function captureToolSet(host: TestHost): Promise<ToolSet> {
	const out: ToolSet = { sessions: {}, tiers: {} };
	const names = new Set<string>(NAMED_ELSEWHERE);
	const seatSelection = (scope: AgentTurnScope | undefined) => {
		if (!scope) return undefined;
		// SAFETY: the concrete team reads its selection, which no port publishes.
		const team = host.context.services.get(AGENTS).team as unknown as {
			selection(scope: AgentTurnScope): { tools: string[] };
		};
		return [...team.selection(scope).tools].sort();
	};
	for (const [label, scope] of [
		["owner", undefined],
		["agent", scout],
		["group seat", seat],
	] as const) {
		const tools = (await host.sessionTools(scope)).flatMap(
			(extension) => extension.tools,
		);
		const selection = seatSelection(scope);
		out.sessions[label] = {
			tools: [...tools].sort(),
			...(selection ? { selection } : {}),
		};
		for (const name of [...tools, ...(selection ?? [])]) names.add(name);
	}
	for (const name of [...names].sort())
		out.tiers[name] = host.context.toolTiers.minTier(name);
	return out;
}
