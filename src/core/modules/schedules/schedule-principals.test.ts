import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BackgroundTarget } from "../../contract/channels.ts";
import type { ChannelKey } from "../../domain/conversation.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { setTimeZone } from "../../time.ts";
import type { NewSchedule, Schedule } from "./schedule-store.ts";
import {
	callScheduleTool,
	type ScheduleToolContext,
} from "./schedule-tools.ts";

beforeAll(() => setTimeZone("UTC"));
afterAll(useTestLocale);

/** A target that holds each person to two schedules across every conversation of theirs. */
const PERSONAL: BackgroundTarget = {
	name: "personal",
	label: () => "Personal",
	schedules: {
		perChannel: 5,
		perPrincipal: 2,
		promptChars: 2_000,
		aheadDays: 90,
	},
};
const SHARED: BackgroundTarget = {
	name: "shared",
	label: () => "Shared",
	schedules: { perChannel: 5, promptChars: 2_000, aheadDays: 90 },
};

const ADA = { principalId: "p_ada", id: "u_ada", name: "Ada", tier: "admin" };
const KAI = { principalId: "p_kai", id: "u_kai", name: "Kai", tier: "member" };
const OWNER = { principalId: "p_own", id: "u_own", name: "Own", tier: "owner" };

const CREATE = {
	title: "patrol",
	prompt: "check the disk",
	time: "09:00",
	every_days: 1,
};

/** The schedules a host keeps, in memory, with every method the tools may ask for. */
function memoryStore(seed: Partial<Schedule>[] = []) {
	const made: Schedule[] = seed.map(
		(given, index) =>
			({
				id: index + 1,
				title: "kept",
				prompt: "p",
				recurrence: { kind: "every", time: "09:00", everyDays: 1 },
				nextRun: new Date("2026-10-09T09:00:00Z"),
				createdByName: "Someone",
				createdTier: "owner",
				createdAt: new Date(0),
				...given,
			}) as Schedule,
	);
	const create = async (schedule: NewSchedule) => {
		// SAFETY: the tools read back only what they stored and the id.
		const created = { ...schedule, id: made.length + 1 } as Schedule;
		made.push(created);
		return created;
	};
	const store: ScheduleToolContext["store"] = {
		create,
		createWithin: async (schedule, { creators, max }) => {
			const reached = made.filter(
				(s) => s.target === schedule.target && creators.includes(s.createdById),
			).length;
			return reached >= max ? { reached } : { created: await create(schedule) };
		},
		get: async (id) => made.find((schedule) => schedule.id === id),
		forChannel: async (channel) =>
			made.filter((schedule) => schedule.channel === channel),
		all: async () => [...made],
		update: async (channel, id, change) => {
			const found = made.find((s) => s.id === id && s.channel === channel);
			// SAFETY: the change's fields are a schedule's, with null as absent.
			if (found) Object.assign(found, change);
			return found;
		},
		remove: async (id, channel) => {
			const at = made.findIndex(
				(s) => s.id === id && (!channel || s.channel === channel),
			);
			return at < 0 ? undefined : made.splice(at, 1)[0];
		},
	};
	return { made, store };
}

function ctx(
	store: ScheduleToolContext["store"],
	channel: ChannelKey,
	author: typeof ADA,
	over: Partial<ScheduleToolContext> = {},
): ScheduleToolContext {
	return {
		store,
		channel,
		target: PERSONAL,
		// SAFETY: the authors above write their tier as a Tier.
		author: author as ScheduleToolContext["author"],
		now: new Date("2026-10-08T12:00:00Z"),
		...over,
	};
}

describe("a person's schedules across their conversations", () => {
	test("a target's perPrincipal limit counts a person's schedules in every conversation, and no one else's", async () => {
		const { store, made } = memoryStore();
		await callScheduleTool(ctx(store, "web:a", ADA), "schedule_create", CREATE);
		await callScheduleTool(ctx(store, "web:b", ADA), "schedule_create", CREATE);
		await expect(
			callScheduleTool(ctx(store, "web:c", ADA), "schedule_create", CREATE),
		).rejects.toThrow(
			"you already have 2 schedules, the most one person may have here; cancel one first",
		);
		await callScheduleTool(ctx(store, "web:c", KAI), "schedule_create", CREATE);
		expect(made.map((s) => [s.channel, s.createdById])).toEqual([
			["web:a", "p_ada"],
			["web:b", "p_ada"],
			["web:c", "p_kai"],
		]);
	});

	test("the count is the target's own, and a creator id that stands for the person counts as theirs", async () => {
		const { store } = memoryStore([
			// 0.8's remote-mcp wrote its own id, which stands for the primary owner.
			{ channel: "discord:dm", target: "personal", createdById: "remote-mcp" },
			// Another target's schedule is not counted against this one.
			{ channel: "discord:dm", target: "shared", createdById: "p_own" },
		]);
		const principalOf = async (id: string) =>
			id === "remote-mcp" ? "p_own" : undefined;
		await callScheduleTool(
			ctx(store, "discord:dm", OWNER, { principalOf }),
			"schedule_create",
			CREATE,
		);
		await expect(
			callScheduleTool(
				ctx(store, "discord:dm", OWNER, { principalOf }),
				"schedule_create",
				CREATE,
			),
		).rejects.toThrow("you already have 2 schedules");
	});

	test("a target without perPrincipal counts only the conversation's, as before", async () => {
		const { store } = memoryStore();
		for (const channel of ["web:a", "web:b", "web:c"] as const)
			await callScheduleTool(
				ctx(store, channel, ADA, { target: SHARED }),
				"schedule_create",
				CREATE,
			);
	});
});

describe("whose schedules a conversation lists", () => {
	const seeded = () =>
		memoryStore([
			{ channel: "discord:dm", target: "personal", createdById: "p_own" },
			{ channel: "discord:dm", target: "personal", createdById: "remote-mcp" },
			{
				channel: "discord:dm",
				target: "personal",
				createdById: "p_kai",
				createdTier: "member",
				title: "kai's",
			},
		]);
	const principalOf = async (id: string) =>
		id === "remote-mcp" ? "p_own" : undefined;

	test("in a private conversation a person lists, reads, changes, and cancels only their own", async () => {
		const { store, made } = seeded();
		const kai = ctx(store, "discord:dm", KAI, {
			principalOf,
			visibility: "private",
		});
		const listed = await callScheduleTool(kai, "schedule_list", {});
		expect(listed).toContain("#3 kai's");
		expect(listed).not.toContain("#1 ");
		expect(listed).not.toContain("#2 ");
		for (const [name, input] of [
			["schedule_list", { id: 1 }],
			["schedule_update", { id: 1, prompt: "x" }],
			["schedule_cancel", { id: 1 }],
		] as const)
			await expect(callScheduleTool(kai, name, input)).rejects.toThrow(
				"this channel has no schedule #1",
			);
		await callScheduleTool(kai, "schedule_cancel", { id: 3 });
		expect(made.map((s) => s.id)).toEqual([1, 2]);
	});

	test("in a private conversation the owner's own include what an id standing for them created", async () => {
		const { store } = seeded();
		const listed = await callScheduleTool(
			ctx(store, "discord:dm", OWNER, { principalOf, visibility: "private" }),
			"schedule_list",
			{},
		);
		expect(listed).toContain("#1 kept");
		expect(listed).toContain("#2 kept");
		expect(listed).not.toContain("#3 ");
	});

	test("in a shared conversation everyone lists every schedule of the channel, as before", async () => {
		const { store } = seeded();
		for (const visibility of [undefined, "shared"] as const) {
			const listed = await callScheduleTool(
				ctx(store, "discord:dm", KAI, {
					principalOf,
					...(visibility ? { visibility } : {}),
				}),
				"schedule_list",
				{},
			);
			for (const id of [1, 2, 3]) expect(listed).toContain(`#${id} `);
		}
	});
});
