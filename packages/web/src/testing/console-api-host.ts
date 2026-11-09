import type { AgentTeam } from "pi-roundtable";
import { partial, recordingLogger } from "pi-roundtable/testing";
import { ConsoleApi, type ConsolePorts } from "../console-api.ts";
import { DEFAULT_RELAY_NOTE } from "../options.ts";
import type { Visitor } from "../visitors.ts";
import {
	AGENT_CHANNEL,
	type FakePrincipal,
	fakeIdentity,
	fakeMemory,
	fixtureSessions,
	GROUP_CHANNEL,
	HIDDEN_CHANNEL,
	OWNER_CHANNEL,
} from "./fixtures.ts";

export const OWNER: FakePrincipal = {
	id: "owner",
	name: "Owner",
	tier: "owner",
};
export const SECOND: FakePrincipal = {
	id: "p_01J0000000000000000000BEA0",
	name: "Bea",
	tier: "owner",
};
export const MEMBER: FakePrincipal = {
	id: "oidc:aXNz:ada",
	name: "Ada",
	tier: "member",
};
export const RETIRED: FakePrincipal = {
	id: "p_01J0000000000000000000GON0",
	name: "Gus",
	disabled: true,
};
export const visitorOf = (person: FakePrincipal): Visitor => ({
	principal: { id: person.id, displayName: person.name, disabled: false },
	tier: "owner",
	speakerId: person.id,
	roles: [],
});
export const AS_OWNER = visitorOf(OWNER);

export const team = partial<AgentTeam>({
	discordGuild: "900000000000000099",
	owns: (key) =>
		key === `discord:${AGENT_CHANNEL}`
			? "agent"
			: key === `discord:${GROUP_CHANNEL}`
				? "group"
				: undefined,
	status: async () => ({
		agents: [
			{
				name: "scout",
				displayName: "Scout",
				places: [{ surface: "discord", key: `discord:${AGENT_CHANNEL}` }],
				model: "provider/model",
				thinking: "auto" as never,
				workingIn: OWNER_CHANNEL,
				waiting: 1,
				context: { tokens: 1200, contextWindow: 200_000 },
				lastActive: new Date("2026-09-03T10:00:00.000Z"),
				schedules: 2,
			},
		],
		groups: [
			{
				name: "crew",
				displayName: "Crew",
				places: [{ surface: "discord", key: `discord:${GROUP_CHANNEL}` }],
				members: ["Scout"],
				host: "Scout",
				busy: 0,
			},
		],
	}),
});

export function api(change: Partial<ConsolePorts> = {}) {
	const changes: number[] = [];
	const recorder = recordingLogger();
	const memories = new Map([
		[
			OWNER.id,
			fakeMemory([
				{ kind: "core", fact: "Likes tea", eventDate: null },
				{ kind: "event", fact: "Trip", eventDate: "2026-12-01" },
			]),
		],
		[
			SECOND.id,
			fakeMemory([{ kind: "core", fact: "Likes coffee", eventDate: null }]),
		],
	]);
	const memoryOf = (id: string) => {
		const memory = memories.get(id) ?? fakeMemory();
		memories.set(id, memory);
		return memory;
	};
	const instance = new ConsoleApi({
		title: "Test console",
		timeZone: "Europe/Paris",
		panes: ["overview", "conversations", "notes"],
		sessionsDir: `${fixtureSessions()}/sessions`,
		team,
		queue: { size: (key) => (key === `discord:${OWNER_CHANNEL}` ? 2 : 0) },
		channelName: async (id) =>
			id === OWNER_CHANNEL
				? {
						kind: "guild",
						name: "general",
						guild: "Home",
						guildId: "900000000000000099",
					}
				: undefined,
		memoryOf,
		people: fakeIdentity([OWNER, SECOND, MEMBER, RETIRED]),
		exclude: (key) => key === `discord:${HIDDEN_CHANNEL}`,
		relayNotes: [DEFAULT_RELAY_NOTE],
		changed: () => changes.push(Date.now()),
		logger: recorder.logger,
		...change,
	});
	return { api: instance, changes, logger: recorder };
}

export const call = async <T>(
	instance: ConsoleApi,
	path: string,
	init: RequestInit = {},
	visitor: Visitor = AS_OWNER,
): Promise<{ status: number; body: T }> => {
	const response = await instance.handle(
		new Request(`http://console/console/api/${path}`, init),
		path.split("?")[0] ?? "",
		visitor,
	);
	return { status: response.status, body: (await response.json()) as T };
};

export const send = (method: string, body: unknown): RequestInit => ({
	method,
	body: JSON.stringify(body),
	headers: { "content-type": "application/json" },
});
