import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCORD, type DiscordServices } from "../core/builtin/discord.ts";
import type { RoundtableConfig } from "../core/config/config.ts";
import type { ChatSurface } from "../core/contract/surface.ts";
import {
	type DefinedRoundtable,
	defineRoundtable,
} from "../core/define-roundtable.ts";
import { Roundtable } from "../core/host.ts";
import { silentLogger } from "../core/log.ts";
import type { RoundtablePlugin } from "../core/plugin.ts";
import { describeDb, testDatabaseUrl } from "../core/testing/database.ts";
import { checkPlugins } from "./checks/configuration.ts";
import { loadConfigFile, Project } from "./project.ts";
import { assemble } from "./runtime.ts";
import { start } from "./start.ts";
import { fakeHttp, fakePorts } from "./testing/fixtures.ts";

// The host the real `roundtable start` builds: the built-in plugins from `defineRoundtable`, with
// only the connection to Discord and the model standing in. `check()` runs every plugin's setup,
// and the agent server binds its sessions once, so what `start` checks must not be what it runs.

const dirs: string[] = [];
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown("test");
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A Discord that connects to nothing, standing in for the built-in plugin that does. */
function quietDiscord(): RoundtablePlugin {
	const surface: ChatSurface = {
		surface: "discord",
		start: async () => undefined,
		sendReply: async () => undefined,
	};
	return {
		name: "quiet-discord",
		provides: [DISCORD],
		replaces: [DISCORD],
		setup: ({ services }) => {
			// SAFETY: the built-in plugins after it hand these to the team and the tools, which read them only when a turn or a command runs.
			services.provide(DISCORD, {
				connection: {
					agentChannels: () => ({}),
					agentDashboard: () => ({ show: async () => undefined }),
					onChannelDeleted: () => undefined,
					ownerChannel: async () => "discord:owner",
					ownerOperations: () => ({}),
				},
				commands: { add: () => undefined },
				threads: { open: async () => undefined, sweep: async () => undefined },
				guard: {},
			} as unknown as DiscordServices);
			return { surfaces: [surface] };
		},
	};
}

/** A runtime that answers nothing, so the agent server builds no Pi session. */
const quietRuntime: RoundtablePlugin = {
	name: "quiet-runtime",
	providers: {
		runtime: () => ({
			runTurn: async () => ({ ok: true, text: "" }),
			steer: async () => false,
			stop: () => false,
			startFresh: async () => undefined,
			deleteConversation: async () => undefined,
			pendingConfirmation: () => undefined,
			heldActions: async () => undefined,
			recentTranscript: async () => [],
		}),
	},
	setup: () => ({}),
};

/** The configuration of a host with Discord and no agents to seed, as pi-elves has it. */
function configuration(): RoundtableConfig {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-start-real-"));
	dirs.push(dir);
	return {
		owner: { id: "100000000000000001", name: "Ada" },
		discord: {
			token: "token",
			guild: "900000000000000001",
			entryChannel: "900000000000000002",
		},
		database: { url: testDatabaseUrl },
		dataDir: dir,
		agentDir: join(dir, "agent"),
		model: "anthropic/claude-sonnet-5-5",
		http: {
			publicUrl: "https://bot.example.test",
			socketPath: join(dir, "public.sock"),
		},
		plugins: [quietDiscord(), quietRuntime],
	};
}

/** What `roundtable start` defines: a new set of plugin objects at each call. */
const define = async (config: RoundtableConfig): Promise<DefinedRoundtable> =>
	defineRoundtable(config, { logger: silentLogger() });

const bun = { version: "1.3.10", required: ">=1.3.0" };

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("roundtable start over the real assembly", () => {
	test("a definition that was checked cannot be run, and one defined again can", async () => {
		const config = configuration();
		const checked = await define(config);
		await new Roundtable(checked.options, checked.plugins).check();
		const again = new Roundtable(checked.options, checked.plugins);
		await expect(again.check()).rejects.toThrow(
			"the agent sessions are bound once",
		);
		const fresh = await define(config);
		await new Roundtable(fresh.options, fresh.plugins).check();
		const running = await define(config);
		const host = new Roundtable(running.options, running.plugins);
		hosts.push(host);
		await host.run();
	});

	test("the plugins check leaves the definition start runs untouched", async () => {
		const config = configuration();
		const project = new Project(
			"/x",
			fakePorts(config, { define: async (given) => define(given) }),
		);
		expect((await checkPlugins(project)).status).toBe("ok");
		// The definition `start` launches is the project's own, never the one checked.
		const assembled = await project.assembled();
		if (!assembled.ok) throw new Error("the configuration did not assemble");
		const { defined } = assembled.value;
		const host = new Roundtable(defined.options, defined.plugins);
		hosts.push(host);
		await host.run();
	});

	test("start checks, launches and reaches the host's running state", async () => {
		const config = configuration();
		const dir = mkdtempSync(join(tmpdir(), "roundtable-start-cwd-"));
		dirs.push(dir);
		const report = await start({
			cwd: dir,
			env: {},
			bun,
			ports: fakePorts(config, { define: async (given) => define(given) }),
			database: { check: async () => undefined, read: async () => [] } as never,
			http: fakeHttp({}),
			// The path `roundtable start` takes, less the process's signal handlers.
			launch: async (defined) => {
				const host = new Roundtable(defined.options, defined.plugins);
				hosts.push(host);
				await host.run();
			},
		});
		expect(report.started).toBe(true);
		expect(
			report.outcomes.find(({ name }) => name === "plugins")?.result.status,
		).toBe("ok");
	});

	/**
	 * A project whose configuration file makes an operator plugin with a factory that keeps a
	 * one-shot value, as the core's agent sessions slot does: the plugin binds it in setup and
	 * refuses a second setup.
	 */
	function project(): string {
		const dir = mkdtempSync(join(tmpdir(), "roundtable-start-project-"));
		dirs.push(dir);
		writeFileSync(
			join(dir, "roundtable.config.ts"),
			`function oneShot() {
	let bound = false;
	return {
		name: "one-shot",
		setup: () => {
			if (bound) throw new Error("the one-shot slot is bound once");
			bound = true;
			return { services: [{ name: "one-shot" }] };
		},
	};
}
const quietRuntime = {
	name: "quiet-runtime",
	providers: {
		runtime: () => ({
			runTurn: async () => ({ ok: true, text: "" }),
			steer: async () => false,
			stop: () => false,
			startFresh: async () => undefined,
			deleteConversation: async () => undefined,
			pendingConfirmation: () => undefined,
			heldActions: async () => undefined,
			recentTranscript: async () => [],
		}),
	},
	setup: () => ({}),
};
export default {
	owner: { id: "100000000000000001", name: "Ada" },
	database: { url: ${JSON.stringify(testDatabaseUrl)} },
	dataDir: ${JSON.stringify(join(dir, "data"))},
	agentDir: ${JSON.stringify(join(dir, "agent"))},
	model: "anthropic/claude-sonnet-5-5",
	plugins: [quietRuntime, oneShot()],
};
`,
		);
		return dir;
	}

	const real = (loadConfig: typeof loadConfigFile) => ({
		loadConfig,
		define: assemble,
		login: async () => "ANTHROPIC_API_KEY",
	});

	const launching =
		(launched: string[]) => async (defined: DefinedRoundtable) => {
			const host = new Roundtable(defined.options, defined.plugins);
			hosts.push(host);
			await host.run();
			launched.push("run");
		};

	test("the plugins the configuration file makes with a factory are new for the check, so start runs plugins that were never set up", async () => {
		const cwd = project();
		const launched: string[] = [];
		const report = await start({
			cwd,
			env: {},
			bun,
			ports: real(loadConfigFile),
			database: { check: async () => undefined, read: async () => [] } as never,
			http: fakeHttp({}),
			launch: launching(launched),
		});
		expect(
			report.outcomes.find(({ name }) => name === "plugins")?.result,
		).toMatchObject({ status: "ok" });
		expect(launched).toEqual(["run"]);
	});

	test("a check over the very plugin objects start launches would have set them up twice", async () => {
		const cwd = project();
		const launched: string[] = [];
		const report = await start({
			cwd,
			env: {},
			bun,
			// A port that ignores `fresh`: the plugin objects of the check are the launched ones.
			ports: real((dir) => loadConfigFile(dir)),
			database: {
				check: async () => undefined,
				read: async () => [],
			} as never,
			http: fakeHttp({}),
			launch: launching(launched),
		});
		// The check refuses to run over the plugins start would launch, and says why.
		expect(report.started).toBe(false);
		expect(launched).toEqual([]);
		expect(
			JSON.stringify(
				report.outcomes.find(({ name }) => name === "plugins")?.result,
			),
		).toContain("was not evaluated again");
	});

	test("a default export built in an imported module is refused with the cause and the fix", async () => {
		const cwd = project();
		const config = join(cwd, "roundtable.config.ts");
		// The same file, moved to a module that the configuration file only re-exports.
		writeFileSync(join(cwd, "base.ts"), readFileSync(config, "utf8"));
		writeFileSync(
			config,
			'import base from "./base.ts";\nexport default base;\n',
		);
		const launched: string[] = [];
		const report = await start({
			cwd,
			env: {},
			bun,
			ports: real(loadConfigFile),
			database: { check: async () => undefined, read: async () => [] } as never,
			http: fakeHttp({}),
			launch: launching(launched),
		});
		expect(report.started).toBe(false);
		expect(launched).toEqual([]);
		const text = JSON.stringify(
			report.outcomes.find(({ name }) => name === "plugins")?.result,
		);
		expect(text).toContain("built in a module the file imports");
		expect(text).toContain(
			"Build the definition in roundtable.config.ts itself",
		);
	});
});
