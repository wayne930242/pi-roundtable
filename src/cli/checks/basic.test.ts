import { afterEach, describe, expect, test } from "bun:test";
import { Project } from "../project.ts";
import type { Result } from "../report.ts";
import {
	fakeHttp,
	fakePorts,
	tempDir,
	validConfig,
} from "../testing/fixtures.ts";
import { checkBun } from "./bun.ts";
import { checkConfiguration, checkPlugins } from "./configuration.ts";
import { checkEnvironment } from "./environment.ts";
import { checkModelLogin } from "./model.ts";
import { checkPublicUrl } from "./public-url.ts";

const dirs: ReturnType<typeof tempDir>[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) dir.done();
});

/** The failure's problem and fix text, or an assertion failure when the check passed or skipped. */
function failure(result: Result): string {
	if (result.status !== "fail")
		throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
	return `${result.problem}\n${result.fix}`;
}

describe("Bun", () => {
	test("passes on a version in range", () => {
		expect(checkBun({ version: "1.3.10", required: ">=1.3.0" }).status).toBe(
			"ok",
		);
	});
	test("fails when missing, with the install page as the fix", () => {
		const text = failure(checkBun({ version: undefined, required: ">=1.3.0" }));
		expect(text).toContain("not installed");
		expect(text).toContain("https://bun.sh/docs/installation");
	});
	test("fails when too old, saying to upgrade", () => {
		const text = failure(checkBun({ version: "1.2.0", required: ">=1.3.0" }));
		expect(text).toContain("1.2.0");
		expect(text).toContain("bun upgrade");
	});
});

describe("environment", () => {
	const example =
		"# comment\nDISCORD_TOKEN=\nDATABASE_URL=postgres://x\n# OPTIONAL=\nOWNER_ID=\n";
	test("passes when every listed variable has a value", () => {
		const dir = tempDir();
		dirs.push(dir);
		dir.write(".env.example", example);
		expect(
			checkEnvironment(dir.path, {
				DISCORD_TOKEN: "t",
				DATABASE_URL: "d",
				OWNER_ID: "1",
			}).status,
		).toBe("ok");
	});
	test("names every variable without a value, but not commented ones, and says to copy the example", () => {
		const dir = tempDir();
		dirs.push(dir);
		dir.write(".env.example", example);
		const text = failure(
			checkEnvironment(dir.path, { DATABASE_URL: "d", OWNER_ID: "  " }),
		);
		expect(text).toContain("DISCORD_TOKEN, OWNER_ID");
		expect(text).not.toContain("OPTIONAL");
		expect(text).not.toContain("DATABASE_URL");
		expect(text).toContain("Copy .env.example to .env");
	});
	test("says to fill .env when it exists", () => {
		const dir = tempDir();
		dirs.push(dir);
		dir.write(".env.example", example);
		dir.write(".env", "");
		expect(failure(checkEnvironment(dir.path, {}))).toContain(
			"Fill them in .env",
		);
	});
	test("skips a project without an example", () => {
		const dir = tempDir();
		dirs.push(dir);
		expect(checkEnvironment(dir.path, {}).status).toBe("skipped");
	});
});

describe("configuration", () => {
	const project = (config: unknown) => new Project("/x", fakePorts(config));
	test("passes a configuration the schema accepts", async () => {
		expect((await checkConfiguration(project(validConfig))).status).toBe("ok");
	});
	test("names the failing key, and says where to fix it", async () => {
		const text = failure(
			await checkConfiguration(
				project({
					...validConfig,
					discord: { ...validConfig.discord, token: "" },
				}),
			),
		);
		expect(text).toContain("config discord.token");
		expect(text).toContain("roundtable.config.ts");
	});
	test("names the closest known key for one it does not know", async () => {
		const text = failure(
			await checkConfiguration(project({ ...validConfig, modle: "x" })),
		);
		expect(text).toContain('Did you mean "model"');
	});
	test("fails with the loader's message when the file cannot be loaded", async () => {
		const failing = new Project(
			"/x",
			fakePorts(undefined, {
				loadConfig: async () => {
					throw new Error("roundtable.config.ts is not in /x");
				},
			}),
		);
		expect(failure(await checkConfiguration(failing))).toContain(
			"is not in /x",
		);
	});
	test("fails with the assembly's own message", async () => {
		const failing = new Project(
			"/x",
			fakePorts(validConfig, {
				define: async () => {
					throw new Error(
						"config prompts.shared: cannot read ./persona/shared.md",
					);
				},
			}),
		);
		expect(failure(await checkConfiguration(failing))).toContain(
			"prompts.shared",
		);
	});
});

describe("plugins", () => {
	const plugin = (name: string) => ({ name, setup: () => ({}) });
	const withPlugins = (names: string[]) =>
		new Project(
			"/x",
			fakePorts(
				{ ...validConfig, plugins: [plugin("hello")] },
				{
					define: async () => ({
						options: { logger: {} as never },
						plugins: names.map(plugin),
					}),
				},
			),
		);
	test("passes when every name is its own and lists the operator's", async () => {
		const result = await checkPlugins(withPlugins(["database", "hello"]));
		expect(result).toEqual({ status: "ok", detail: "yours: hello" });
	});
	test("fails on a repeated name and says to rename", async () => {
		const text = failure(
			await checkPlugins(withPlugins(["database", "hello", "hello"])),
		);
		expect(text).toContain("two plugins are named hello");
		expect(text).toContain("Rename");
	});
	test("is skipped while the configuration is invalid", async () => {
		const result = await checkPlugins(new Project("/x", fakePorts({})));
		expect(result.status).toBe("skipped");
	});
});

describe("model login", () => {
	const login = (source: string | undefined, seen: string[] = []) =>
		fakePorts(validConfig, {
			login: async (dir, provider) => {
				seen.push(`${dir} ${provider}`);
				return source;
			},
		});
	test("passes when the provider has a login and says where it comes from", async () => {
		const seen: string[] = [];
		const result = await checkModelLogin(
			new Project("/x", login("ANTHROPIC_API_KEY", seen)),
			login("ANTHROPIC_API_KEY", seen),
		);
		expect(result).toEqual({
			status: "ok",
			detail: "anthropic login from ANTHROPIC_API_KEY",
		});
		expect(seen).toEqual(["/data/pi anthropic"]);
	});
	test("fails when there is none, naming the provider, the model, and the ways to log in", async () => {
		const ports = login(undefined);
		const text = failure(
			await checkModelLogin(new Project("/x", ports), ports),
		);
		expect(text).toContain("no login for anthropic");
		expect(text).toContain("anthropic/claude-sonnet-5-5");
		expect(text).toContain("ANTHROPIC_API_KEY");
		expect(text).toContain("/data/pi/auth.json");
	});
	test("fails on a model that is not <provider>/<id>", async () => {
		const ports = fakePorts({ ...validConfig, model: "sonnet" });
		expect(
			failure(await checkModelLogin(new Project("/x", ports), ports)),
		).toContain("<provider>/<id>");
	});
	test("uses the configured agent directory", async () => {
		const seen: string[] = [];
		const ports = fakePorts(
			{ ...validConfig, agentDir: "/agents" },
			{
				login: async (dir) => {
					seen.push(dir);
					return "x";
				},
			},
		);
		await checkModelLogin(new Project("/x", ports), ports);
		expect(seen).toEqual(["/agents"]);
	});
});

describe("public URL", () => {
	const project = (url: unknown) =>
		new Project("/x", fakePorts({ ...validConfig, http: { publicUrl: url } }));
	test("passes a well-formed address without asking the network", async () => {
		const http = fakeHttp({});
		const result = await checkPublicUrl(
			project("https://bot.example.test"),
			http,
			false,
		);
		expect(result.status).toBe("ok");
		expect(http.requests).toEqual([]);
	});
	test("fails on something that is not a URL, showing an example", async () => {
		const text = failure(
			await checkPublicUrl(project("bot.example.test"), fakeHttp({}), false),
		);
		expect(text).toContain("not a URL");
		expect(text).toContain("https://bot.example.com");
	});
	test("fails on a scheme Discord cannot fetch from", async () => {
		expect(
			failure(
				await checkPublicUrl(
					project("ftp://bot.example.test"),
					fakeHttp({}),
					false,
				),
			),
		).toContain("http(s)");
	});
	test("with reachable, passes on any answer and fails when nothing answers", async () => {
		const answering = fakeHttp({ "/": { status: 404, body: undefined } });
		expect(
			await checkPublicUrl(
				project("https://bot.example.test"),
				answering,
				true,
			),
		).toEqual({
			status: "ok",
			detail: "https://bot.example.test answered 404",
		});
		const down = fakeHttp({ "/": new Error("connection refused") });
		const text = failure(
			await checkPublicUrl(project("https://bot.example.test"), down, true),
		);
		expect(text).toContain("connection refused");
		expect(text).toContain("roundtable start");
	});
});
