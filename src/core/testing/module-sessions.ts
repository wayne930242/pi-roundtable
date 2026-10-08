import type {
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { ConversationRecord } from "../conversations/conversation-registry.ts";
import type {
	AgentTurnScope,
	ChannelKey,
	SessionContext,
} from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import { OWNER_CHANNEL, type setUpModules } from "./modules.ts";
import { OWNER_SPEAKER } from "./owner.ts";

/** Sessions, people, and tool calls the modules' tests share. */
export const HOME: ChannelKey = "discord:scout";
export const GROUP: ChannelKey = "discord:war-room";
export const OUTSIDE: ChannelKey = "other:table-1";

export const scout: AgentTurnScope = {
	name: "scout",
	session: HOME,
	home: HOME,
};
export const seat: AgentTurnScope = {
	name: "scout",
	session: GROUP,
	home: HOME,
	group: "war-room",
};

export function context(
	agent?: AgentTurnScope,
	home?: ChannelKey,
): SessionContext {
	const session: SessionContext = {
		kind: agent ? "agent" : "owner",
		homeChannel: home ?? agent?.home ?? OWNER_CHANNEL,
		turnChannel: agent?.session ?? home ?? OWNER_CHANNEL,
		compaction: { wrap: (compactor) => compactor },
		// A turn of the owner's runs, as every tool call is part of one.
		speaker: () => OWNER_SPEAKER,
		runTask: async () => "report",
	};
	if (agent) session.agent = agent;
	return session;
}

/** A session of a conversation of the owner's kind whose turns are someone else's. */
export function contextOf(speaker: Speaker, home: ChannelKey): SessionContext {
	return { ...context(undefined, home), speaker: () => speaker };
}

/** An admin who is not the primary owner, such as one a remote MCP token is bound to. */
export const ANN: Speaker = {
	id: "p_ann",
	name: "Ann",
	tier: "admin",
	principalId: "p_ann",
};

export interface Registered {
	name: string;
	parameters: { properties: Record<string, unknown> };
	execute(
		id: string,
		params: unknown,
	): Promise<{ content: { text: string }[]; isError?: boolean }>;
}

/** The extension one of the modules' session tools gives a session; null when it gives none. */
export function factoryOf(
	setup: Awaited<ReturnType<typeof setUpModules>>,
	name: string,
	session: SessionContext,
): ExtensionFactory | null | undefined {
	return setup.contribution.sessionTools
		?.find((tool) => tool.name === name)
		?.snapshot()
		.factory(session);
}

/** The tools one of the modules' extensions registers in a session. */
export async function registered(
	setup: Awaited<ReturnType<typeof setUpModules>>,
	session: SessionContext,
	extension: string,
): Promise<Registered[]> {
	const tool = setup.contribution.sessionTools?.find(
		(candidate) => candidate.name === extension,
	);
	const factory: ExtensionFactory | null | undefined = tool
		?.snapshot()
		.factory(session);
	if (!factory) throw new Error(`no ${extension} extension`);
	const tools: Registered[] = [];
	await factory({
		registerTool: (definition: Registered) => tools.push(definition),
		on: () => undefined,
	} as unknown as ExtensionAPI);
	return tools;
}

/** A conversation the host recorded as one person's own. */
export const privately =
	(owners: Readonly<Record<string, string>>) => async (key: ChannelKey) =>
		owners[key]
			? ({
					key,
					visibility: "private",
					principalId: owners[key],
				} as unknown as ConversationRecord)
			: undefined;

/** Runs notify in a session; the tool's answer and whether it was an error. */
export async function notifyIn(
	setup: Awaited<ReturnType<typeof setUpModules>>,
	session: SessionContext,
	text = "the build is green",
) {
	const [notify] = await registered(setup, session, "notify");
	if (!notify) return undefined;
	const answer = await notify.execute("1", { text });
	return {
		text: answer.content[0]?.text ?? "",
		error: answer.isError === true,
	};
}
