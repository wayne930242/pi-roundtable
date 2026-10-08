import type {
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { OwnerIdentity } from "../identity.ts";
import type {
	AgentTurnScope,
	ChannelKey,
	SessionContext,
} from "../sessions.ts";
import { type Speaker, THE_SPEAKER } from "../speakers.ts";
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
		// Shared, as the host makes a session it has no record of; `privateTo` makes it someone's.
		conversation: { visibility: "shared" },
		addressee: THE_SPEAKER,
		memory: "speaker",
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

/** The session of a conversation private to `principalId`, its tools addressing them as given. */
export function privateTo(
	session: SessionContext,
	principalId: string,
	addressee: OwnerIdentity = THE_SPEAKER,
): SessionContext {
	return {
		...session,
		conversation: { visibility: "private", principalId },
		addressee,
	};
}

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
