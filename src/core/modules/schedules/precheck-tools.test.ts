import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { SQL } from "bun";
import type { BackgroundTarget } from "../../contract/channels.ts";
import type { OwnerPrompts } from "../../domain/owner-prompts.ts";
import { type HoldCheck, type HoldRule, holdChain } from "../../holds.ts";
import { silentLogger } from "../../log.ts";
import { ConfirmationGate } from "../../runtime/extensions/confirmation-gate.ts";
import { tierAtLeast } from "../../speakers.ts";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "../../testing/database.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { TEST_OWNER } from "../../testing/owner.ts";
import { fakePrechecks, fakeScriptRunner } from "../../testing/prechecks.ts";
import { setTimeZone } from "../../time.ts";
import type { ToolTiers } from "../../tool-tiers.ts";
import {
	precheckScriptHoldRule,
	precheckScriptTools,
	readPrecheckScript,
} from "./precheck-tools.ts";
import type { PrecheckFinding, PrecheckRegistry } from "./prechecks.ts";
import { PgScheduleStore, type Schedule } from "./schedule-store.ts";
import {
	callScheduleTool,
	type ScheduleToolContext,
} from "./schedule-tools.ts";
import { Scheduler } from "./scheduler.ts";

/** The test runner names a script's call `${server}-${tool}`, as the host's own agent would see it. */
const GMAIL = "google-send-gmail-message";
const LABELS = "google-manage-label";

/** Sending mail always waits for the owner. */
const MAIL_RULE: HoldRule = {
	name: "mail",
	describe: (tool, input) =>
		tool === GMAIL
			? `send an email to ${typeof input.to === "string" ? input.to : "someone"}`
			: undefined,
};

/** Managing labels waits only to delete one, so its verdict depends on the input. */
const LABEL_RULE: HoldRule = {
	name: "labels",
	describe: (tool, input) =>
		tool === LABELS && input.action === "delete"
			? `delete the label ${String(input.label)}`
			: undefined,
	mayHold: (tool) => tool === LABELS,
};

/** Admins may schedule, but only the owner may send mail or approve sending it. */
const TIERS: ToolTiers = {
	minTier: (tool) => (tool.startsWith("schedule_") ? "admin" : "owner"),
	allows: (tier, tool) => tierAtLeast(tier, TIERS.minTier(tool)),
};

/** The host's chain, with the precheck rule judging scripts by the same chain. */
function chain(prechecks: () => PrecheckRegistry | undefined): HoldCheck {
	let holds: HoldCheck = () => undefined;
	holds = holdChain([
		MAIL_RULE,
		LABEL_RULE,
		precheckScriptHoldRule({
			prechecks,
			holds: () => holds,
			tiers: () => TIERS,
		}),
	]);
	return holds;
}

function runnerRegistry(): PrecheckRegistry {
	const registry = fakePrechecks();
	registry.useScriptRunner(fakeScriptRunner({ wake: false }));
	return registry;
}

const READS = `export default async ({ mcp, today }) => {
	const hrv = await mcp.json("health", "garmin-get-hrv", { date: today });
	return hrv.lastNightAvg < 26 ? { wake: true, context: "HRV low" } : { wake: false };
};`;

const MAILS = `export default async ({ mcp, today }) => {
	const hrv = await mcp.json("health", "garmin-get-hrv", { date: today });
	await mcp.call("google", "send-gmail-message", { to: "owner@example.test", body: String(hrv.lastNightAvg) });
	return { wake: false };
};`;

const MAILS_COMPUTED = `export default async ({ mcp, today }) => {
	const to = today > "2026" ? "a@example.test" : "b@example.test";
	await mcp.call("google", "send-gmail-message", { to });
	return { wake: false };
};`;

beforeAll(() => setTimeZone("Asia/Taipei"));
afterAll(useTestLocale);

describe("reading a precheck script's MCP calls", () => {
	test("collects each call's server and tool, with its arguments when written out", () => {
		expect(readPrecheckScript(MAILS).calls).toEqual([
			// `today` is computed, so these arguments are not known either.
			{ server: "health", tool: "garmin-get-hrv" },
			// Its body is computed, so its arguments are known only when it runs.
			{ server: "google", tool: "send-gmail-message" },
		]);
		expect(
			readPrecheckScript(
				`export default async ({ mcp }) => { await mcp.call("health", \`garmin-login\`); return { wake: false }; };`,
			).calls,
		).toEqual([{ server: "health", tool: "garmin-login", args: {} }]);
		expect(
			readPrecheckScript(
				`export default async ({ mcp }) => { await mcp.call("g", "labels", { action: "list", ids: [1, -2], deep: { on: true } }); return { wake: false }; };`,
			).calls,
		).toEqual([
			{
				server: "g",
				tool: "labels",
				args: { action: "list", ids: [1, -2], deep: { on: true } },
			},
		]);
	});

	test("refuses computed names and any other way to reach mcp", () => {
		for (const [script, reason] of [
			[
				`export default async ({ mcp }) => { const t = "send-gmail-message"; await mcp.call("google", t); };`,
				"computes a server or tool name",
			],
			[
				`export default async ({ mcp }) => { const m = mcp; await m.call("google", "send-gmail-message"); };`,
				"uses mcp other than in a call",
			],
			[
				`export default async ({ mcp }) => { await helper(mcp); };`,
				"uses mcp other than in a call",
			],
			[
				`export default async ({ mcp: m }) => { await m.call("google", "send-gmail-message"); };`,
				"renames mcp",
			],
			[
				`export default async (context) => { await context.mcp.call("google", "send-gmail-message"); };`,
				"reads .mcp from an object",
			],
			[
				`export default async (context) => { await context["mcp"].call("google", "x"); };`,
				`reads ["mcp"]`,
			],
			[
				`export default async ({ mcp }) => { await mcp["call"]("google", "send-gmail-message"); };`,
				"uses mcp[...]",
			],
			[
				`export default async function () { await arguments[0].mcp.call("google", "x"); }`,
				"may not use arguments",
			],
			[
				`export default async ({ mcp }) => { eval("mcp.call('google', 'x')"); };`,
				"may not use eval",
			],
		] as const)
			expect(() => readPrecheckScript(script)).toThrow(reason);
		// Destructuring it in the body is fine.
		expect(
			readPrecheckScript(
				`export default async (context) => { const { mcp } = context; await mcp.call("health", "garmin-login"); return { wake: false }; };`,
			).calls,
		).toEqual([{ server: "health", tool: "garmin-login", args: {} }]);
	});

	test("judges each tool with the host's hold rules, by its arguments or, computed, by what may hold it", () => {
		const options = {
			toolName: (server: string, tool: string) => `${server}-${tool}`,
			holds: holdChain([MAIL_RULE, LABEL_RULE]),
		};
		expect(precheckScriptTools(READS, options)).toEqual([
			{ server: "health", tool: "garmin-get-hrv" },
		]);
		expect(precheckScriptTools(MAILS, options)).toEqual([
			{ server: "health", tool: "garmin-get-hrv" },
			{
				server: "google",
				tool: "send-gmail-message",
				held: "send an email to someone",
			},
		]);
		// Written out, the arguments decide; computed, a rule that may hold the tool holds it.
		const labels = (args: string) =>
			`export default async ({ mcp, today }) => { await mcp.call("google", "manage-label", ${args}); return { wake: false }; };`;
		expect(precheckScriptTools(labels(`{ action: "list" }`), options)).toEqual([
			{ server: "google", tool: "manage-label" },
		]);
		expect(
			precheckScriptTools(labels(`{ action: "delete", label: "x" }`), options),
		).toEqual([
			{ server: "google", tool: "manage-label", held: "delete the label x" },
		]);
		expect(precheckScriptTools(labels(`{ action: today }`), options)).toEqual([
			{
				server: "google",
				tool: "manage-label",
				held: `call ${LABELS}, which the labels rule may hold depending on its input`,
			},
		]);
	});
});

describe("saving a script through the confirmation gate", () => {
	const registry = runnerRegistry();
	const holds = chain(() => registry);
	const create = (script: string) => ({
		title: "recovery",
		prompt: "check last night's recovery",
		time: "09:30",
		precheck_script: script,
	});

	test("a script that calls only tools nobody holds saves as before", () => {
		const gate = new ConfirmationGate(holds, TEST_OWNER);
		gate.beginTurn("general", false);
		expect(gate.hold("schedule_create", create(READS))).toBeUndefined();
	});

	test("a script that calls a held tool holds the saving call, naming what each run may do", () => {
		for (const script of [MAILS, MAILS_COMPUTED]) {
			const gate = new ConfirmationGate(holds, TEST_OWNER);
			gate.beginTurn("general", false);
			expect(gate.hold("schedule_create", create(script))).toContain(
				'save schedule "recovery" with a precheck script that, each time it runs, may: send an email to someone',
			);
			gate.endTurn();
			// The owner's confirming message releases the identical call once.
			gate.beginTurn("general", true);
			expect(gate.hold("schedule_create", create(script))).toBeUndefined();
			expect(gate.hold("schedule_create", create(script))).toContain("Held");
		}
	});

	test("only someone who may approve each held call it makes may approve saving the script", async () => {
		const gate = new ConfirmationGate(
			holds,
			TEST_OWNER,
			undefined,
			undefined,
			TIERS,
		);
		gate.beginTurn("general", false);
		const tiers: unknown[] = [];
		await gate.decide("schedule_create", create(MAILS), {
			prompts: {
				confirm: async (
					_title: string,
					_message: string,
					_signal?: AbortSignal,
					minTier?: string,
				) => {
					tiers.push(minTier);
					return "expired";
				},
				ask: async () => undefined,
			} as unknown as OwnerPrompts,
			asker: "Sam",
		});
		// schedule_create is an admin's, but sending mail needs the owner.
		expect(tiers).toEqual(["owner"]);
		gate.endTurn();
		expect(gate.pending()?.calls[0]?.minTier).toBe("owner");
		expect(holds.approvalTier?.("schedule_create", create(READS), {})).toBe(
			undefined,
		);
	});

	test("changing the script is judged again; changing only the timing is not", () => {
		const gate = new ConfirmationGate(holds, TEST_OWNER);
		gate.beginTurn("general", false);
		expect(
			gate.hold("schedule_update", { id: 7, time: "10:00" }),
		).toBeUndefined();
		expect(
			gate.hold("schedule_update", { id: 7, precheck_script: MAILS }),
		).toContain("save schedule #7 with a precheck script");
	});

	test("without a script runner, the rule holds nothing and the tool refuses the script", () => {
		const gate = new ConfirmationGate(
			chain(() => fakePrechecks()),
			TEST_OWNER,
		);
		gate.beginTurn("general", false);
		expect(gate.hold("schedule_create", create(MAILS))).toBeUndefined();
	});
});

const OPEN: BackgroundTarget = {
	name: "open",
	label: () => "Open",
	schedules: { perChannel: 5, promptChars: 2_000, aheadDays: 90 },
};

const taipei = (stamp: string) =>
	new Date(`${stamp.replace(" ", "T")}:00+08:00`);

describeDb("precheck script tools over PostgreSQL", () => {
	let store: TestStore<PgScheduleStore>;

	beforeAll(async () => {
		const admin = new SQL(testDatabaseUrl);
		await admin`DROP TABLE IF EXISTS schedules`;
		await admin.close();
		store = await openTestStore(PgScheduleStore);
	});

	afterAll(async () => {
		await store.close();
	});

	beforeEach(async () => {
		const admin = new SQL(testDatabaseUrl);
		await admin`TRUNCATE schedules`;
		await admin.close();
	});

	function setup() {
		const runner = fakeScriptRunner({ wake: false });
		const registry = fakePrechecks();
		registry.useScriptRunner(runner);
		const holds = chain(() => registry);
		const ctx: ScheduleToolContext = {
			store,
			channel: "discord:health",
			target: OPEN,
			author: { id: "u1", name: "Sam" },
			now: taipei("2026-09-26 23:30"),
			prechecks: registry,
			holds: () => holds,
		};
		const turns: { schedule: Schedule; finding?: PrecheckFinding }[] = [];
		const scheduler = new Scheduler({
			store,
			prechecks: registry,
			holds: () => holds,
			runner: {
				runScheduled: async (schedule, _firedAt, finding) => {
					turns.push({ schedule, ...(finding ? { finding } : {}) });
					return { status: "ran" };
				},
			},
			logger: silentLogger(),
			now: () => taipei("2026-09-27 09:30"),
		});
		return { runner, holds, ctx, turns, scheduler };
	}

	const prompts = (answer: "approved" | "declined") =>
		({
			confirm: async () => answer,
			ask: async () => undefined,
		}) as unknown as OwnerPrompts;

	const input = (script: string) => ({
		title: "recovery",
		prompt: "check last night's recovery",
		time: "09:30",
		precheck_script: script,
	});

	test("approved on its card, the script saves with its held tools marked; declined, nothing saves", async () => {
		const { holds, ctx } = setup();
		const gate = new ConfirmationGate(holds, TEST_OWNER);
		gate.beginTurn("general", false);
		const declined = await gate.decide("schedule_create", input(MAILS), {
			prompts: prompts("declined"),
			asker: "Sam",
		});
		expect(declined.reason).toContain("declined this on its approval card");
		// The gate blocked the call, so the tool never ran.
		expect(await store.forChannel("discord:health")).toEqual([]);
		const approved = await gate.decide("schedule_create", input(MAILS), {
			prompts: prompts("approved"),
			asker: "Sam",
		});
		expect(approved).toEqual({ approvedOnCard: true });
		await callScheduleTool(ctx, "schedule_create", input(MAILS));
		const [saved] = await store.forChannel("discord:health");
		expect(saved?.precheckTools).toEqual([
			{ server: "health", tool: "garmin-get-hrv" },
			{
				server: "google",
				tool: "send-gmail-message",
				held: "send an email to someone",
			},
		]);
		expect(await callScheduleTool(ctx, "schedule_list", {})).toContain(
			"tools: health/garmin-get-hrv, google/send-gmail-message (approved by the owner: send an email to someone)",
		);
	});

	test("each run may call only the tools saved with its script; a timing change keeps them", async () => {
		const { runner, ctx, scheduler } = setup();
		await callScheduleTool(ctx, "schedule_create", input(READS));
		const [saved] = await store.forChannel("discord:health");
		if (!saved) throw new Error("missing schedule");
		await callScheduleTool(ctx, "schedule_update", {
			id: saved.id,
			time: "09:30",
		});
		expect((await store.get(saved.id))?.precheckTools).toEqual([
			{ server: "health", tool: "garmin-get-hrv" },
		]);
		await scheduler.tick();
		await scheduler.idle();
		expect(runner.calls[0]?.context.tools).toEqual([
			{ server: "health", tool: "garmin-get-hrv" },
		]);
	});

	test("a script saved before tools were recorded runs if it calls no held tool, and otherwise wakes the agent to save it again", async () => {
		const { runner, turns, scheduler } = setup();
		const admin = new SQL(testDatabaseUrl);
		try {
			const insert = (script: string) => admin`
				INSERT INTO schedules (channel_key, mode, title, prompt, recurrence, next_run,
					created_by_id, created_by_name, precheck_script)
				VALUES ('discord:health', 'open', 'old', 'p', ${JSON.stringify({ kind: "every", time: "09:30", everyDays: 1, startDate: "2026-09-01" })},
					${taipei("2026-09-27 09:30")}, 'u1', 'Sam', ${script})`;
			await insert(READS);
			await scheduler.tick();
			await scheduler.idle();
			expect(runner.calls.map((c) => c.context.tools)).toEqual([
				[{ server: "health", tool: "garmin-get-hrv" }],
			]);
			expect(turns).toEqual([]);
			await admin`TRUNCATE schedules`;
			await insert(MAILS);
			await scheduler.tick();
			await scheduler.idle();
			// The held script never ran; the turn wakes with why.
			expect(runner.calls).toHaveLength(1);
			expect(turns.map((t) => t.finding)).toEqual([
				{
					precheck: "script",
					error:
						"this script was saved before its tools were recorded and calls tools that need the owner's approval (google/send-gmail-message), so it did not run; save it again with schedule_update, so the owner can approve the tools it calls",
				},
			]);
		} finally {
			await admin.close();
		}
	});
});
