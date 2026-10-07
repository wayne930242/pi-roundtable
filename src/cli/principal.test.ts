import { afterEach, beforeEach, expect, test } from "bun:test";
import { migrate } from "../core/db/migrations.ts";
import { PgIdentityService } from "../core/identity/identity-service.ts";
import {
	PgPrincipalStore,
	PRINCIPAL_TABLES,
} from "../core/identity/principal-store.ts";
import { silentLogger } from "../core/log.ts";
import { describeDb } from "../core/testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../core/testing/fixture-database.ts";
import { type CliEnvironment, runCli } from "./cli.ts";
import { HOST_DELAY } from "./principal.ts";
import { fakePorts, tempDir, validConfig } from "./testing/fixtures.ts";

const OWNER = "966666600000000001";
const WEB = "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user-7";

let db: ScratchDatabase | undefined;
const dirs: ReturnType<typeof tempDir>[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) dir.done();
	await db?.drop();
	db = undefined;
});

/** Runs `roundtable principal ...` against the scratch database, as the project's configuration names it. */
async function principal(...args: string[]) {
	const dir = tempDir();
	dirs.push(dir);
	const out: string[] = [];
	const err: string[] = [];
	const io: CliEnvironment = {
		cwd: dir.path,
		env: {},
		bun: () => ({ version: "1.3.10", required: ">=1.3.0" }),
		version: () => "1.2.3",
		ports: fakePorts({
			...validConfig,
			database: { url: db?.url ?? "postgres://nowhere.example.test/x" },
		}),
		packages: {
			install: async () => ({ ok: true, output: "" }),
			tools: async () => [],
		},
		launch: async () => {},
		out: (line) => out.push(line),
		err: (line) => err.push(line),
	};
	const code = await runCli(["principal", ...args], io);
	return { code, out: out.join("\n"), err: err.join("\n") };
}

/** The identity service a host starting now would run, over the same database. */
function freshHost(): Promise<PgIdentityService> {
	const sql = db?.sql;
	if (!sql) throw new Error("no database");
	return PgPrincipalStore.attach(sql).then(
		(store) =>
			new PgIdentityService(
				store,
				{
					owners: [
						{
							name: "Ada",
							principal: OWNER,
							identities: [`discord:${OWNER}`],
						},
					],
					provisioning: "linked",
					backgroundStaleDays: 30,
				},
				{ logger: silentLogger() },
			),
	);
}

describeDb("roundtable principal", () => {
	beforeEach(async () => {
		db = await scratchDatabase();
		await migrate(db.sql, [
			{ name: "identity/principals", up: PRINCIPAL_TABLES },
		]);
		const host = await freshHost();
		await host.syncConfig();
	});

	test("list prints each principal with its roles and its identities as configuration takes them", async () => {
		const store = await PgPrincipalStore.attach(db?.sql as never);
		await store.create({ id: WEB, displayName: "Kai", pronouns: "he" });
		await store.link(
			WEB,
			{ provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20", subject: "user-7" },
			"legacy",
		);
		const { code, out } = await principal("list");
		expect(code).toBe(0);
		const lines = out.split("\n");
		expect(lines).toContain(`${OWNER}  Ada  roles: owner (config)`);
		expect(lines).toContain(`    discord:${OWNER}  (config)`);
		expect(lines).toContain(`${WEB}  Kai (he)  roles: none`);
		expect(lines).toContain(`    ${WEB}  (legacy)`);
		expect(out).toContain("2 principals");
	});

	test("create, link, grant: the next host resolves the identity to the principal at the granted tier", async () => {
		const made = await principal(
			"create",
			"--name",
			"Mo",
			"--pronouns",
			"they",
		);
		expect(made.code).toBe(0);
		const id = /principal (p_[0-9A-Z]+)/.exec(made.out)?.[1] ?? "";
		expect(id).toStartWith("p_");
		expect(made.out).toContain(HOST_DELAY);

		const linked = await principal("link", id, "discord:966666600000000009");
		expect(linked.code).toBe(0);
		expect(linked.out).toContain(
			`Linked discord:966666600000000009 to principal ${id} (Mo).`,
		);
		expect(linked.out).toContain(HOST_DELAY);
		expect((await principal("grant", id, "admin")).code).toBe(0);

		const host = await freshHost();
		const facts = {
			provider: "discord",
			subject: "966666600000000009",
			name: "Mo",
		};
		expect(await host.resolve(facts)).toMatchObject({
			principalId: id,
			tier: "admin",
		});

		const shown = await principal("show", "discord:966666600000000009");
		expect(shown.code).toBe(0);
		expect(shown.out).toContain(`principal ${id}`);
		expect(shown.out).toContain("name: Mo (they)");
		expect(shown.out).toContain("roles: admin (cli)");
		expect(shown.out).toContain("    discord:966666600000000009  (cli,");
	});

	test("disable stops a principal being served, enable brings them back", async () => {
		expect((await principal("disable", OWNER)).code).toBe(0);
		const facts = { provider: "discord", subject: OWNER, name: "Ada" };
		expect(await (await freshHost()).resolve(facts)).toBeUndefined();
		expect((await principal("show", OWNER)).out).toContain("status: disabled");
		expect((await principal("enable", OWNER)).code).toBe(0);
		expect(await (await freshHost()).resolve(facts)).toMatchObject({
			tier: "owner",
		});
	});

	test("owner is granted here as the CLI's, and revoked; the configuration's own grant is not revoked here", async () => {
		const made = await principal("create", "--name", "Bea");
		const id = /principal (p_[0-9A-Z]+)/.exec(made.out)?.[1] ?? "";
		const granted = await principal("grant", id, "owner");
		expect(granted.code).toBe(0);
		expect(granted.out).toContain("only here and in the configuration");
		expect((await principal("show", id)).out).toContain("roles: owner (cli)");
		expect((await principal("revoke", id, "owner")).code).toBe(0);
		expect((await principal("show", id)).out).toContain("roles: none");

		const refused = await principal("revoke", OWNER, "owner");
		expect(refused.code).toBe(1);
		expect(refused.err).toContain("access.owners");
		expect((await principal("show", OWNER)).out).toContain(
			"roles: owner (config)",
		);
	});

	test("unlink removes a link and says when the configuration links it again", async () => {
		const unlinked = await principal("unlink", `discord:${OWNER}`);
		expect(unlinked.code).toBe(0);
		expect(unlinked.out).toContain("The configuration lists it");
		expect((await principal("show", OWNER)).out).toContain("identities: none");
	});

	test("refuses what it cannot do, saying why, and changes nothing", async () => {
		const cases: [string[], string][] = [
			[["show", "nobody"], "no principal nobody"],
			[["link", OWNER, "not-an-identity"], "<provider>:<subject>"],
			[["link", "nobody", "discord:966666600000000009"], "no principal nobody"],
			[["grant", OWNER, "superuser"], "member, admin, or owner"],
			[["revoke", OWNER, "admin"], "does not hold admin"],
			[["unlink", "discord:966666600000000008"], "is not linked"],
			[["create"], "--name"],
			[["create", "--name", "X", "--pronouns", "xe"], "he, she, or they"],
			[["frobnicate"], "roundtable principal list"],
			[["list", "extra"], "roundtable principal list"],
		];
		for (const [args, problem] of cases) {
			const ran = await principal(...args);
			expect(ran.code).toBe(1);
			expect(ran.err).toContain(problem);
		}
		const taken = await principal("create", "--name", "Mo");
		const id = /principal (p_[0-9A-Z]+)/.exec(taken.out)?.[1] ?? "";
		const clash = await principal("link", id, `discord:${OWNER}`);
		expect(clash.code).toBe(1);
		expect(clash.err).toContain(`already linked to principal ${OWNER}`);
	});
});

describeDb("roundtable principal before the host made its tables", () => {
	test("says to start the host once", async () => {
		db = await scratchDatabase();
		const ran = await principal("list");
		expect(ran.code).toBe(1);
		expect(ran.err).toContain("start the host");
	});
});

test("without a database in the configuration it says so", async () => {
	const dir = tempDir();
	dirs.push(dir);
	const err: string[] = [];
	const code = await runCli(["principal", "list"], {
		cwd: dir.path,
		env: {},
		bun: () => ({ version: "1.3.10", required: ">=1.3.0" }),
		version: () => "1.2.3",
		ports: fakePorts({ ...validConfig, database: { url: "" } }),
		packages: {
			install: async () => ({ ok: true, output: "" }),
			tools: async () => [],
		},
		launch: async () => {},
		out: () => {},
		err: (line) => err.push(line),
	});
	expect(code).toBe(1);
	expect(err.join("\n")).toContain("database.url");
});
