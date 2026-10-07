import { afterEach, describe, expect, test } from "bun:test";
import type { DefinedRoundtable } from "../core/define-roundtable.ts";
import type { DatabasePort } from "./checks/database.ts";
import { INVITE_PERMISSIONS } from "./discord-api.ts";
import { buildChecks, type DoctorInputs, doctor } from "./doctor.ts";
import { type Check, formatOutcomes, runChecks } from "./report.ts";
import { start } from "./start.ts";
import {
	fakeHttp,
	fakePorts,
	healthyDiscord,
	tempDir,
	validConfig,
} from "./testing/fixtures.ts";

const dirs: ReturnType<typeof tempDir>[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) dir.done();
});

const workingDatabase: DatabasePort = { check: async () => {} };
const bun = { version: "1.3.10", required: ">=1.3.0" };

function inputs(overrides: Partial<DoctorInputs> = {}): DoctorInputs {
	const dir = tempDir();
	dirs.push(dir);
	return {
		cwd: dir.path,
		env: {},
		bun,
		ports: fakePorts(),
		database: workingDatabase,
		http: fakeHttp({
			...healthyDiscord(INVITE_PERMISSIONS),
			"/": { status: 200, body: undefined },
		}),
		reachable: false,
		...overrides,
	};
}

describe("doctor", () => {
	test("lists the checks in the order the spec gives", () => {
		expect(buildChecks(inputs()).map((check) => check.name)).toEqual([
			"Bun",
			"environment",
			"configuration",
			"plugins",
			"image provider",
			"PostgreSQL",
			"Discord token",
			"Discord guild",
			"Discord intents",
			"Discord channel",
			"model login",
			"public URL",
		]);
	});

	test("passes on a healthy setup", async () => {
		const report = await doctor(inputs());
		expect(report.ok).toBe(true);
		expect(
			report.outcomes.every(({ result }) => result.status !== "fail"),
		).toBe(true);
	});

	test("fails when any check fails, and prints each check as passed or failed with its fix", async () => {
		const report = await doctor(
			inputs({
				ports: fakePorts(validConfig, { login: async () => undefined }),
			}),
		);
		expect(report.ok).toBe(false);
		const lines = formatOutcomes(report.outcomes);
		expect(lines.filter((line) => line.startsWith("✓"))).not.toHaveLength(0);
		const failed = lines.findIndex((line) => line.startsWith("✗ model login"));
		expect(failed).toBeGreaterThan(-1);
		expect(lines[failed + 1]).toStartWith("    ");
		expect(lines[failed + 1]).toContain("API key");
	});

	test("a missing credential fails the checks that need it and skips what depends on it, changing nothing", async () => {
		const incomplete = {
			...validConfig,
			discord: { ...validConfig.discord, token: "" },
		};
		const http = fakeHttp({});
		const report = await doctor(inputs({ ports: fakePorts(incomplete), http }));
		const byName = Object.fromEntries(
			report.outcomes.map(({ name, result }) => [name, result.status]),
		);
		expect(byName.configuration).toBe("fail");
		expect(byName["Discord token"]).toBe("skipped");
		expect(byName["Discord guild"]).toBe("skipped");
		expect(byName["Discord channel"]).toBe("skipped");
		expect(http.requests).toEqual([]);
		expect(report.ok).toBe(false);
	});

	test("a project without Discord skips the Discord checks without asking Discord anything", async () => {
		const { discord: _discord, http: _http, ...headless } = validConfig;
		const http = fakeHttp({});
		const report = await doctor(inputs({ ports: fakePorts(headless), http }));
		const byName = Object.fromEntries(
			report.outcomes.map(({ name, result }) => [name, result]),
		);
		for (const name of [
			"Discord token",
			"Discord guild",
			"Discord intents",
			"Discord channel",
		])
			expect(byName[name]).toEqual({
				status: "skipped",
				reason: "no Discord is configured",
			});
		expect(byName["public URL"]?.status).toBe("skipped");
		expect(byName.configuration?.status).toBe("ok");
		expect(http.requests).toEqual([]);
		expect(report.ok).toBe(true);
	});

	test("a project with a Discord adapter in adapters asks Discord as one with the top-level discord does", async () => {
		const { discord, ...rest } = validConfig;
		const report = await doctor(
			inputs({
				ports: fakePorts({
					...rest,
					adapters: [{ adapter: "discord", discord }],
				}),
			}),
		);
		const byName = Object.fromEntries(
			report.outcomes.map(({ name, result }) => [name, result.status]),
		);
		for (const name of [
			"configuration",
			"Discord token",
			"Discord guild",
			"Discord intents",
			"Discord channel",
			"public URL",
		])
			expect({ name, status: byName[name] }).toEqual({ name, status: "ok" });
		expect(report.ok).toBe(true);
	});

	test("a check that throws is reported as failed without hiding the ones after it", async () => {
		const checks: Check[] = [
			{
				name: "boom",
				offline: true,
				run: async () => {
					throw new Error("kaput");
				},
			},
			{ name: "fine", offline: true, run: async () => ({ status: "ok" }) },
		];
		const outcomes = await runChecks(checks);
		expect(outcomes.map(({ result }) => result.status)).toEqual(["fail", "ok"]);
		expect(formatOutcomes(outcomes).join("\n")).toContain("kaput");
	});

	test("asks the public address to answer only with reachable", async () => {
		const quiet = inputs();
		await doctor(quiet);
		expect((quiet.http as ReturnType<typeof fakeHttp>).requests).not.toContain(
			"/",
		);
		const asking = inputs({ reachable: true });
		await doctor(asking);
		expect((asking.http as ReturnType<typeof fakeHttp>).requests).toContain(
			"/",
		);
	});
});

describe("start", () => {
	const launched = () => {
		const seen: DefinedRoundtable[] = [];
		return {
			seen,
			launch: async (defined: DefinedRoundtable) => void seen.push(defined),
		};
	};

	test("runs only the checks that need no network, then starts the bot", async () => {
		const http = fakeHttp({});
		const { seen, launch } = launched();
		const report = await start({ ...inputs({ http }), launch });
		expect(report.started).toBe(true);
		expect(seen).toHaveLength(1);
		expect(http.requests).toEqual([]);
		expect(report.outcomes.map(({ name }) => name)).toEqual([
			"Bun",
			"environment",
			"configuration",
			"plugins",
			"image provider",
			"model login",
			"public URL",
		]);
	});

	test("a failing check stops it before anything launches, with the message doctor prints", async () => {
		const failing = inputs({
			ports: fakePorts(validConfig, { login: async () => undefined }),
		});
		const { seen, launch } = launched();
		const started = await start({ ...failing, launch });
		expect(started.started).toBe(false);
		expect(seen).toEqual([]);
		const fromDoctor = (await doctor(failing)).outcomes.find(
			({ name }) => name === "model login",
		);
		const fromStart = started.outcomes.find(
			({ name }) => name === "model login",
		);
		expect(fromStart).toEqual(fromDoctor as NonNullable<typeof fromDoctor>);
	});

	test("does not touch the network when the configuration is wrong", async () => {
		const http = fakeHttp({});
		const { seen, launch } = launched();
		const report = await start({
			...inputs({ ports: fakePorts({}), http }),
			launch,
		});
		expect(report.started).toBe(false);
		expect(seen).toEqual([]);
		expect(http.requests).toEqual([]);
	});
});
