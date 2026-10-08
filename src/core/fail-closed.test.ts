import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OWNER_TARGET } from "./agents/agent-claim.ts";
import type { BackgroundTurn } from "./contract/channels.ts";
import { SYSTEM_PRINCIPAL } from "./identity/principal-store.ts";
import { silentLogger } from "./log.ts";
import { ConversationBackgroundTurns } from "./modules/background/background-turns.ts";
import { delegateExtension } from "./modules/delegation/delegate.ts";
import type { DelegationJob } from "./modules/delegation/delegator.ts";
import type { Schedule } from "./modules/schedules/schedule-store.ts";
import {
	callScheduleTool,
	type ScheduleToolContext,
} from "./modules/schedules/schedule-tools.ts";
import { schedulesExtension } from "./modules/schedules/schedules.ts";
import { isSystemTurn } from "./routing/system-turns.ts";
import type { ScheduleStore } from "./services.ts";
import type { Speaker } from "./speakers.ts";
import { runsAsAuthor } from "./testing/background.ts";

const ROOT = resolve(import.meta.dir, "../..");

// Where each implicit owner of 0.8 is refused now, by the test that shows it:
// - a turn without a speaker, and a task with no turn to take its tier from: src/fail-closed-runtime.test.ts;
// - a background turn without a principal or tier, of a disabled, unknown, or long-unseen principal,
//   or naming the system principal from outside the host: src/core/routing/background-checks.test.ts
//   and, through the identity service, src/core/identity/background-identity.test.ts;
// - the agent server's background turn without the router's speaker: src/core/agents/agent-claim.test.ts;
// - the ops reporter's and a Discord webhook's report turns, the host's own at the owner tier: below,
//   and src/core/agents/agent-claim.test.ts;
// - schedules and delegated tasks in a turn nobody is named for, or the host's own: below;
// - a message whose author, once recorded, is not who was admitted: src/core/routing/channel-router-identity.test.ts.

/**
 * Where a literal that makes someone the owner by default may stay in the source, and why. A new
 * one fails the scan until it is listed here with its reason: an implicit owner is how a turn
 * nobody named ran with the owner's tools.
 */
const ALLOWED: Record<string, string> = {
	'src/core/runtime/conversation-sessions.ts: ?? "owner"':
		"the conversation kind picks only the persona, never a tier",
	'src/core/testing/owner.ts: tier: "owner"': "the test owner's speaker",
	'src/core/testing/surface-contract.ts: tier: "owner"':
		"the surface contract's owner, a test fixture",
	'src/core/testing/prompt-capture.ts: tier: "owner"':
		"the capture host's owner speaker, a test fixture",
	'src/core/agents/agent-claim.ts: tier: "owner"':
		"a Discord webhook's report is the host's own turn at the owner tier (OD-5)",
	'src/core/modules/background/background-turns.ts: tier: "owner"':
		"a logged error's report is the host's own turn at the owner tier (OD-5)",
	'packages/mcp/src/remote-mcp/default-conversation.ts: tier: "owner"':
		"REMOTE_SPEAKER, deprecated and no longer used for a turn",
	'packages/web/src/console-api.ts: ?? "owner"':
		"the console's label of a conversation's kind, not a tier",
	'examples/echo-runtime.ts: ?? "owner"':
		"the example runtime's persona kind, not a tier",
	'src/testing.ts: ?? "owner"': "testPlugin's default owner id, a test fixture",
};

const PATTERN = /\?\? "owner"|tier: "owner"/;

/** Every TypeScript source of the core, the packages, and the examples, tests and fixtures left out. */
function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (name === "node_modules" || name === "fixtures") return [];
		if (statSync(path).isDirectory()) return sources(path);
		return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
	});
}

test("no source makes anyone the owner by a default, except where the scan lists why", () => {
	const found = [
		...sources(join(ROOT, "src")),
		...readdirSync(join(ROOT, "packages")).flatMap((pkg) =>
			sources(join(ROOT, "packages", pkg, "src")),
		),
		...sources(join(ROOT, "examples")),
	].flatMap((file) =>
		readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line) => {
				const match = line.match(PATTERN);
				return match ? [`${relative(ROOT, file)}: ${match[0]}`] : [];
			}),
	);
	const unlisted = [...new Set(found)].filter((key) => !(key in ALLOWED));
	expect(unlisted).toEqual([]);
});

/** A schedule store that keeps what it is given in memory. */
function memoryStore(): ScheduleToolContext["store"] & { made: Schedule[] } {
	const made: Schedule[] = [];
	return {
		made,
		create: async (schedule) => {
			// SAFETY: the tools read back only what they stored and the id.
			const created = { ...schedule, id: made.length + 1 } as Schedule;
			made.push(created);
			return created;
		},
		get: async (id) => made.find((schedule) => schedule.id === id),
		forChannel: async (channel) =>
			made.filter((schedule) => schedule.channel === channel),
		update: async () => undefined,
		remove: async () => undefined,
	};
}

/** The tools an extension registers, run as the model would call them. */
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

const KAI: Speaker = {
	id: "966666600000000003",
	name: "Kai",
	tier: "admin",
	principalId: "p_01JKAI",
};
const SYSTEM: Speaker = {
	id: SYSTEM_PRINCIPAL,
	name: "Zed",
	tier: "owner",
	principalId: SYSTEM_PRINCIPAL,
};
const CREATE = {
	title: "patrol",
	prompt: "check the disk",
	time: "09:00",
	every_days: 1,
};

describe("schedules and delegated tasks are someone's", () => {
	const schedules = (
		store: ScheduleStore,
		speaker: () => Speaker | undefined,
	) =>
		toolsOf(
			schedulesExtension(
				{ store, channelFor: async (channel) => channel },
				"fake:1",
				{
					name: "Ada",
					pronouns: { subject: "they", object: "them", possessive: "their" },
				},
				undefined,
				speaker,
			),
		);

	test("a schedule tool in a turn nobody is named for refuses, rather than setting one up as the owner's", async () => {
		const store = memoryStore();
		// SAFETY: the schedule tools call only the methods the memory store has.
		const tools = await schedules(
			store as unknown as ScheduleStore,
			() => undefined,
		);
		const answer = await tools.get("schedule_create")?.(CREATE);
		expect(answer).toContain("someone");
		expect(store.made).toEqual([]);
	});

	test("a schedule is stored as its creator's principal, at their tier, whatever id they spoke as", async () => {
		const store = memoryStore();
		// SAFETY: as above.
		const tools = await schedules(store as unknown as ScheduleStore, () => KAI);
		await tools.get("schedule_create")?.(CREATE);
		expect(store.made).toMatchObject([
			{ createdById: "p_01JKAI", createdByName: "Kai", createdTier: "admin" },
		]);
	});

	test("the host's own turn, such as an error report's, sets up no schedule", async () => {
		const store = memoryStore();
		await expect(
			callScheduleTool(
				{
					store,
					channel: "fake:1",
					target: OWNER_TARGET,
					author: SYSTEM,
					now: new Date(),
				},
				"schedule_create",
				CREATE,
			),
		).rejects.toThrow(/host's own/);
		expect(store.made).toEqual([]);
	});

	const delegations = (speaker: () => Speaker | undefined) => {
		const started: Omit<DelegationJob, "id" | "startedAt" | "thread">[] = [];
		const tools = toolsOf(
			delegateExtension(
				{
					delegator: {
						start: (request) => {
							started.push(request);
							return { ...request, id: 1, startedAt: new Date() };
						},
					},
					channelFor: async (channel) => channel,
				},
				"fake:1",
				{
					name: "Ada",
					pronouns: { subject: "they", object: "them", possessive: "their" },
				},
				"fake:1",
				speaker,
			),
		);
		return { started, tools };
	};

	test("delegate_task in a turn nobody is named for, or the host's own, refuses; a person's job reports as them", async () => {
		for (const speaker of [undefined, SYSTEM]) {
			const { started, tools } = delegations(() => speaker);
			const answer = await (await tools).get("delegate_task")?.({
				title: "look",
				task: "look it up",
			});
			expect(answer).toMatch(/someone|host's own/);
			expect(started).toEqual([]);
		}
		const { started, tools } = delegations(() => KAI);
		await (await tools).get("delegate_task")?.({
			title: "look",
			task: "look it up",
		});
		expect(started[0]?.author).toEqual({
			principalId: "p_01JKAI",
			id: KAI.id,
			name: "Kai",
			tier: "admin",
		});
	});
});

describe("the turns nobody wrote", () => {
	const background = (
		principalOf?: (id: string) => Promise<string | undefined>,
	) => {
		const turns: BackgroundTurn[] = [];
		const made = new ConversationBackgroundTurns({
			conversations: {
				runsAs: runsAsAuthor,
				background: async (turn) => {
					turns.push(turn);
					return { status: "ran" };
				},
			},
			system: { id: "assistant", name: "Zed" },
			logger: silentLogger(),
			...(principalOf ? { principalOf } : {}),
		});
		return { made, turns };
	};
	// SAFETY: runScheduled reads only these fields of a schedule.
	const schedule = (createdById: string): Schedule =>
		({
			id: 3,
			channel: "fake:1",
			target: "owner",
			title: "patrol",
			prompt: "check the disk",
			createdById,
			createdByName: "Kai",
			createdTier: "admin",
			recurrence: { kind: "once", date: "2026-10-08", time: "09:00" },
		}) as unknown as Schedule;

	test("a due schedule runs as the principal its creator id stands for: 0.8's remote-mcp as the primary owner", async () => {
		const { made, turns } = background(async (id) =>
			id === "remote-mcp" ? "p_owner" : id,
		);
		await made.runScheduled(schedule("remote-mcp"), new Date(0));
		await made.runScheduled(schedule("p_01JKAI"), new Date(0));
		expect(turns.map((turn) => [turn.author, turn.tier])).toEqual([
			[{ principalId: "p_owner", id: "remote-mcp", name: "Kai" }, "admin"],
			[{ principalId: "p_01JKAI", id: "p_01JKAI", name: "Kai" }, "admin"],
		]);
	});

	test("a logged error's report is the host's own turn, at the owner tier", async () => {
		const { made, turns } = background();
		await made.runErrorReport("fake:1", "it broke");
		expect(turns[0]).toMatchObject({
			author: { principalId: SYSTEM_PRINCIPAL, id: "assistant", name: "Zed" },
			tier: "owner",
			report: true,
		});
		expect(isSystemTurn(turns[0] as BackgroundTurn)).toBe(true);
	});
});
