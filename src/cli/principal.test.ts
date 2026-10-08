import { afterEach, beforeEach, expect, test } from "bun:test";
import { migrate } from "../core/db/migrations.ts";
import { PgIdentityService } from "../core/identity/identity-service.ts";
import type { DeclaredIdentity } from "../core/identity/plugin-identities.ts";
import { PgPrincipalStore } from "../core/identity/principal-store.ts";
import {
	PRINCIPAL_PLUGIN_LINKS,
	PRINCIPAL_TABLES,
	PRINCIPALS_CLAIMABLE,
} from "../core/identity/principal-tables.ts";
import { silentLogger } from "../core/log.ts";
import { describeDb } from "../core/testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../core/testing/fixture-database.ts";
import { type CliEnvironment, runCli } from "./cli.ts";
import { HOST_DELAY } from "./principal.ts";
import type { Ports } from "./project.ts";
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

/** The owner the project's configuration names, as the host of `freshHost` reads it. */
const OWNERS = [
	{ name: "Ada", principal: OWNER, identities: [`discord:${OWNER}`] },
];

/** The project's configuration: the test's database, and `access` owners as given. */
let access: unknown;
/** The project's plugins, when the test gives any. */
let plugins: unknown;
/** What the project's ports do beyond loading it, such as a plugin that fails to assemble. */
let overrides: Partial<Ports>;
beforeEach(() => {
	access = { owners: OWNERS };
	plugins = undefined;
	overrides = {};
});

/** A plugin of the project's configuration that declares the dispatch token of remote MCP. */
const remotePlugin = (principal?: string) => ({
	name: "remote-mcp",
	identities: [
		{ identity: "token:remote-mcp", ...(principal ? { principal } : {}) },
	],
	setup: () => ({}),
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
		ports: fakePorts(
			{
				...(({ owner: _, ...rest }) => rest)(validConfig),
				access,
				...(plugins === undefined ? {} : { plugins }),
				database: { url: db?.url ?? "postgres://nowhere.example.test/x" },
			},
			overrides,
		),
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

/** The identity service a host starting now would run, over the same database, with the plugins' identities. */
function freshHost(
	identities: readonly DeclaredIdentity[] = [],
): Promise<PgIdentityService> {
	const sql = db?.sql;
	if (!sql) throw new Error("no database");
	return PgPrincipalStore.attach(sql).then(
		(store) =>
			new PgIdentityService(
				store,
				{
					owners: OWNERS,
					provisioning: "linked",
					backgroundStaleDays: 30,
				},
				{ logger: silentLogger(), identities },
			),
	);
}

describeDb("roundtable principal", () => {
	beforeEach(async () => {
		db = await scratchDatabase();
		await migrate(db.sql, [
			{ name: "identity/principals", up: PRINCIPAL_TABLES },
			{ name: "identity/principals-claimable", up: PRINCIPALS_CLAIMABLE },
			{ name: "identity/principals-plugin-links", up: PRINCIPAL_PLUGIN_LINKS },
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
		const bare = await principal("create", "--name", "Lu");
		expect(bare.out).toContain("(Lu).");
		const id = /principal (p_[0-9A-Z]+)/.exec(bare.out)?.[1] ?? "";
		const listed = (await principal("list")).out;
		expect(listed).toContain(
			`    no identity linked yet; link one with roundtable principal link ${id} <provider>:<subject>`,
		);
		expect(listed).not.toContain("carried over from 0.8");
	});

	test("list says a principal carried over from 0.8 links its own identity only while it is claimable, and link says it uses that up", async () => {
		const sql = db?.sql;
		if (!sql) throw new Error("no database");
		const store = await PgPrincipalStore.attach(sql);
		await store.create({ id: "966666600000000007", displayName: "Kai" });
		await sql`UPDATE principals SET claimable = true WHERE id = '966666600000000007'`;
		expect((await principal("list")).out).toContain(
			"    no identity linked yet; carried over from 0.8, so 966666600000000007 links its own at its first contact",
		);

		const linked = await principal(
			"link",
			"966666600000000007",
			"token:remote-mcp",
		);
		expect(linked.code).toBe(0);
		expect(linked.out).toContain(
			"This uses up the 0.8 claim of principal 966666600000000007: its 0.8 id no longer links its own identity at first contact, even once this one is unlinked. Link each of their other identities here.",
		);
		expect((await store.get("966666600000000007"))?.claimable).toBe(false);
		expect((await principal("unlink", "token:remote-mcp")).code).toBe(0);
		const listed = (await principal("list")).out;
		expect(listed).not.toContain("carried over from 0.8");

		// A principal that was never claimable is linked without the warning.
		const again = await principal(
			"link",
			"966666600000000007",
			"token:remote-mcp",
		);
		expect(again.out).not.toContain("0.8 claim");
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

	test("grant of a role the configuration already gives changes nothing, so grant then revoke cannot take it away", async () => {
		const granted = await principal("grant", OWNER, "owner");
		expect(granted.code).toBe(0);
		expect(granted.out).toContain(
			`principal ${OWNER} (Ada) already holds owner, granted by the configuration; nothing changed.`,
		);
		expect(granted.out).not.toContain(HOST_DELAY);
		expect((await principal("show", OWNER)).out).toContain(
			"roles: owner (config)",
		);
		const refused = await principal("revoke", OWNER, "owner");
		expect(refused.code).toBe(1);
		expect(refused.err).toContain("access.owners");
		expect((await principal("show", OWNER)).out).toContain(
			"roles: owner (config)",
		);
	});

	test("unlink removes a link the CLI made, and refuses one the configuration makes", async () => {
		const refused = await principal("unlink", `discord:${OWNER}`);
		expect(refused.code).toBe(1);
		expect(refused.err).toContain(
			`discord:${OWNER} is linked to principal ${OWNER}, which the configuration lists under an owner;`,
		);
		expect(refused.err).toContain(
			"remove it from access.owners[*].identities in roundtable.config.ts instead",
		);
		expect(refused.err).not.toContain("links it again");
		expect((await principal("show", OWNER)).out).toContain(
			`    discord:${OWNER}  (config,`,
		);

		expect(
			(await principal("link", OWNER, "discord:966666600000000010")).code,
		).toBe(0);
		const unlinked = await principal("unlink", "discord:966666600000000010");
		expect(unlinked.code).toBe(0);
		expect(unlinked.out).toContain(
			`Unlinked discord:966666600000000010 from principal ${OWNER}.`,
		);
		expect((await principal("show", OWNER)).out).not.toContain(
			"discord:966666600000000010",
		);
	});

	test("list and show name the plugin that declares an identity linked as a plugin's, and one no plugin declares any more", async () => {
		await (
			await freshHost([{ plugin: "remote-mcp", identity: "token:remote-mcp" }])
		).syncConfig();
		plugins = [remotePlugin()];
		expect((await principal("list")).out.split("\n")).toContain(
			"    token:remote-mcp  (plugin remote-mcp)",
		);
		expect((await principal("show", OWNER)).out).toContain(
			"    token:remote-mcp  (plugin remote-mcp, linked ",
		);
		plugins = [];
		expect((await principal("list")).out.split("\n")).toContain(
			"    token:remote-mcp  (plugin, which no plugin declares any more: the next start unlinks it)",
		);
		access = { owners: [{ name: "Ada", identities: ["not-an-identity"] }] };
		expect((await principal("list")).out.split("\n")).toContain(
			"    token:remote-mcp  (plugin)",
		);
	});

	test("unlink refuses an identity a plugin declares, and takes one no plugin declares any more", async () => {
		await (
			await freshHost([{ plugin: "remote-mcp", identity: "token:remote-mcp" }])
		).syncConfig();
		plugins = [remotePlugin()];
		const refused = await principal("unlink", "token:remote-mcp");
		expect(refused.code).toBe(1);
		expect(refused.err).toBe(
			`token:remote-mcp is linked to principal ${OWNER} as an identity plugin remote-mcp declares; change that plugin's options in roundtable.config.ts instead, and the next start moves or unlinks it`,
		);
		access = { owners: [{ name: "Ada", identities: ["not-an-identity"] }] };
		const unknown = await principal("unlink", "token:remote-mcp");
		expect(unknown.code).toBe(1);
		expect(unknown.err).toContain(
			"roundtable.config.ts does not load here to say whether a plugin still declares it",
		);
		access = { owners: OWNERS };
		plugins = [];
		const taken = await principal("unlink", "token:remote-mcp");
		expect(taken.code).toBe(0);
		expect(taken.out).toContain(
			`Unlinked token:remote-mcp from principal ${OWNER}.`,
		);
	});

	test("unlink takes a configuration link the configuration no longer backs, as a start that fails on it asks", async () => {
		// The configuration moved the identity to another owner: the start stops on it until it is unlinked.
		access = {
			owners: [
				{
					name: "Bea",
					principal: "966666600000000020",
					identities: [`discord:${OWNER}`],
				},
			],
		};
		const moved = await principal("unlink", `discord:${OWNER}`);
		expect(moved.code).toBe(0);
		expect(moved.out).toContain(
			`Unlinked discord:${OWNER} from principal ${OWNER}.`,
		);
		expect(moved.out).toContain(
			"The configuration lists it under another owner, which a running host does not read: stop the host, then start it with this configuration. If a new p_… principal appears with this identity before then, unlink it again.",
		);
		expect(moved.out).not.toContain("the next start links it to them");
	});

	test("unlink refuses an identity the configuration lists under an owner, whoever linked it", async () => {
		const store = await PgPrincipalStore.attach(db?.sql as never);
		for (const source of ["jit", "cli", "legacy"] as const) {
			const subject = `96666660000000003${["jit", "cli", "legacy"].indexOf(source)}`;
			const member = await store.create({ displayName: `Mel-${source}` });
			await store.link(member.id, { provider: "discord", subject }, source);
			// A member promoted to owner by their identity, as written before the next start.
			access = {
				owners: [
					...OWNERS,
					{ name: `Mel-${source}`, identities: [`discord:${subject}`] },
				],
			};
			const refused = await principal("unlink", `discord:${subject}`);
			expect(refused.code).toBe(1);
			expect(refused.err).toContain(
				`discord:${subject} is linked to principal ${member.id}, which the configuration lists under an owner;`,
			);
			expect(refused.err).toContain(
				"remove it from access.owners[*].identities in roundtable.config.ts instead",
			);
			expect((await principal("show", member.id)).out).toContain(
				`    discord:${subject}  (${source},`,
			);
		}
	});

	test("unlink reads the owners even when a plugin of the configuration fails to assemble", async () => {
		overrides = {
			define: async () => {
				throw new Error("plugin exploded");
			},
		};
		access = {
			owners: [
				{
					name: "Bea",
					principal: "966666600000000020",
					identities: [`discord:${OWNER}`],
				},
			],
		};
		const moved = await principal("unlink", `discord:${OWNER}`);
		expect(moved.err).not.toContain("does not load");
		expect(moved.code).toBe(0);
		access = { owners: OWNERS };
		expect((await principal("link", OWNER, `discord:${OWNER}`)).code).toBe(0);
		const refused = await principal("unlink", `discord:${OWNER}`);
		expect(refused.code).toBe(1);
		expect(refused.err).toContain(
			"which the configuration lists under an owner",
		);
	});

	test("unlink refuses a configuration link when the configuration does not load", async () => {
		access = { owners: [{ name: "Ada", identities: ["not-an-identity"] }] };
		const refused = await principal("unlink", `discord:${OWNER}`);
		expect(refused.code).toBe(1);
		expect(refused.err).toContain(
			`discord:${OWNER} is linked to principal ${OWNER}, and`,
		);
		expect(refused.err).toContain("does not load");
		expect((await principal("show", OWNER)).out).toContain(
			`    discord:${OWNER}  (config,`,
		);
	});

	test("a reference that is a principal's id and an identity linked to another principal is refused as ambiguous", async () => {
		const store = await PgPrincipalStore.attach(db?.sql as never);
		const web = {
			provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20",
			subject: "user-7",
		};
		await store.create({ id: WEB, displayName: "Kai-old" });
		const kai = await store.create({ displayName: "Kai" });
		await store.link(kai.id, web, "cli");
		const refused = await principal("grant", WEB, "admin");
		expect(refused.code).toBe(1);
		expect(refused.err).toContain(
			`${WEB} names two principals: principal ${WEB} (Kai-old) by its id, and principal ${kai.id} (Kai) by the identity linked to it`,
		);
		expect(await store.rolesOf(WEB)).toEqual([]);
		expect(await store.rolesOf(kai.id)).toEqual([]);
		expect((await principal("grant", kai.id, "admin")).code).toBe(0);
		// The same identity linked to the principal of that id is no ambiguity.
		await store.unlink(web.provider, web.subject);
		await store.link(WEB, web, "cli");
		expect((await principal("show", WEB)).out).toContain("name: Kai-old");
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
