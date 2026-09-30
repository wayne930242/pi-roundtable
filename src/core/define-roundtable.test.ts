import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoundtableConfig } from "./config/config.ts";
import { defineRoundtable } from "./define-roundtable.ts";
import { ConfigError } from "./domain/errors.ts";
import { messages } from "./i18n/index.ts";
import { createZhTW } from "./i18n/zh-tw.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import { useTestLocale } from "./testing/locale.ts";

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

afterEach(() => {
	// Other suites read the text through the catalog; leave it as the tests expect.
	useTestLocale();
});

describe("defineRoundtable", () => {
	test("returns the built-in plugins in their fixed order, the operator's, then the scheduler", async () => {
		const { plugins } = await defineRoundtable({ ...config, plugins: [mine] });
		expect(plugins.map((plugin) => plugin.name)).toEqual([
			"stores",
			"discord",
			"modules",
			"agent-server",
			"seeds",
			"mine",
			"schedules",
		]);
	});

	test("migrates the core's tables first, in a fixed order", async () => {
		const { plugins } = await defineRoundtable(config);
		expect(
			plugins.flatMap((plugin) => (plugin.migrations ?? []).map((m) => m.name)),
		).toEqual([
			"owner-memory",
			"owner-memory-speaker",
			"schedules",
			"pending-confirmations",
			"agents",
			"agents-guild",
			"skills",
			"skills-guild",
			"skills-written-kind",
		]);
	});

	test("the host options carry the database, the root command, the tool tiers, and one listener", async () => {
		const { options } = await defineRoundtable({
			...config,
			name: "Robin",
			toolTiers: { shell: "admin" },
		});
		expect(options.database).toEqual({ url: config.database.url });
		expect(options.commands?.root.name).toBe("robin");
		expect(options.listeners).toEqual([{ id: "public", port: 3456 }]);
		expect(options.toolTiers?.minTier("shell")).toBe("admin");
	});

	test("the locale and the assistant's name reach the text the bot shows", async () => {
		await defineRoundtable({ ...config, name: "Robin", locale: "zh-TW" });
		expect(messages().ownerRootDescription).toContain("Robin");
		expect(messages().stopLabel).toBe(
			createZhTW({ assistant: "Robin", root: "robin" }).stopLabel,
		);
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
