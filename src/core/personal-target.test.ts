import { afterEach, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundTurn } from "./contract/channels.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import { BACKGROUND_TURNS, SCHEDULES } from "./services.ts";
import type { SessionContext } from "./sessions.ts";
import type { Speaker } from "./speakers.ts";
import { describeDb } from "./testing/database.ts";
import { type TestHost, testHost } from "./testing/test-host.ts";

/** The test host's owner, Ada, speaking at the admin tier, below hers. */
const ADA: Speaker = {
	id: "100000000000000001",
	name: "Ada",
	tier: "admin",
	principalId: "100000000000000001",
};

/** A plugin of a surface of its own, `test:`, whose claim answers background turns there. */
function desk(turns: BackgroundTurn[]): RoundtablePlugin {
	return {
		name: "desk",
		setup: () => ({
			surfaces: [
				{
					surface: "test",
					start: async () => undefined,
					sendReply: async () => undefined,
				},
			],
			channels: [
				{
					name: "desk",
					priority: 0,
					owns: (channel) => channel.startsWith("test:"),
					admit: () => undefined,
					background: async (turn) => {
						turns.push(turn);
						return { status: "ran" };
					},
					startFresh: async () => "desk",
				},
			],
		}),
	};
}

/** The tools the session tool `name` registers in a session, run as the model calls them; none when it gives the session none. */
async function toolsOf(
	host: TestHost,
	name: string,
	session: SessionContext,
): Promise<Map<string, (input: unknown) => Promise<string>>> {
	const tools = new Map<string, (input: unknown) => Promise<string>>();
	const factory: ExtensionFactory | null | undefined = host.context
		.sessions()
		.plan.tools.find((tool) => tool.name === name)
		?.snapshot()
		.factory(session);
	await factory?.({
		registerTool: (tool: {
			name: string;
			execute: (
				id: string,
				input: unknown,
			) => Promise<{ content: { text: string }[] }>;
		}) =>
			tools.set(tool.name, async (input) =>
				(await tool.execute("call", input)).content
					.map((part) => part.text)
					.join(""),
			),
		on: () => undefined,
	} as unknown as ExtensionAPI);
	return tools;
}

let host: TestHost | undefined;
afterEach(async () => {
	await host?.stop();
	host = undefined;
});

describeDb("the personal background target on a host without Discord", () => {
	test("a conversation whose claim takes background turns schedules, and the run is its creator's, at their tier", async () => {
		const turns: BackgroundTurn[] = [];
		host = await testHost({ discord: false, plugins: [desk(turns)] });
		const session = { ...host.sessionContext(), speaker: () => ADA };
		expect(session.homeChannel).toBe("test:owner");
		const tools = await toolsOf(host, "schedules", session);
		expect([...tools.keys()]).toContain("schedule_create");
		expect(
			(await toolsOf(host, "delegate", session)).has("delegate_task"),
		).toBe(true);
		const store = host.context.services.get(SCHEDULES);
		for (const kept of await store.forChannel("test:owner"))
			await store.remove(kept.id);
		const created = await tools.get("schedule_create")?.({
			title: "patrol",
			prompt: "check the disk",
			in_minutes: 600,
		});
		expect(created).toContain("Scheduled #");
		const [schedule] = await store.forChannel("test:owner");
		if (!schedule) throw new Error("no schedule was stored");
		try {
			expect(schedule).toMatchObject({
				target: "owner",
				createdById: ADA.principalId,
				createdTier: "admin",
			});
			const outcome = await host.context.services
				.get(BACKGROUND_TURNS)
				.runScheduled(schedule, new Date());
			expect(outcome).toEqual({ status: "ran" });
			expect(turns.map((turn) => [turn.target, turn.speaker])).toEqual([
				[
					"owner",
					{
						id: ADA.id,
						name: "Ada",
						tier: "admin",
						principalId: ADA.principalId,
					},
				],
			]);
		} finally {
			await store.remove(schedule.id);
		}
	});

	test("the configured per-person limits reach the personal target, and hold each person to that many schedules across their conversations", async () => {
		const turns: BackgroundTurn[] = [];
		host = await testHost({
			discord: false,
			plugins: [desk(turns)],
			config: {
				background: { perPrincipal: { schedules: 1, delegations: 1 } },
			},
		});
		expect(host.context.conversations.target("owner")).toMatchObject({
			schedules: { perChannel: 20, perPrincipal: 1 },
			delegation: { maxRunning: 3, maxRunningPerPrincipal: 1 },
		});
		const store = host.context.services.get(SCHEDULES);
		for (const kept of await store.all()) await store.remove(kept.id);
		const at = (home: string) =>
			({
				...host?.sessionContext(),
				homeChannel: home,
				turnChannel: home,
				speaker: () => ADA,
			}) as SessionContext;
		const create = async (home: string) =>
			(await toolsOf(host as TestHost, "schedules", at(home))).get(
				"schedule_create",
			)?.({ title: "patrol", prompt: "check the disk", in_minutes: 600 });
		try {
			expect(await create("test:a")).toContain("Scheduled #");
			expect(await create("test:b")).toContain(
				"the most one person may have here",
			);
		} finally {
			for (const kept of await store.all()) await store.remove(kept.id);
		}
	});

	test("with no claim that takes background turns, no session has the schedule or delegation tools, as in 0.8", async () => {
		host = await testHost({ discord: false });
		const names = (await host.sessionTools()).flatMap(
			(extension) => extension.tools,
		);
		expect(names.filter((name) => /^schedule_|^delegate_/.test(name))).toEqual(
			[],
		);
	});
});
