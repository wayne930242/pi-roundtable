import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coding } from "../packages/coding/src/index.ts";
import { line } from "../packages/line/src/index.ts";
import { mcpConnectors, remoteMcp } from "../packages/mcp/src/index.ts";
import { webConsole } from "../packages/web/src/index.ts";
import { webChat } from "../packages/webchat/src/index.ts";
import { defineRoundtable, type RoundtablePlugin } from "../src/index.ts";

/**
 * The ledger ids a deployed database may already hold. A "once" migration is recorded as
 * `<plugin>/<migration>`, so renaming or dropping one makes a migrated database run its DDL again;
 * an "every-boot" one is never recorded but keeps its place here so its kind cannot change unseen.
 */
export interface MigrationIds {
	once: string[];
	everyBoot: string[];
}

export const BASELINE_PATH = resolve(
	import.meta.dir,
	"migration-ids.baseline.json",
);

/** Workspaces whose plugins declare no migration; a test reads their sources to keep that true. */
export const WITHOUT_MIGRATIONS: readonly string[] = [
	"browser",
	"drawing",
	"sandbox",
];

/** The plugins every official package declares migrations through, with options small enough to build them. */
function packagePlugins(): Record<string, RoundtablePlugin[]> {
	return {
		coding: [
			coding({
				shelfDir: tmpdir(),
				model: "faux/worker",
				settingsInDatabase: true,
			}),
		],
		line: [line({ credentials: { channelId: "1", channelSecret: "secret" } })],
		mcp: [
			mcpConnectors({
				contextForge: {
					url: "http://127.0.0.1:1",
					jwtSecret: "secret",
					user: "a@example.com",
				},
			}),
			remoteMcp({
				dispatchToken: "dispatch-token",
				publicUrl: "https://bot.example.test",
			}),
		],
		web: [
			webConsole({
				origin: "https://console.example.test",
				auth: {
					mode: "oidc",
					issuer: "https://id.example.test",
					clientId: "client",
				},
			}),
		],
		webchat: [
			webChat({
				verifier: async () => {
					throw new Error("not called");
				},
				origins: "any",
				personas: [{ kind: "helper" }],
			}),
		],
	};
}

/** The workspace directories `declaredMigrationIds` builds a plugin for. */
export const COLLECTED_WORKSPACES: readonly string[] = Object.keys(
	packagePlugins(),
);

/** Every migration the core and the official packages declare, in the order a host runs them. */
export async function declaredMigrationIds(): Promise<MigrationIds> {
	const dataDir = mkdtempSync(join(tmpdir(), "roundtable-migration-ids-"));
	try {
		const { plugins } = await defineRoundtable({
			access: {
				owners: [
					{
						name: "Ada",
						principal: "100000000000000001",
						identities: ["discord:100000000000000001"],
					},
				],
			},
			discord: {
				token: "token",
				guild: "900000000000000001",
				entryChannel: "900000000000000002",
			},
			database: { url: "postgres://localhost/roundtable" },
			dataDir,
			model: "anthropic/claude-sonnet-5-5",
			http: { publicUrl: "https://bot.example.com", port: 3456 },
		});
		const ids: MigrationIds = { once: [], everyBoot: [] };
		for (const plugin of [
			...plugins,
			...Object.values(packagePlugins()).flat(),
		])
			for (const migration of plugin.migrations ?? [])
				(migration.runs === "every-boot" ? ids.everyBoot : ids.once).push(
					`${plugin.name}/${migration.name}`,
				);
		return ids;
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

const KINDS = [
	["once", "migration"],
	["everyBoot", "every-boot migration"],
] as const;

/** What stops the declared ids from extending the recorded ones: a missing, renamed or reordered id. */
function lostIds(recorded: MigrationIds, declared: MigrationIds): string[] {
	const problems: string[] = [];
	for (const [kind, label] of KINDS) {
		const have = declared[kind];
		let last = -1;
		for (const id of recorded[kind]) {
			const at = have.indexOf(id);
			if (at < 0)
				problems.push(
					`recorded ${label} ${id} is no longer declared: it was renamed, removed, or changed kind; a deployed database has it in its ledger, so keep the id`,
				);
			else if (at < last)
				problems.push(
					`recorded ${label} ${id} moved before an id recorded earlier; keep the declared order`,
				);
			else last = at;
		}
	}
	return problems;
}

/** Everything wrong between the recorded baseline and the declared ids; empty when they agree. */
export function baselineProblems(
	recorded: MigrationIds,
	declared: MigrationIds,
): string[] {
	const added = KINDS.flatMap(([kind, label]) =>
		declared[kind]
			.filter((id) => !recorded[kind].includes(id))
			.map(
				(id) =>
					`${label} ${id} is declared but not recorded: run bun scripts/migration-ids.ts --record`,
			),
	);
	return [...lostIds(recorded, declared), ...added];
}

/** The baseline to write for the declared ids; throws when that would forget a recorded id, unless the removal is allowed. */
export function recordedBaseline(
	recorded: MigrationIds,
	declared: MigrationIds,
	allowRemoval = false,
): MigrationIds {
	const lost = lostIds(recorded, declared);
	if (lost.length > 0 && !allowRemoval)
		throw new Error(
			`${lost.join("\n")}\nrecord again with --allow-removal only when the id never reached a database`,
		);
	return structuredClone(declared);
}

export function readBaseline(path = BASELINE_PATH): MigrationIds {
	if (!existsSync(path)) return { once: [], everyBoot: [] };
	return JSON.parse(readFileSync(path, "utf8")) as MigrationIds;
}

if (import.meta.main) {
	const declared = await declaredMigrationIds();
	if (process.argv.includes("--record")) {
		const next = recordedBaseline(
			readBaseline(),
			declared,
			process.argv.includes("--allow-removal"),
		);
		writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, "\t")}\n`);
		Bun.spawnSync(["bunx", "biome", "format", "--write", BASELINE_PATH]);
		console.log(
			`recorded ${next.once.length} migrations and ${next.everyBoot.length} every-boot migrations`,
		);
	} else {
		const problems = baselineProblems(readBaseline(), declared);
		for (const problem of problems) console.error(problem);
		process.exit(problems.length > 0 ? 1 : 0);
	}
}
