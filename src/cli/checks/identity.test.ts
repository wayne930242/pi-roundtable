import { afterEach, describe, expect, test } from "bun:test";
import { resolveConfig } from "../../core/config/config.ts";
import { runMigrations } from "../../core/db/migrations.ts";
import { identityPlugin } from "../../core/identity/identity-plugin.ts";
import { PgPrincipalStore } from "../../core/identity/principal-store.ts";
import type { PluginContext, RoundtablePlugin } from "../../core/plugin.ts";
import { describeDb } from "../../core/testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../../core/testing/fixture-database.ts";
import { recordingLogger } from "../../core/testing/recording-logger.ts";
import { Project } from "../project.ts";
import { fakePorts, validConfig } from "../testing/fixtures.ts";
import { type DatabasePort, postgres } from "./database.ts";
import { checkAccess, checkPrincipals } from "./identity.ts";

/** The owner of the 0.8.0 fixture (scripts/fixture-db.ts). */
const OWNER = "966666600000000001";
const TOKEN = "token:remote-mcp";

/** A project whose configuration is `config`, assembled with these plugins. */
function project(
	config: unknown,
	plugins: Pick<RoundtablePlugin, "name" | "identities">[] = [],
): Project {
	return new Project(
		"/x",
		fakePorts(config, {
			define: async () => ({
				options: { logger: {} as never },
				plugins: plugins.map((plugin) => ({ ...plugin, setup: () => ({}) })),
			}),
		}),
	);
}

const accessConfig = (members: Record<string, unknown>) => {
	const { owner: _owner, ...rest } = validConfig;
	return {
		...rest,
		access: {
			owners: [
				{
					name: "Ada",
					principal: OWNER,
					identities: [`discord:${OWNER}`],
				},
			],
			members,
		},
	};
};

describe("the access check", () => {
	test("warns when everyone is admitted on every surface and the host has more than one", async () => {
		const result = await checkAccess(
			project(accessConfig({ everyone: true }), [{ name: "webchat" }]),
		);
		expect(result.status).toBe("warn");
		if (result.status === "warn") {
			expect(result.problem).toContain("access.members.everyone is true");
			expect(result.problem).toContain("discord and web");
			expect(result.fix).toContain('everyone: ["discord"]');
		}
	});

	test("passes everyone on one named surface, everyone on the only surface, and the 0.8 form", async () => {
		for (const config of [
			accessConfig({ everyone: ["discord"] }),
			validConfig,
			{ ...validConfig, speakers: { members: { everyone: true } } },
		])
			expect(
				(await checkAccess(project(config, [{ name: "webchat" }]))).status,
			).toBe("ok");
		expect(
			(await checkAccess(project(accessConfig({ everyone: true })))).status,
		).toBe("ok");
	});

	test("says how many owners there are and that the 0.8 form is deprecated", async () => {
		const result = await checkAccess(project(validConfig));
		expect(result).toEqual({
			status: "ok",
			detail:
				"1 owner, Ada; written as the 0.8 owner and speakers, which roundtable upgrade rewrites as access",
		});
	});

	test("is skipped while the configuration is not valid", async () => {
		expect((await checkAccess(project({}))).status).toBe("skipped");
	});
});

const unreachable: DatabasePort = {
	check: async () => {},
	read: async () => {
		throw new Error("connection refused");
	},
};

describe("the principals check without a database", () => {
	test("is skipped when the database does not answer; the PostgreSQL check reports that", async () => {
		const result = await checkPrincipals(project(validConfig), unreachable);
		expect(result).toEqual({
			status: "skipped",
			reason: "PostgreSQL did not answer (connection refused)",
		});
	});
});

let db: ScratchDatabase | undefined;
afterEach(async () => {
	await db?.drop();
	db = undefined;
});

describeDb("the principals check", () => {
	const withDatabase = (url: string) => ({
		...accessConfig({}),
		database: { url },
	});

	/** Starts the identity plugin once on the scratch database, with these plugins' identities. */
	async function bootWith(
		scratch: ScratchDatabase,
		config: ReturnType<typeof withDatabase>,
		plugins: Pick<RoundtablePlugin, "name" | "identities">[],
	): Promise<void> {
		const plugin = identityPlugin({
			rules: resolveConfig(config).access,
			plugins: plugins.map((made) => ({ ...made, setup: () => ({}) })),
		});
		await runMigrations(scratch.sql, [plugin]);
		const sql = scratch.sql;
		await plugin.setup?.({
			logger: recordingLogger().logger,
			database: () => sql,
			services: { provide: () => {} },
		} as unknown as PluginContext);
	}

	test("on a 0.8.0 database, prints the backfill the next start logs, word for word", async () => {
		db = await scratchDatabase("0.8.0");
		const config = withDatabase(db.url);
		const result = await checkPrincipals(project(config), postgres);
		expect(result.status).toBe("ok");
		const detail = result.status === "ok" ? (result.detail ?? "") : "";
		expect(detail).toStartWith("dry run, nothing written: ");
		// The doctor wrote nothing.
		expect(
			(await db.sql`SELECT to_regclass('principals') AS made`)[0]?.made,
		).toBeNull();

		const plugin = identityPlugin({ rules: resolveConfig(config).access });
		await runMigrations(db.sql, [plugin]);
		const { logger, lines } = recordingLogger();
		const sql = db.sql;
		await plugin.setup?.({
			logger,
			database: () => sql,
			services: { provide: () => {} },
		} as unknown as PluginContext);
		expect(lines.map((line) => line.message)).toContain(
			detail.replace("dry run, nothing written: ", ""),
		);
		// After the start, the dry run makes nothing more.
		const after = await checkPrincipals(project(config), postgres);
		expect(after.status === "ok" && after.detail).toContain("0 created");
	});

	test("fails when a configured owner's identity is linked to another principal, saying how to unlink it", async () => {
		db = await scratchDatabase("0.8.0");
		const config = withDatabase(db.url);
		await runMigrations(db.sql, [
			identityPlugin({ rules: resolveConfig(config).access }),
		]);
		const store = await PgPrincipalStore.attach(db.sql);
		await store.create({ id: "966666600000000005b", displayName: "Kai" });
		await store.link(
			"966666600000000005b",
			{ provider: "discord", subject: OWNER },
			"cli",
		);
		const result = await checkPrincipals(project(config), postgres);
		expect(result.status).toBe("fail");
		if (result.status === "fail") {
			expect(result.problem).toContain(
				`access.owners[0].identities[0]: discord:${OWNER} is linked to principal 966666600000000005b`,
			);
			expect(result.fix).toContain(
				`roundtable principal unlink discord:${OWNER}`,
			);
		}
	});

	test("fails when a configured owner without a principal lists a plugin's identity, saying to remove it or bind the plugin", async () => {
		const scratch = await scratchDatabase("0.8.0");
		db = scratch;
		const base = withDatabase(scratch.url);
		const remote = [{ name: "remote-mcp", identities: [{ identity: TOKEN }] }];
		await bootWith(scratch, base, remote);
		const bob = {
			name: "Bob",
			identities: [TOKEN, "discord:966666600000000004"],
		};
		const config = {
			...base,
			access: { ...base.access, owners: [...base.access.owners, bob] },
		};
		const result = await checkPrincipals(project(config, remote), postgres);
		expect(result.status).toBe("fail");
		if (result.status === "fail") {
			expect(result.problem).toContain(
				`access.owners[1].identities[0]: ${TOKEN} is an identity plugin remote-mcp declares, bound to principal ${OWNER}`,
			);
			expect(result.fix).toContain(
				"Remove it from access.owners[1].identities, or give this owner its principal and bind plugin remote-mcp to it",
			);
			expect(result.fix).not.toContain("roundtable principal unlink");
		}
	});

	test("fails when a configured owner lists a plugin's identity bound to someone else, pointing at the plugin's options", async () => {
		const scratch = await scratchDatabase("0.8.0");
		db = scratch;
		const base = withDatabase(scratch.url);
		const remote = [{ name: "remote-mcp", identities: [{ identity: TOKEN }] }];
		await bootWith(scratch, base, remote);
		const bo = {
			name: "Bo",
			principal: "966666600000000004",
			identities: [TOKEN],
		};
		const config = {
			...base,
			access: { ...base.access, owners: [...base.access.owners, bo] },
		};
		const result = await checkPrincipals(project(config, remote), postgres);
		expect(result.status).toBe("fail");
		if (result.status === "fail") {
			expect(result.problem).toContain(
				`access.owners[1].identities[0]: ${TOKEN} is an identity plugin remote-mcp declares, bound to principal ${OWNER}, not to this owner's 966666600000000004`,
			);
			expect(result.fix).toBe(
				"Remove it from access.owners[1].identities, or bind plugin remote-mcp to 966666600000000004 in its options",
			);
		}
	});

	test("warns when no owner can reach the host because every owner is disabled", async () => {
		db = await scratchDatabase("0.8.0");
		const config = withDatabase(db.url);
		await runMigrations(db.sql, [
			identityPlugin({ rules: resolveConfig(config).access }),
		]);
		// The backfill made the configured owner's principal.
		await (await PgPrincipalStore.attach(db.sql)).disable(OWNER);
		const result = await checkPrincipals(project(config), postgres);
		expect(result.status).toBe("warn");
		if (result.status === "warn") {
			expect(result.problem).toContain("no owner can reach the host");
			expect(result.fix).toContain(`roundtable principal enable ${OWNER}`);
			expect(result.fix).toContain("dry run, nothing written: ");
		}
	});
});
