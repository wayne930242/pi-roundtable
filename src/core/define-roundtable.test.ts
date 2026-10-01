import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoundtableConfig } from "./config/config.ts";
import { migrate, openPool } from "./db/migrations.ts";
import { defineRoundtable } from "./define-roundtable.ts";
import { ownerRootCommand } from "./discord/owner-command.ts";
import { ConfigError } from "./domain/errors.ts";
import { Roundtable } from "./host.ts";
import { createEn } from "./i18n/en.ts";
import {
	assistantName,
	type Messages,
	messages,
	setLocale,
} from "./i18n/index.ts";
import { createZhTW } from "./i18n/zh-tw.ts";
import { type LogEntry, silentLogger } from "./log.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import { replaceServices } from "./registry/services.ts";
import { BACKGROUND_TURNS, SCHEDULES, type ScheduleStore } from "./services.ts";
import { describeDb, testDatabaseUrl } from "./testing/database.ts";
import { useTestLocale } from "./testing/locale.ts";
import { setTimeZone, timeZone, zonedStamp } from "./time.ts";

const dataDir = mkdtempSync(join(tmpdir(), "roundtable-define-"));

const config: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord: {
		token: "token",
		guild: "900000000000000001",
		entryChannel: "900000000000000002",
	},
	database: { url: "postgres://localhost/roundtable" },
	dataDir,
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.com", port: 3456 },
};

const mine: RoundtablePlugin = {
	name: "mine",
	setup: () => ({ dashboard: ["a line"] }),
};

/** The catalog with every text marked, so text built before the environment applies is recognisable. */
const EAGER = "EAGER:";
function markedCatalog(): Partial<Messages> {
	const marked: Record<string, string> = {};
	for (const [key, value] of Object.entries(
		createEn({ assistant: "Before", root: "before" }),
	))
		if (typeof value === "string") marked[key] = `${EAGER}${key}`;
	return marked as Partial<Messages>;
}

/** Every string under the value that carries the mark; functions are not called, so lazy text stays hidden. */
function markedText(value: unknown, seen = new Set<unknown>()): string[] {
	if (typeof value === "string") return value.startsWith(EAGER) ? [value] : [];
	if (typeof value !== "object" || value === null || seen.has(value)) return [];
	seen.add(value);
	return Object.values(value).flatMap((child) => markedText(child, seen));
}

afterEach(() => {
	// Other suites read the text through the catalog; leave it as the tests expect.
	useTestLocale();
});

describe("defineRoundtable", () => {
	test("returns the built-in plugins in their fixed order, the operator's, then the scheduler", async () => {
		const { plugins } = await defineRoundtable({ ...config, plugins: [mine] });
		expect(plugins.map((plugin) => plugin.name)).toEqual([
			"memory",
			"schedule-store",
			"discord",
			"modules",
			"discord-admin",
			"skills",
			"agent-server",
			"seeds",
			"mine",
			"schedules",
		]);
	});

	test("an addon is left out when its switch is off, and its services with it", async () => {
		const { plugins } = await defineRoundtable({
			...config,
			skills: false,
			memory: false,
			discord: { ...config.discord, admin: false },
		});
		expect(plugins.map((plugin) => plugin.name)).toEqual([
			"schedule-store",
			"discord",
			"modules",
			"agent-server",
			"seeds",
			"schedules",
		]);
		expect(
			plugins.flatMap((plugin) => (plugin.provides ?? []).map((key) => key.id)),
		).not.toContain("roundtable.memory");
	});

	test("each built-in service is provided by one plugin, and a plugin may replace a store in its place", async () => {
		const { plugins } = await defineRoundtable(config);
		const providers = Object.fromEntries(
			plugins.flatMap((plugin) =>
				(plugin.provides ?? []).map((key) => [key.id, plugin.name] as const),
			),
		);
		expect(providers).toEqual({
			"roundtable.memory": "memory",
			"roundtable.schedules": "schedule-store",
			"roundtable.discord": "discord",
			"roundtable.background-turns": "modules",
			"roundtable.delegation": "modules",
			"roundtable.agents": "agent-server",
			"roundtable.skills": "skills",
		});
		const mine: RoundtablePlugin = {
			name: "my-schedules",
			provides: [SCHEDULES],
			replaces: [SCHEDULES],
			setup: ({ services }) => {
				services.provide(SCHEDULES, {} as ScheduleStore);
				return {};
			},
		};
		expect(
			replaceServices([...plugins, mine]).map((plugin) => plugin.name),
		).toEqual([
			"memory",
			"my-schedules",
			"discord",
			"modules",
			"discord-admin",
			"skills",
			"agent-server",
			"seeds",
			"schedules",
		]);
		// The modules plugin is one feature: its background turns and its delegation are replaced together or not at all.
		expect(() =>
			replaceServices([
				...plugins,
				{ ...mine, provides: [BACKGROUND_TURNS], replaces: [BACKGROUND_TURNS] },
			]),
		).toThrow("would drop roundtable.delegation too");
	});

	test("migrates the core's tables first, in a fixed order", async () => {
		const { plugins } = await defineRoundtable(config);
		expect(
			plugins.flatMap((plugin) => (plugin.migrations ?? []).map((m) => m.name)),
		).toEqual([
			"owner-memory",
			"owner-memory-speaker",
			"schedules",
			"skills",
			"skills-guild",
			"held-actions",
			"agents",
			"agents-guild",
		]);
	});

	test("the host options carry the database, the root command, the tool tiers, and one listener", async () => {
		const { options } = await defineRoundtable({
			...config,
			name: "Robin",
			toolTiers: { shell: "admin" },
		});
		expect(options.database).toEqual({ url: config.database.url });
		expect(options.environment?.rootCommand).toBe("robin");
		expect("commands" in options).toBe(false);
		expect(options.listeners).toEqual([{ id: "public", port: 3456 }]);
		expect(options.toolTiers?.minTier("shell")).toBe("admin");
	});

	test("the public socket takes its file mode from config.http.socketMode", async () => {
		const { options } = await defineRoundtable({
			...config,
			http: {
				publicUrl: "https://bot.example.com",
				socketPath: "/tmp/public.sock",
				socketMode: 0o666,
			},
		});
		expect(options.listeners).toEqual([
			{ id: "public", socketPath: "/tmp/public.sock", mode: 0o666 },
		]);
	});

	test("overrides add listeners to the public one and hand over the record of aborted work", async () => {
		const aborted = async () => undefined;
		const { options } = await defineRoundtable(config, {
			listeners: [{ id: "web", socketPath: "/tmp/web.sock" }],
			aborted,
		});
		expect(options.listeners).toEqual([
			{ id: "public", port: 3456 },
			{ id: "web", socketPath: "/tmp/web.sock" },
		]);
		expect(options.aborted).toBe(aborted);
		expect((await defineRoundtable(config)).options.aborted).toBeUndefined();
	});

	test("an error sink receives the error and fatal lines of the host's own logger, with their app tag", async () => {
		const taken: LogEntry[] = [];
		const { options } = await defineRoundtable(config, {
			errorSink: (entry) => taken.push(entry),
		});
		options.logger.info("an info line");
		options.logger.error({ job: 7 }, "an error line");
		options.logger.fatal("a fatal line");
		expect(taken.map((t) => [t.level, t.msg, t.app])).toEqual([
			[50, "an error line", "roundtable"],
			[60, "a fatal line", "roundtable"],
		]);
		expect(taken[0]?.job).toBe(7);
	});

	test("the ops agent's reporter and the sink both see an error, and a sink that throws breaks nothing", async () => {
		const taken: LogEntry[] = [];
		const { options } = await defineRoundtable(
			{ ...config, ops: { agent: "infra" } },
			{
				errorSink: (entry) => {
					taken.push(entry);
					throw new Error("broken sink");
				},
			},
		);
		options.logger.error("reported");
		options.logger.error("after a broken sink");
		expect(taken.map((t) => t.msg)).toEqual([
			"reported",
			"after a broken sink",
		]);
	});

	test("the locale and the assistant's name reach the text the bot shows once the host runs", async () => {
		const before = messages().stopLabel;
		const { options } = await defineRoundtable({
			...config,
			name: "Robin",
			locale: "zh-TW",
		});
		// Defining a host changes nothing in the process.
		expect(messages().stopLabel).toBe(before);
		const host = new Roundtable(
			{ logger: silentLogger(), environment: options.environment },
			[{ name: "quiet", setup: () => ({ events: {} }) }],
		);
		try {
			await host.run();
			expect(messages().ownerRootDescription).toContain("Robin");
			expect(messages().stopLabel).toBe(
				createZhTW({ assistant: "Robin", root: "robin" }).stopLabel,
			);
		} finally {
			await host.shutdown("test");
		}
	});

	test("defining two hosts leaves the process alone and each keeps its own environment", async () => {
		const agentDirBefore = process.env.PI_CODING_AGENT_DIR;
		const zoneBefore = timeZone();
		const before = messages().stopLabel;
		const a = await defineRoundtable({
			...config,
			name: "Alpha",
			timeZone: "America/New_York",
			agentDir: join(dataDir, "agent-a"),
		});
		const b = await defineRoundtable({
			...config,
			name: "Beta",
			locale: "zh-TW",
			timeZone: "Asia/Taipei",
			agentDir: join(dataDir, "agent-b"),
		});
		expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDirBefore);
		expect(timeZone()).toBe(zoneBefore);
		expect(messages().stopLabel).toBe(before);
		expect(a.options.environment).toMatchObject({
			assistant: "Alpha",
			locale: "en",
			timeZone: "America/New_York",
			agentDir: join(dataDir, "agent-a"),
		});
		expect(b.options.environment).toMatchObject({
			assistant: "Beta",
			locale: "zh-TW",
			timeZone: "Asia/Taipei",
			agentDir: join(dataDir, "agent-b"),
		});
	});

	test("the text a host registers is built once its environment applies, not while it is defined", async () => {
		const marked = markedCatalog();
		setLocale("en", { assistant: "Before", root: "before", overrides: marked });
		setTimeZone("America/New_York");
		const { options, plugins } = await defineRoundtable({
			...config,
			name: "Robin",
			locale: "zh-TW",
			timeZone: "Asia/Taipei",
		});
		// Nothing defined here holds text from the catalog or the zone that were in effect meanwhile.
		expect(markedText({ options, plugins })).toEqual([]);
		const zhTW = createZhTW({ assistant: "Robin", root: "robin" });
		const seen: { root?: string; command?: string } = {};
		const stamps: string[] = [];
		const probe: RoundtablePlugin = {
			name: "probe",
			setup: ({ env }) => {
				stamps.push(
					zonedStamp(new Date("2026-01-01T00:00:00Z")),
					assistantName(),
					env.timeZone,
				);
				return { events: {} };
			},
			// The Discord plugin composes the root in its preflight, which runs after the environment applies.
			preflight: () => {
				seen.root = ownerRootCommand("robin").description;
				seen.command = messages().stopLabel;
			},
		};
		const host = new Roundtable(
			{ logger: silentLogger(), environment: options.environment },
			[probe],
		);
		try {
			await host.run();
			expect(seen.root).toBe(zhTW.ownerRootDescription);
			expect(seen.root).not.toBe(
				createEn({ assistant: "Robin", root: "robin" }).ownerRootDescription,
			);
			expect(seen.command).toBe(zhTW.stopLabel);
			expect(stamps).toEqual(["2026-01-01 08:00", "Robin", "Asia/Taipei"]);
		} finally {
			await host.shutdown("test");
		}
	});

	test("a mistake in the configuration stops before anything is built, naming the key", async () => {
		await expect(
			defineRoundtable({
				...config,
				discord: { ...config.discord, guilld: "1" },
			} as RoundtableConfig),
		).rejects.toThrow(
			'config discord.guilld: unknown key. Did you mean "guild"?',
		);
		await expect(
			defineRoundtable({ ...config, model: "sonnet" }),
		).rejects.toBeInstanceOf(ConfigError);
	});

	test("reads the prompt files named in the configuration, and refuses a missing or empty one", async () => {
		const dir = join(dataDir, "prompts");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "shared.md"), "You are Robin.\n");
		writeFileSync(join(dir, "empty.md"), "  \n");
		await defineRoundtable({
			...config,
			prompts: { shared: join(dir, "shared.md") },
		});
		await expect(
			defineRoundtable({
				...config,
				prompts: { shared: join(dir, "missing.md") },
			}),
		).rejects.toThrow("config prompts.shared: cannot read");
		await expect(
			defineRoundtable({
				...config,
				prompts: { shared: join(dir, "empty.md") },
			}),
		).rejects.toThrow(
			`config prompts.shared: ${join(dir, "empty.md")} is empty`,
		);
	});

	test("the judge answers with a clear error until the model is available", async () => {
		const { options } = await defineRoundtable(config);
		await expect(options.judgeModel?.("system", "question")).rejects.toThrow(
			"the judge's model anthropic/claude-sonnet-5-5 is not available",
		);
	});
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("the built-in plugins' tables", () => {
	test("migrate in the fixed order, more than once, into the tables the stores read", async () => {
		const { plugins } = await defineRoundtable(config);
		const migrations = plugins.flatMap((plugin) => plugin.migrations ?? []);
		const sql = openPool(testDatabaseUrl);
		try {
			await migrate(sql, migrations);
			await migrate(sql, migrations);
			const tables: { name: string | null }[] = await sql`
				SELECT to_regclass(t.name)::text AS name FROM (VALUES
					('owner_memory'), ('schedules'), ('held_actions'), ('agents'),
					('agent_groups'), ('skills')) AS t(name)`;
			expect(tables.map((table) => table.name).sort()).toEqual([
				"agent_groups",
				"agents",
				"held_actions",
				"owner_memory",
				"schedules",
				"skills",
			]);
		} finally {
			await sql.close();
		}
	});
});
