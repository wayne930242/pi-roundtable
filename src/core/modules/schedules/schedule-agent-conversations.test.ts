import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChannelKey } from "../../domain/conversation.ts";
import type { ScheduleStore } from "../../services.ts";
import type { Speaker } from "../../speakers.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { setTimeZone } from "../../time.ts";
import type { NewSchedule, Schedule } from "./schedule-store.ts";
import { schedulesExtension } from "./schedules.ts";

beforeAll(() => setTimeZone("UTC"));
afterAll(useTestLocale);

const DISCORD: ChannelKey = "discord:2000";
const WEB: ChannelKey = "app:agent.infra";
const OTHER: ChannelKey = "app:agent.coder";
const KAI: Speaker = {
	id: "u_kai",
	name: "Kai",
	tier: "admin",
	principalId: "p_kai",
};

/** The schedules in memory, with the store methods the tools ask for. */
function memoryStore() {
	const made: Schedule[] = [];
	const store = {
		create: async (schedule: NewSchedule) => {
			// SAFETY: the tools read back only what they stored and the id.
			const created = {
				...schedule,
				id: made.length + 1,
				createdAt: new Date(0),
			} as Schedule;
			made.push(created);
			return created;
		},
		get: async (id: number) => made.find((s) => s.id === id),
		forChannel: async (channel: ChannelKey) =>
			made.filter((s) => s.channel === channel),
		update: async (
			channel: ChannelKey,
			id: number,
			change: Partial<Schedule>,
		) => {
			const found = made.find((s) => s.id === id && s.channel === channel);
			if (found) Object.assign(found, change);
			return found;
		},
		remove: async (id: number, channel?: ChannelKey) => {
			const at = made.findIndex(
				(s) => s.id === id && (!channel || s.channel === channel),
			);
			return at < 0 ? undefined : made.splice(at, 1)[0];
		},
	};
	return { made, store: store as unknown as ScheduleStore };
}

async function toolsOf(
	factory: (pi: ExtensionAPI) => void | Promise<void>,
): Promise<Map<string, (input: unknown) => Promise<string>>> {
	const tools = new Map<string, (input: unknown) => Promise<string>>();
	await factory({
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
	} as unknown as ExtensionAPI);
	return tools;
}

const CREATE = { title: "patrol", prompt: "check the disk", time: "09:00" };

/** infra's schedule tools in the conversation `at`, with the agent's conversations given. */
const infraTools = (
	store: ScheduleStore,
	at: ChannelKey,
	conversations: readonly ChannelKey[] | null = [DISCORD, WEB],
) =>
	toolsOf(
		schedulesExtension(
			{ store, channelFor: async (channel) => channel },
			at,
			(agent) => {
				if (agent !== "coder") throw new Error(`no agent ${agent}`);
				return OTHER;
			},
			() => KAI,
			conversations ? () => conversations : undefined,
		),
	);

describe("an agent's schedules span its conversations", () => {
	test("schedule_list from Discord shows one made in the web conversation, and where each fires", async () => {
		const { store, made } = memoryStore();
		const web = await infraTools(store, WEB);
		await web.get("schedule_create")?.({ ...CREATE, title: "from web" });
		const discord = await infraTools(store, DISCORD);
		await discord.get("schedule_create")?.({
			...CREATE,
			title: "from discord",
		});
		expect(made.map((s) => s.channel)).toEqual([WEB, DISCORD]);
		const listed = (await discord.get("schedule_list")?.({})) ?? "";
		expect(listed).toContain(`#1 from web`);
		expect(listed).toContain(`fires in ${WEB}`);
		expect(listed).toContain(`#2 from discord`);
		expect(listed).toContain(`fires in ${DISCORD}`);
		// One schedule is read in full by its id from the other conversation.
		expect(await discord.get("schedule_list")?.({ id: 1 })).toContain(
			"check the disk",
		);
	});

	test("schedule_update and schedule_cancel reach a schedule made in the agent's other conversation", async () => {
		const { store, made } = memoryStore();
		const web = await infraTools(store, WEB);
		await web.get("schedule_create")?.(CREATE);
		const discord = await infraTools(store, DISCORD);
		const updated = await discord.get("schedule_update")?.({
			id: 1,
			prompt: "check the disk and the memory",
		});
		expect(updated).toContain('Updated #1 "patrol"');
		expect(made[0]?.prompt).toBe("check the disk and the memory");
		expect(made[0]?.channel).toBe(WEB);
		expect(await discord.get("schedule_cancel")?.({ id: 1 })).toContain(
			"Cancelled #1",
		);
		expect(made).toEqual([]);
	});

	test("another agent's schedules stay out of reach, read-only by name and never changed", async () => {
		const { store, made } = memoryStore();
		const coder = await toolsOf(
			schedulesExtension(
				{ store, channelFor: async (channel) => channel },
				OTHER,
				undefined,
				() => KAI,
				() => [OTHER],
			),
		);
		await coder.get("schedule_create")?.({ ...CREATE, title: "coder's" });
		const infra = await infraTools(store, DISCORD);
		expect(await infra.get("schedule_list")?.({})).not.toContain("coder's");
		expect(await infra.get("schedule_list")?.({ agent: "coder" })).toContain(
			"coder's",
		);
		expect(
			await infra.get("schedule_update")?.({ id: 1, title: "x" }),
		).toContain("no schedule #1");
		expect(await infra.get("schedule_cancel")?.({ id: 1 })).toContain(
			"no schedule #1",
		);
		// The undocumented `agent` argument is read by schedule_list alone (RV0262-F003).
		expect(
			await infra.get("schedule_cancel")?.({ id: 1, agent: "coder" }),
		).toContain("no schedule #1");
		expect(
			await infra.get("schedule_update")?.({
				id: 1,
				title: "x",
				agent: "coder",
			}),
		).toContain("no schedule #1");
		expect(made.map((s) => s.title)).toEqual(["coder's"]);
	});

	test("without the agent's conversations the tools keep to the current channel", async () => {
		const { store } = memoryStore();
		const web = await infraTools(store, WEB, null);
		await web.get("schedule_create")?.(CREATE);
		const discord = await infraTools(store, DISCORD, null);
		expect(await discord.get("schedule_list")?.({})).toContain(
			"This channel has no schedules.",
		);
		expect(await discord.get("schedule_cancel")?.({ id: 1 })).toContain(
			"no schedule #1",
		);
	});
});
