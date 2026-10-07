import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfig } from "../core/config/config.ts";
import { factsTier, ownerOfFacts } from "../core/identity/access-policy.ts";
import type { ActorFacts } from "../core/identity/actor-facts.ts";
import { ConfigEditError } from "./config-edit.ts";
import { init } from "./init.ts";
import { lineDiff } from "./line-diff.ts";
import { CONFIG_FILE } from "./project.ts";
import { linkCheckout, tempDir, validConfig } from "./testing/fixtures.ts";
import { LEGACY_CONFIGS, TEMPLATE_0_8 } from "./testing/legacy-configs.ts";
import { upgrade } from "./upgrade.ts";
import { upgradeSource } from "./upgrade-source.ts";

const ROOT = resolve(import.meta.dir, "../..");
const TSC = join(ROOT, "node_modules/.bin/tsc");
const BIOME = join(ROOT, "node_modules/.bin/biome");

// Inside the checkout, so a configuration's imports resolve to this pi-roundtable.
const scratch = mkdtempSync(join(ROOT, "node_modules", ".upgrade-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let loaded = 0;
/** The configuration a source exports by default, loaded as the host would load it. */
async function load(source: string): Promise<unknown> {
	const path = join(scratch, `config-${loaded++}.ts`);
	writeFileSync(path, source);
	return ((await import(pathToFileURL(path).href)) as { default: unknown })
		.default;
}

/** What the host makes of a configuration: whom it serves, the primary owner, and what it warns of. */
async function meaning(source: string) {
	const config = resolveConfig(await load(source));
	return {
		access: config.access,
		primaryOwner: config.primaryOwner,
		discord: config.discord,
	};
}

describe("upgradeSource", () => {
	for (const [label, legacy] of Object.entries(LEGACY_CONFIGS))
		test(`${label}: the upgraded configuration means the same and warns of nothing`, async () => {
			const upgraded = upgradeSource(legacy);
			expect(upgraded.changes).not.toEqual([]);
			expect(upgraded.source).not.toContain("owner:");
			expect(upgraded.source).not.toContain("speakers:");
			expect(await meaning(upgraded.source)).toEqual(await meaning(legacy));
			expect(resolveConfig(await load(upgraded.source)).deprecations).toEqual(
				[],
			);
			// A second run finds nothing left to change.
			const again = upgradeSource(upgraded.source);
			expect(again.changes).toEqual([]);
			expect(again.source).toBe(upgraded.source);
		});

	test("an owner on a host without Discord gets no Discord identity, as the host reads them", () => {
		const upgraded = upgradeSource(LEGACY_CONFIGS["no Discord at all"] ?? "");
		expect(upgraded.source).not.toContain("identities");
		expect(upgraded.source).not.toContain("discord:operator");
		expect(upgraded.changes[0]).toContain("with no identity");
		const adapter = upgradeSource(
			LEGACY_CONFIGS["Discord already an adapter"] ?? "",
		);
		expect(adapter.source).toContain('identities: ["discord:');
	});

	test("writes the 0.8 template's owner as the 0.9 template writes access, word for word", () => {
		const upgraded = upgradeSource(TEMPLATE_0_8).source;
		const template = readFileSync(
			join(ROOT, "templates/roundtable.config.ts"),
			"utf8",
		);
		const block = /\taccess: \{\n[\s\S]*?\n\t\},\n/.exec(template)?.[0];
		expect(block).toBeDefined();
		expect(upgraded).toContain(block ?? "");
	});

	test("moves Discord into adapters, imports discord(), and keeps what its settings said", () => {
		const upgraded = upgradeSource(TEMPLATE_0_8).source;
		expect(upgraded).toContain(
			'import type { RoundtableConfig } from "pi-roundtable";\nimport { discord } from "pi-roundtable/discord";\nimport { agents } from "./agents.ts";',
		);
		expect(upgraded).toContain(
			'\tadapters: [\n\t\tdiscord({\n\t\t\ttoken: env("DISCORD_TOKEN"),\n\t\t\tguild: env("DISCORD_GUILD_ID"),\n\t\t\tentryChannel: env("DISCORD_ENTRY_CHANNEL_ID"),\n\t\t}),\n\t],\n',
		);
		expect(upgraded).not.toMatch(/^\tdiscord:/m);
	});

	test("keeps every comment, says which it moved, and leaves the others where they were", () => {
		const legacy =
			LEGACY_CONFIGS[
				"an exported constant, shorthand owner keys, everyone false, and comments"
			] ?? "";
		const upgraded = upgradeSource(legacy);
		for (const comment of [
			"// The owner runs the host.",
			"/* their first name */",
			"// Members by role.",
			"// only the role",
		])
			expect(upgraded.source).toContain(comment);
		expect(upgraded.notes).toEqual([expect.stringContaining("3 comments")]);
		// The owner's own comment still leads what replaced it.
		expect(upgraded.source).toContain("\t// The owner runs the host.\n");
	});

	const refused: Record<string, [string, string]> = {
		"an owner it cannot see into": [
			'const owner = { id: "1", name: "Ada" };\nexport default { owner, dataDir: "." };\n',
			"roundtable.config.ts:2:18: owner",
		],
		"a configuration spread from another object": [
			'const base = {};\nexport default { ...base, owner: { id: "1", name: "Ada" } };\n',
			"roundtable.config.ts:2:18",
		],
		"a list of users spread from another": [
			'const ids = ["1"];\nexport default {\n\towner: { id: "1", name: "Ada" },\n\tspeakers: { members: { users: [...ids] } },\n};\n',
			"roundtable.config.ts:4:33",
		],
		"an owner key it does not know": [
			'export default { owner: { id: "1", name: "Ada", nick: "A" } };\n',
			"roundtable.config.ts:1:49: owner.nick",
		],
		"access written beside owner": [
			'export default { owner: { id: "1", name: "Ada" }, access: { owners: [] } };\n',
			"not both",
		],
		"speakers without an owner": [
			"export default { speakers: { members: { everyone: true } } };\n",
			"speakers without owner",
		],
		"a discord name the file already binds": [
			'const discord = { token: "t", guild: "g", entryChannel: "c" };\nexport default { discord };\n',
			"the name discord is already used",
		],
		"no exported object": [
			"export default makeConfig();\n",
			"cannot find the configuration object",
		],
		"a file that does not parse": [
			"export default { owner: ",
			"does not parse",
		],
	};
	for (const [label, [source, message]] of Object.entries(refused))
		test(`refuses ${label}, changing nothing and saying where`, () => {
			expect(() => upgradeSource(source)).toThrow(ConfigEditError);
			expect(() => upgradeSource(source)).toThrow(message);
		});

	test("leaves a configuration already in the 0.9 form as it is", () => {
		const current = readFileSync(
			join(ROOT, "templates/roundtable.config.ts"),
			"utf8",
		).replace(/\tdiscord: \{[\s\S]*?\n\t\},\n/, "");
		expect(upgradeSource(current)).toEqual({
			source: current,
			changes: [],
			notes: [],
		});
	});
});

describe("the 0.8 form, hand-written access, and the upgrade's output", () => {
	const legacy = LEGACY_CONFIGS["literal ids, pronouns, and every tier"] ?? "";
	const handWritten = legacy.replace(
		/\towner:[\s\S]*?\n\t\},\n/,
		`\taccess: {
		owners: [
			{
				name: "Ada",
				pronouns: "she",
				principal: "900000000000000003",
				identities: ["discord:900000000000000003"],
			},
		],
		admins: {
			identities: ["discord:900000000000000004"],
			roles: ["discord:role:900000000000000005"],
		},
		members: {
			roles: ["discord:role:900000000000000006", "discord:role:900000000000000007"],
			everyone: ["discord"],
		},
	},
`,
	);
	/** Who reaches the host, by what their surface reports. */
	const ACTORS: [string, ActorFacts][] = [
		[
			"the owner",
			{ provider: "discord", subject: "900000000000000003", name: "Ada" },
		],
		[
			"an admin by id",
			{ provider: "discord", subject: "900000000000000004", name: "Bo" },
		],
		[
			"an admin by role",
			{
				provider: "discord",
				subject: "900000000000000010",
				name: "Cy",
				roles: ["discord:role:900000000000000005"],
			},
		],
		[
			"a member by role",
			{
				provider: "discord",
				subject: "900000000000000011",
				name: "Di",
				roles: ["discord:role:900000000000000007"],
			},
		],
		[
			"anyone on Discord",
			{ provider: "discord", subject: "900000000000000012", name: "Ed" },
		],
		[
			"someone on the web",
			{
				provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS50ZXN0",
				subject: "u-1",
				name: "Fa",
				surface: "web",
			},
		],
	];
	const tiers = async (source: string) => {
		const { access } = resolveConfig(await load(source));
		return ACTORS.map(([who, facts]) => [
			who,
			ownerOfFacts(access, facts)
				? "owner"
				: (factsTier(access, facts) ?? "none"),
		]);
	};

	test("give every actor the same tier, row by row", async () => {
		const expected = [
			["the owner", "owner"],
			["an admin by id", "admin"],
			["an admin by role", "admin"],
			["a member by role", "member"],
			["anyone on Discord", "member"],
			["someone on the web", "none"],
		];
		expect(await tiers(legacy)).toEqual(expected);
		expect(await tiers(handWritten)).toEqual(expected);
		expect(await tiers(upgradeSource(legacy).source)).toEqual(expected);
	});
});

describe("lineDiff", () => {
	test("shows the changed lines with three lines around them, as a unified diff", () => {
		const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
		const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i"].join("\n");
		expect(lineDiff(before, after, "x.ts")).toEqual([
			"--- x.ts",
			"+++ x.ts (upgraded)",
			"@@ -2,7 +2,7 @@",
			" b",
			" c",
			" d",
			"-e",
			"+E",
			" f",
			" g",
			" h",
		]);
	});
});

describe("roundtable upgrade on a 0.8 project", () => {
	const dir = tempDir("roundtable-upgrade-");
	afterAll(() => dir.done());
	const ENV = {
		OWNER_ID: "900000000000000003",
		OWNER_NAME: "Ada",
		DISCORD_TOKEN: "bot-token",
		DISCORD_GUILD_ID: "900000000000000001",
		DISCORD_ENTRY_CHANNEL_ID: "900000000000000002",
		DATABASE_URL: "postgres://roundtable@localhost:5432/roundtable",
		MODEL: "anthropic/claude-sonnet-5-5",
		PUBLIC_URL: "https://bot.example.test",
	};
	const config = () => readFileSync(join(dir.path, CONFIG_FILE), "utf8");
	/** The command line itself, in the project, its ids coming from `.env` as Bun loads it. */
	const roundtable = (...args: string[]) => {
		const ran = Bun.spawnSync(
			["bun", join(ROOT, "src/cli/main.ts"), "upgrade", ...args],
			{
				cwd: dir.path,
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
			},
		);
		return {
			code: ran.exitCode,
			out: ran.stdout.toString(),
			err: ran.stderr.toString(),
		};
	};

	test("shows the diff and writes nothing without --write, then writes, then has nothing left", () => {
		const made = init({
			cwd: dir.path,
			bun: { version: Bun.version, required: ">=1.3.0" },
			version: "0.8.0",
		});
		expect(made.ok).toBe(true);
		linkCheckout(dir.path);
		writeFileSync(join(dir.path, CONFIG_FILE), TEMPLATE_0_8);
		writeFileSync(
			join(dir.path, ".env"),
			Object.entries(ENV)
				.map(([name, value]) => `${name}=${value}\n`)
				.join(""),
		);

		const preview = roundtable();
		expect(preview.err).toBe("");
		expect(preview.code).toBe(0);
		expect(config()).toBe(TEMPLATE_0_8);
		const lines = preview.out.split("\n");
		expect(lines).toContain(
			'-\towner: { id: env("OWNER_ID"), name: env("OWNER_NAME") },',
		);
		expect(lines).toContain("+\taccess: {");
		expect(preview.out).toContain(
			"Checked: the rewrite serves the same owners, admins, and members, with the same Discord settings.",
		);
		expect(preview.out).toContain("Nothing was written.");

		const written = roundtable("--write");
		expect(written.code).toBe(0);
		expect(written.out).toContain("Wrote roundtable.config.ts");
		expect(config()).not.toBe(TEMPLATE_0_8);
		// No file is left behind from checking the rewrite.
		expect(
			readdirSync(dir.path).filter((name) => name.includes("upgrade")),
		).toEqual([]);

		const again = roundtable("--write");
		expect(again.code).toBe(0);
		expect(again.out).toContain("already in the 0.9 form");
	}, 60_000);

	test("the upgraded project typechecks and passes the linter it ships with", () => {
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
		const typecheck = run([TSC, "--noEmit"]);
		expect(typecheck.output).toBe("");
		const lint = run([BIOME, "check", "."]);
		expect(lint.output).toContain("No fixes applied");
		expect(typecheck.ok && lint.ok).toBe(true);
	}, 120_000);

	test("refuses to write a rewrite that would change whom the host serves", async () => {
		const other = tempDir("roundtable-upgrade-guard-");
		try {
			other.write(CONFIG_FILE, TEMPLATE_0_8);
			// A loader that reads the rewrite as a different owner than the original.
			let calls = 0;
			const report = await upgrade({
				cwd: other.path,
				write: true,
				load: async () =>
					calls++ === 0
						? validConfig
						: {
								...validConfig,
								owner: { id: "900000000000000009", name: "Ada" },
							},
			});
			expect(report.ok).toBe(false);
			if (!report.ok)
				expect(report.problems.join("\n")).toContain(
					"would change whom the host serves",
				);
			expect(readFileSync(join(other.path, CONFIG_FILE), "utf8")).toBe(
				TEMPLATE_0_8,
			);
		} finally {
			other.done();
		}
	});
});
