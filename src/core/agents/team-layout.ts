import { AgentError } from "../domain/errors.ts";
import { messages } from "../i18n/index.ts";
import type { AgentDirectory } from "../services.ts";
import type { CategoryLayout } from "./agent-ports.ts";
import type { AgentGroup } from "./agent-store.ts";

type TeamStore = Pick<
	AgentDirectory,
	"agent" | "group" | "agentByChannel" | "groupByChannel"
>;

/** The two kinds of team category (spec behavior 56). */
export type CategoryKind = "Agents" | "Groups";
const TEAM_CATEGORY = /^(Agents|Groups)(?:-[^\r\n]{1,32})?$/u;

/** A team category's kind, or undefined for any other category. */
export function categoryKind(name: string): CategoryKind | undefined {
	return TEAM_CATEGORY.exec(name)?.[1] as CategoryKind | undefined;
}

/** The category a tool names for a channel of this kind, the plain one when absent. */
export function teamCategory(
	name: string | undefined,
	kind: CategoryKind,
): string {
	if (name === undefined) return kind;
	const found = categoryKind(name);
	if (!found)
		throw new AgentError(
			`"${name}" is not a team category: use ${kind} or ${kind}-<suffix>, the suffix 1 to 32 characters on one line.`,
		);
	if (found !== kind)
		throw new AgentError(
			`"${name}" holds ${found === "Agents" ? "agents" : "groups"}; ${kind === "Agents" ? "an agent" : "a group"} goes under ${kind} or ${kind}-<suffix>.`,
		);
	return name;
}

/** A group channel's topic: who is in it and who hosts. */
export function groupTopic(
	group: AgentGroup,
	store: Pick<AgentDirectory, "agent">,
): string {
	const shown = (name: string) => store.agent(name)?.displayName ?? name;
	return messages().groupTopic(
		group.displayName,
		group.members.map(shown),
		shown(group.host),
	);
}

/** The team categories in server order, each with its channels by agent or group name. */
export function layoutText(
	layout: readonly CategoryLayout[],
	store: TeamStore,
): string {
	const lines = layout.flatMap((c) => {
		if (!categoryKind(c.name)) return [];
		const shown = c.channelIds.map(
			(id) =>
				store.agentByChannel(id)?.name ??
				store.groupByChannel(id)?.name ??
				`<#${id}>`,
		);
		return [`- ${c.name}: ${shown.join(", ") || "empty"}`];
	});
	return `Categories, in server order:\n${lines.join("\n") || "none"}`;
}

/** An arrange request's categories with the channels of the named agents and groups. */
export function resolveArrangement(
	entries: readonly { category: string; names: string[] }[],
	store: TeamStore,
): { category: string; channelIds: string[] }[] {
	if (entries.length === 0) throw new AgentError("List at least one category.");
	const categories = new Set<string>();
	const names = new Set<string>();
	return entries.map(({ category, names: members }) => {
		if (categories.has(category))
			throw new AgentError(`The category "${category}" is listed twice.`);
		categories.add(category);
		if (members.length === 0)
			throw new AgentError(
				`List at least one agent or group under "${category}".`,
			);
		const channelIds = members.map((name) => {
			if (names.has(name)) throw new AgentError(`"${name}" is listed twice.`);
			names.add(name);
			const agent = store.agent(name);
			const target = agent ?? store.group(name);
			if (!target)
				throw new AgentError(
					`There is no agent or group "${name}"; see agent_list.`,
				);
			if (target.status !== "active")
				throw new AgentError(`"${name}" is archived.`);
			teamCategory(category, agent ? "Agents" : "Groups");
			if (!target.channelId) throw new AgentError(`${name} has no channel.`);
			return target.channelId;
		});
		return { category, channelIds };
	});
}

/**
 * The server layout after an arrangement: the listed categories and channels first, everything
 * else after in its current order; and the team categories left empty, to delete.
 */
export function planArrangement(
	listed: readonly { category: string; channelIds: string[] }[],
	current: readonly CategoryLayout[],
): { layout: CategoryLayout[]; remove: string[] } {
	const moved = new Set(listed.flatMap((l) => l.channelIds));
	const stay = (c: CategoryLayout) =>
		c.channelIds.filter((id) => !moved.has(id));
	const ahead: CategoryLayout[] = listed.map(({ category, channelIds }) => {
		const existing = current.find((c) => c.name === category);
		return {
			...(existing?.id ? { id: existing.id } : {}),
			name: category,
			channelIds: [...channelIds, ...(existing ? stay(existing) : [])],
		};
	});
	const rest = current.flatMap((c) =>
		ahead.some((a) => a.id === c.id) ? [] : [{ ...c, channelIds: stay(c) }],
	);
	const layout = [...ahead, ...rest];
	const remove = layout.flatMap((c) =>
		c.id && c.channelIds.length === 0 && categoryKind(c.name) ? [c.id] : [],
	);
	return {
		layout: layout.filter((c) => !c.id || !remove.includes(c.id)),
		remove,
	};
}
