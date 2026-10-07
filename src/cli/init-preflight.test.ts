import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RoundtablePlugin } from "../core/plugin.ts";
import { COMPACT_TOOL } from "../core/runtime/extensions/self-compact-guard.ts";
import { testPlugin } from "../testing.ts";
import { postgres } from "./checks/database.ts";
import { init } from "./init.ts";
import { piPackagePorts } from "./pi-packages.ts";
import { loadConfigFile } from "./project.ts";
import { assemble, providerLogin } from "./runtime.ts";
import { start } from "./start.ts";
import type { Adapter } from "./templates.ts";
import { fakeHttp } from "./testing/fixtures.ts";

const bun = { version: "1.4.2", required: ">=1.3.0" };
const ROOT = resolve(import.meta.dir, "../..");
const COMPACTOR = "pi-self-compact";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanup.splice(0)) done();
});

/** What each template's `.env.example` asks for, filled with stand-ins that reach no network. */
const ENV: Record<Adapter, Record<string, string>> = {
	discord: {
		DISCORD_TOKEN: "stub",
		DISCORD_GUILD_ID: "100000000000000001",
		DISCORD_ENTRY_CHANNEL_ID: "100000000000000002",
		OWNER_ID: "100000000000000003",
		PUBLIC_URL: "https://bot.example.test",
	},
	web: {
		OIDC_ISSUER: "https://login.example.test/tenant/v2.0",
		OIDC_AUDIENCE: "api://helpdesk",
		OIDC_JWKS_URL: "https://login.example.test/tenant/discovery/v2.0/keys",
		CHAT_MEMBER_ROLES: "Chat.User",
		CHAT_ORIGINS: "https://chat.example.test",
	},
};

/** The plugins `start` would launch for a fresh project of the adapter. */
async function launchedPlugins(adapter: Adapter): Promise<{
	root: string;
	plugins: readonly RoundtablePlugin[];
}> {
	// Inside the checkout, so the project's imports resolve to this pi-roundtable and its packages.
	const root = mkdtempSync(join(ROOT, "node_modules", `.init-${adapter}-`));
	const env: Record<string, string> = {
		DATABASE_URL: "postgres://roundtable:roundtable@localhost:5432/roundtable",
		MODEL: "anthropic/claude-sonnet-5-5",
		OWNER_NAME: "Ada",
		ANTHROPIC_API_KEY: "test-key",
		...ENV[adapter],
	};
	const saved = Object.fromEntries(
		[...Object.keys(env), "PI_CODING_AGENT_DIR"].map((name) => [
			name,
			process.env[name],
		]),
	);
	const cwd = process.cwd();
	cleanup.push(() => {
		process.chdir(cwd);
		rmSync(root, { recursive: true, force: true });
		for (const [name, value] of Object.entries(saved))
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
	});
	expect(init({ cwd: root, bun, version: "1.2.3", adapter }).ok).toBe(true);
	// The configuration reads its variables when it loads, as Bun's .env would give them, and its
	// paths from the project directory, where the roundtable command runs.
	Object.assign(process.env, env);
	process.chdir(root);
	let plugins: readonly RoundtablePlugin[] = [];
	const report = await start({
		cwd: root,
		env,
		bun,
		ports: {
			loadConfig: loadConfigFile,
			define: assemble,
			login: providerLogin,
		},
		database: postgres,
		http: fakeHttp({}),
		launch: async (defined) => {
			plugins = defined.plugins;
		},
	});
	expect(report.outcomes.filter((o) => o.result.status === "fail")).toEqual([]);
	expect(report.started).toBe(true);
	return { root, plugins };
}

for (const adapter of ["discord", "web"] as const)
	test(`a fresh ${adapter} project loads the Pi package that registers ${COMPACT_TOOL}, which the runtime's preflight requires`, async () => {
		const { root, plugins } = await launchedPlugins(adapter);
		const packages: string[] = [];
		for (const plugin of plugins.filter((p) => p.name === "self-compact")) {
			const harness = await testPlugin(plugin);
			packages.push(...(harness.contribution.piPackages ?? []));
			await harness.stop();
		}
		expect(packages).toEqual([COMPACTOR]);
		// The project installs the same version this checkout tests against.
		const manifest = (path: string) =>
			JSON.parse(readFileSync(path, "utf8")) as {
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
		expect(manifest(join(root, "package.json")).dependencies?.[COMPACTOR]).toBe(
			manifest(join(ROOT, "package.json")).devDependencies?.[COMPACTOR],
		);
	});

test(`${COMPACTOR} registers ${COMPACT_TOOL}`, async () => {
	expect(await piPackagePorts.tools(ROOT, COMPACTOR)).toContain(COMPACT_TOOL);
}, 30_000);
