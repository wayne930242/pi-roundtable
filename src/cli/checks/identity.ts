import type { SQL } from "bun";
import { LEGACY_ACCESS } from "../../core/config/access.ts";
import type { ResolvedConfig } from "../../core/config/config.ts";
import type { AccessRules } from "../../core/identity/access-policy.ts";
import { parseIdentity } from "../../core/identity/actor-facts.ts";
import { backfillLine } from "../../core/identity/identity-plugin.ts";
import {
	type BackfillSummary,
	backfillPrincipals,
} from "../../core/identity/identity-schema.ts";
import { PgPrincipalStore } from "../../core/identity/principal-store.ts";
import type { Project } from "../project.ts";
import { fail, ok, type Result, skipped, warn } from "../report.ts";
import type { DatabasePort } from "./database.ts";

const list = (items: readonly string[]): string =>
	new Intl.ListFormat("en").format(items);

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * The chat surfaces the host talks through, as `everyone` names them: Discord when it is
 * configured, and each web chat plugin's surface, read from its name (`webchat` is `web`,
 * `webchat-<surface>` is `<surface>`). A surface another plugin adds at setup is not seen here.
 */
export function surfacesOf(
	config: Pick<ResolvedConfig, "discord">,
	plugins: readonly { name: string }[],
): string[] {
	const surfaces = config.discord ? ["discord"] : [];
	for (const { name } of plugins) {
		if (name === "webchat") surfaces.push("web");
		else if (name.startsWith("webchat-"))
			surfaces.push(name.slice("webchat-".length));
	}
	return surfaces;
}

/**
 * Whom the configuration serves: the owners by name, a warning when `everyone: true` admits
 * everyone on every surface of a host with more than one, and a note when it is written in the
 * deprecated 0.8 form. It reads no database, so `start` runs it too.
 */
export async function checkAccess(project: Project): Promise<Result> {
	const assembled = await project.assembled();
	if (!assembled.ok) return skipped("the configuration is not valid yet");
	const { config, defined } = assembled.value;
	const surfaces = surfacesOf(config, defined.plugins);
	const broad = (["admins", "members"] as const).filter(
		(tier) => config.access[tier]?.everyone === true,
	);
	if (broad.length > 0 && surfaces.length > 1)
		return warn(
			`${list(broad.map((tier) => `access.${tier}.everyone`))} ${broad.length === 1 ? "is" : "are"} true, which admits everyone on every surface: ${list(surfaces)}.`,
			`Name the surfaces where everyone may talk, such as everyone: ["discord"], and admit the others by identity or by role, such as roles: ["web:role:<name>"].`,
		);
	const owners = config.access.owners;
	const legacy = config.deprecations.includes(LEGACY_ACCESS)
		? "; written as the 0.8 owner and speakers, which roundtable upgrade rewrites as access"
		: "";
	return ok(
		`${owners.length} ${owners.length === 1 ? "owner" : "owners"}, ${list(owners.map((owner) => owner.name))}${legacy}`,
	);
}

/** What the database says about the configured owners, and what the next start's backfill would make. */
export interface PrincipalFindings {
	summary: BackfillSummary;
	/** A configured owner's identity linked to another principal, which stops the start. */
	conflicts: { problem: string; identity: string }[];
	/** Configured owners whose principal is disabled. */
	disabled: { index: number; id: string; name: string }[];
	/** Whether any owner, configured or granted by the CLI, can reach the host. */
	reachable: boolean;
}

/**
 * Reads, without writing, what the identity plugin would do at the next start: the backfill as a
 * dry run, and the configured owners' identity links as its sync checks them.
 */
export async function principalFindings(
	sql: SQL,
	rules: AccessRules,
): Promise<PrincipalFindings> {
	const owners = rules.owners.flatMap((owner) =>
		owner.principal === undefined
			? []
			: [{ id: owner.principal, name: owner.name }],
	);
	const summary = await backfillPrincipals(sql, owners, { dryRun: true });
	const [tables] = await sql`
		SELECT to_regclass('principal_identities') IS NOT NULL
			AND to_regclass('principal_roles') IS NOT NULL AS made`;
	// Before the first start on 0.9, the start makes every configured owner, enabled.
	if (tables?.made !== true)
		return { summary, conflicts: [], disabled: [], reachable: true };
	const store = await PgPrincipalStore.attach(sql);
	const conflicts: PrincipalFindings["conflicts"] = [];
	const disabled: PrincipalFindings["disabled"] = [];
	let reachable = false;
	for (const [index, owner] of rules.owners.entries()) {
		let id = owner.principal;
		for (const [i, identity] of owner.identities.entries()) {
			const ref = parseIdentity(identity);
			const link = ref && (await store.identity(ref.provider, ref.subject));
			if (!link) continue;
			id ??= link.principalId;
			if (link.principalId !== id)
				conflicts.push({
					problem: `access.owners[${index}].identities[${i}]: ${identity} is linked to principal ${link.principalId}, not to this owner's ${id}`,
					identity,
				});
		}
		const principal = id === undefined ? undefined : await store.get(id);
		if (principal?.disabled)
			disabled.push({ index, id: principal.id, name: owner.name });
		else reachable = true;
	}
	for (const holder of await store.holders("owner"))
		if (
			holder.source === "cli" &&
			(await store.get(holder.principalId))?.disabled === false
		)
			reachable = true;
	return { summary, conflicts, disabled, reachable };
}

/**
 * The principals the next start would make from the people 0.8 stored, as a dry run printed as the
 * start logs it; a configured owner's identity linked to another principal, which stops the
 * start; and a disabled configured owner, or no owner left who can reach the host.
 */
export async function checkPrincipals(
	project: Project,
	database: DatabasePort,
): Promise<Result> {
	const url = await project.text("database", "url");
	if (!url) return skipped("database.url has no value");
	const assembled = await project.assembled();
	if (!assembled.ok) return skipped("the configuration is not valid yet");
	const rules = assembled.value.config.access;
	let findings: PrincipalFindings;
	try {
		findings = await database.read(url, (sql) => principalFindings(sql, rules));
	} catch (error) {
		return skipped(`PostgreSQL did not answer (${message(error)})`);
	}
	const dryRun = `dry run, nothing written: ${backfillLine(findings.summary)}`;
	if (findings.conflicts.length > 0)
		return fail(
			`${findings.conflicts.map((conflict) => conflict.problem).join("; ")}; the host does not start until this is fixed.`,
			[
				"Unlink each identity from the principal it is linked to, or fix access.owners in roundtable.config.ts:",
				...findings.conflicts.map(
					(conflict) => `  roundtable principal unlink ${conflict.identity}`,
				),
			].join("\n"),
		);
	if (findings.disabled.length > 0) {
		const who = list(
			findings.disabled.map(
				(owner) =>
					`access.owners[${owner.index}] ${owner.name} (principal ${owner.id})`,
			),
		);
		return warn(
			findings.reachable
				? `${who} ${findings.disabled.length === 1 ? "is" : "are"} disabled, so the host does not serve them.`
				: `no owner can reach the host: ${who} ${findings.disabled.length === 1 ? "is" : "are"} disabled.`,
			[
				...findings.disabled.map(
					(owner) => `Enable with roundtable principal enable ${owner.id}`,
				),
				dryRun,
			].join("\n"),
		);
	}
	return ok(dryRun);
}
