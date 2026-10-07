import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { postgres } from "./checks/database.ts";
import { requiredVariables } from "./checks/environment.ts";
import type { CliEnvironment } from "./cli.ts";
import { runCli } from "./cli.ts";
import { init } from "./init.ts";
import { loadConfigFile } from "./project.ts";
import { assemble, providerLogin } from "./runtime.ts";
import { start } from "./start.ts";
import { fakeHttp, tempDir } from "./testing/fixtures.ts";

const bun = { version: "1.4.2", required: ">=1.3.0" };
const ROOT = resolve(import.meta.dir, "../..");

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanup.splice(0)) done();
});

const everything = (dir: string): string[] =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
		.sort();

test("init --adapter web writes a project without Discord, around the web chat", () => {
	const dir = tempDir();
	cleanup.push(dir.done);
	const report = init({
		cwd: dir.path,
		dir: "desk",
		bun,
		version: "1.2.3",
		adapter: "web",
	});
	expect(report.ok).toBe(true);
	const root = join(dir.path, "desk");
	expect(everything(root)).toEqual(
		[
			".env.example",
			".gitignore",
			"README.md",
			"biome.json",
			"docker-compose.yml",
			"package.json",
			"persona/assistant.md",
			"plugins/hello.test.ts",
			"plugins/hello.ts",
			"plugins/self-compact.ts",
			"roundtable.config.ts",
			"tsconfig.json",
		].sort(),
	);
	const manifest = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	) as { dependencies: Record<string, string> };
	expect(manifest.dependencies).toMatchObject({
		"pi-roundtable": "1.2.3",
		"pi-roundtable-webchat": "1.2.3",
	});
	const config = readFileSync(join(root, "roundtable.config.ts"), "utf8");
	expect(config).toContain("webChat(");
	expect(config).toContain("oidcJwtVerifier(");
	expect(config).not.toMatch(/discord/i);
	// The persona names its tools, so tools a plugin adds later, such as pi-web-access's, stay out.
	expect(config).toContain('selection: { tools: ["hello_greet"], groups: [] }');
	const example = readFileSync(join(root, ".env.example"), "utf8");
	expect(example).not.toMatch(/DISCORD|PUBLIC_URL|OWNER_ID/);
	for (const name of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URL"])
		expect(requiredVariables(example)).toContain(name);
	for (const path of everything(root))
		expect(readFileSync(join(root, path), "utf8")).not.toMatch(/__[A-Z]+__/);
});

test("init refuses an adapter it does not know, writing nothing", async () => {
	const dir = tempDir();
	cleanup.push(dir.done);
	const errors: string[] = [];
	const io = {
		cwd: dir.path,
		env: {},
		bun: () => bun,
		version: () => "1.2.3",
		out: () => undefined,
		err: (line: string) => void errors.push(line),
	} as unknown as CliEnvironment;
	expect(await runCli(["init", "--adapter", "slack"], io)).toBe(1);
	expect(errors.join("\n")).toContain("discord, web");
	expect(everything(dir.path)).toEqual([]);
	expect(await runCli(["init", "desk", "--adapter", "web"], io)).toBe(0);
	expect(existsSync(join(dir.path, "desk/persona/assistant.md"))).toBe(true);
});

test("a project init --adapter web made passes the doctor's offline checks and starts", async () => {
	// Inside the checkout, so the project's imports resolve to this pi-roundtable and its web chat.
	const root = mkdtempSync(join(ROOT, "node_modules", ".init-web-"));
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	cleanup.push(() => {
		rmSync(root, { recursive: true, force: true });
		if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = agentDir;
	});
	expect(init({ cwd: root, bun, version: "1.2.3", adapter: "web" }).ok).toBe(
		true,
	);
	const env: Record<string, string> = {
		DATABASE_URL: "postgres://roundtable:roundtable@localhost:5432/roundtable",
		MODEL: "anthropic/claude-sonnet-5-5",
		OWNER_NAME: "Ada",
		OIDC_ISSUER: "https://login.example.test/tenant/v2.0",
		OIDC_AUDIENCE: "api://helpdesk",
		OIDC_JWKS_URL: "https://login.example.test/tenant/discovery/v2.0/keys",
		CHAT_MEMBER_ROLES: "Chat.User",
		CHAT_ORIGINS: "https://chat.example.test",
		ANTHROPIC_API_KEY: "test-key",
	};
	// The configuration reads its variables when it loads, as Bun's .env would give them.
	const saved = Object.fromEntries(
		Object.keys(env).map((name) => [name, process.env[name]]),
	);
	Object.assign(process.env, env);
	cleanup.push(() => {
		for (const [name, value] of Object.entries(saved))
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
	});
	const launched: string[][] = [];
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
		launch: async (defined) =>
			void launched.push(defined.plugins.map((plugin) => plugin.name)),
	});
	expect(
		report.outcomes.filter((outcome) => outcome.result.status === "fail"),
	).toEqual([]);
	expect(report.started).toBe(true);
	expect(launched[0]).toContain("webchat");
	expect(launched[0]).not.toContain("discord");
});

/** Links a package's source from this checkout into the project, as an install would place it. */
function linkSource(
	project: string,
	name: string,
	source: string,
	exports: Record<string, string>,
): void {
	const at = join(project, "node_modules", name);
	mkdirSync(at, { recursive: true });
	writeFileSync(
		join(at, "package.json"),
		JSON.stringify({ name, type: "module", exports }),
	);
	symlinkSync(join(source, "src"), join(at, "src"));
}

test("a project init --adapter web made typechecks, passes its test, and lints with no edits", () => {
	const dir = tempDir("roundtable-web-template-");
	cleanup.push(dir.done);
	expect(
		init({ cwd: dir.path, bun, version: "0.1.0", adapter: "web" }).ok,
	).toBe(true);
	linkSource(dir.path, "pi-roundtable", ROOT, {
		".": "./src/index.ts",
		"./testing": "./src/testing.ts",
	});
	linkSource(
		dir.path,
		"pi-roundtable-webchat",
		join(ROOT, "packages/webchat"),
		{
			".": "./src/index.ts",
		},
	);
	const modules = join(dir.path, "node_modules");
	mkdirSync(join(modules, "@types"), { recursive: true });
	for (const name of ["typebox", "jose", "@types/bun"])
		symlinkSync(join(ROOT, "node_modules", name), join(modules, name));
	const run = (cmd: string[]) => {
		const result = Bun.spawnSync(cmd, {
			cwd: dir.path,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CI: "" },
		});
		return {
			ok: result.exitCode === 0,
			output: `${result.stdout.toString()}${result.stderr.toString()}`,
		};
	};
	const typecheck = run([join(ROOT, "node_modules/.bin/tsc"), "--noEmit"]);
	expect(typecheck.output).toBe("");
	const tested = run(["bun", "test"]);
	expect(tested.output).toContain("1 pass");
	const lint = run([join(ROOT, "node_modules/.bin/biome"), "check", "."]);
	expect(lint.output).toContain("No fixes applied");
	expect(typecheck.ok && tested.ok && lint.ok).toBe(true);
}, 120_000);
