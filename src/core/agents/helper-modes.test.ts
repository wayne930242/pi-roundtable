import { describe, expect, test } from "bun:test";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import type { Speaker } from "../identity/speakers.ts";
import type { ConversationModes } from "../modes/conversation-modes.ts";
import { legacyRows, testPlaces } from "../testing/team-places.ts";
import type { Agent, AgentGroup } from "./agent-store.ts";
import { followOrigin, modeOrigins } from "./helper-modes.ts";
import type { TeamContext } from "./team-options.ts";

const owner: Speaker = {
	id: "100",
	name: "Ada",
	tier: "owner",
	principalId: "p-ada",
};
const origin = "app:agent.infra" as ChannelKey;

const agent = (fields: Partial<Agent> & { name: string }): Agent => ({
	displayName: fields.name,
	prompt: "p",
	avatarPrompt: "",
	status: "active",
	...fields,
});

/** A store of agents and groups, found by name, and where they are: a Discord channel each, and a room on `app`. */
function world(agents: Agent[], groups: AgentGroup[] = []) {
	const store = {
		agent: (name: string) => agents.find((a) => a.name === name),
		group: (name: string) => groups.find((g) => g.name === name),
	};
	const places = testPlaces({
		store,
		rows: () => legacyRows(agents, groups),
		rooms: () => ["app"],
	});
	return [store, places] as const;
}

const infra = agent({ name: "infra", displayName: "Infra", channelId: "10" });
const scout = agent({
	name: "infra-1",
	displayName: "Scout",
	channelId: "11",
	parent: "infra",
	origin,
});

describe("followOrigin", () => {
	/** A team context whose modes record what the temp knight's creation asked of them. */
	const context = (modes: boolean) => {
		const calls: string[] = [];
		const fake: Pick<ConversationModes, "follow" | "forget"> = {
			follow: async (channels, from, by) =>
				void calls.push(
					`follow ${channels.join(",")} ${from} ${by.principalId}`,
				),
			forget: async (channel) => void calls.push(`forget ${channel}`),
		};
		const ctx = {
			options: {
				store: world([infra, scout])[0],
				places: world([infra, scout])[1],
				...(modes ? { modes: () => fake } : {}),
			},
			turns: { turnChannel: () => origin },
		} as unknown as TeamContext;
		return { ctx, calls };
	};
	const caller: AgentTurnScope = {
		name: "infra",
		session: origin,
		home: origin,
	};

	test("an owner's turn makes every conversation of the temp knight follow the one that made it", async () => {
		const { ctx, calls } = context(true);
		await followOrigin(ctx, caller, owner, scout);
		expect(calls).toEqual([
			`follow discord:11,app:agent.infra-1 ${origin} p-ada`,
		]);
	});

	test("any other turn's temp knight follows nothing and starts with its own modes off", async () => {
		for (const speaker of [
			{ ...owner, tier: "member" as const },
			{ ...owner, principalId: SYSTEM_PRINCIPAL },
		]) {
			const { ctx, calls } = context(true);
			await followOrigin(ctx, caller, speaker, scout);
			expect(calls).toEqual(["forget discord:11", "forget app:agent.infra-1"]);
		}
	});

	test("a host without modes does nothing", async () => {
		const { ctx, calls } = context(false);
		await followOrigin(ctx, caller, owner, scout);
		expect(calls).toEqual([]);
	});
});

describe("modeOrigins", () => {
	test("a temp knight's conversations follow its origin, named after its parent, on Discord and in rooms", () => {
		const origins = modeOrigins(...world([infra, scout]));
		for (const channel of ["discord:11", "app:agent.infra-1"] as ChannelKey[])
			expect(origins.originOf(channel, origin)).toEqual({
				name: "Infra",
				alive: true,
			});
	});

	test("the origin is gone once its agent or group is archived; a deleted parent counts as gone too", () => {
		const archived = { ...infra, status: "archived" as const };
		expect(
			modeOrigins(...world([archived, scout])).originOf(
				"discord:11" as ChannelKey,
				origin,
			),
		).toEqual({ name: "Infra", alive: false });
		const crew = "app:group.crew" as ChannelKey;
		const fromCrew = { ...scout, origin: crew };
		const group: AgentGroup = {
			name: "crew",
			displayName: "Crew",
			members: ["infra"],
			host: "infra",
			status: "archived",
		};
		expect(
			modeOrigins(...world([infra, fromCrew], [group])).originOf(
				"discord:11" as ChannelKey,
				crew,
			),
		).toEqual({ name: "Infra", alive: false });
		const thread = "discord:99" as ChannelKey;
		expect(
			modeOrigins(...world([{ ...scout, origin: thread }])).originOf(
				"discord:11" as ChannelKey,
				thread,
			),
		).toEqual({ name: "infra", alive: false });
	});

	test("a conversation that is no temp knight's, or one made from another origin, follows nothing", () => {
		const origins = modeOrigins(...world([infra, scout]));
		expect(
			origins.originOf("app:agent.infra" as ChannelKey, origin),
		).toBeUndefined();
		expect(
			origins.originOf("discord:11" as ChannelKey, "discord:10" as ChannelKey),
		).toBeUndefined();
		expect(
			origins.originOf("app:agent.gone-1" as ChannelKey, origin),
		).toBeUndefined();
	});
});
