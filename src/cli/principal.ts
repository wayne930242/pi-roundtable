import type { SQL } from "bun";
import { openPool } from "../core/db/migrations.ts";
import { IdentityError } from "../core/domain/errors.ts";
import type { AccessOwner } from "../core/identity/access-policy.ts";
import { identityOf, parseIdentity } from "../core/identity/actor-facts.ts";
import type { DeclaredIdentity } from "../core/identity/plugin-identities.ts";
import {
	type IdentityLink,
	PgPrincipalStore,
	type PrincipalRecord,
	type Pronouns,
	type RoleGrant,
} from "../core/identity/principal-store.ts";
import type { Tier } from "../core/speakers.ts";
import { CONFIG_FILE } from "./project.ts";

export const PRINCIPAL_USAGE = `  roundtable principal list    every principal, with its roles and its identities written as
                                access in roundtable.config.ts takes them
  roundtable principal show <principal>
  roundtable principal create --name <name> [--pronouns he|she|they]
  roundtable principal link <principal> <provider>:<subject>
  roundtable principal unlink <provider>:<subject>
  roundtable principal grant <principal> member|admin|owner
  roundtable principal revoke <principal> member|admin|owner
  roundtable principal disable <principal>
  roundtable principal enable <principal>
                                <principal> is a principal id, or an identity linked to it`;

/** What every change prints: a running host reads its own copy for up to 30 seconds. */
export const HOST_DELAY =
	"A running host sees this within 30 seconds; a host that starts sees it at once.";

const TIERS: readonly Tier[] = ["member", "admin", "owner"];
const PRONOUNS: readonly Pronouns[] = ["he", "she", "they"];

export interface PrincipalIo {
	out(line: string): void;
	err(line: string): void;
}

/** The owners the project's configuration names, or undefined when it does not load. */
type ConfiguredOwners = readonly AccessOwner[] | undefined;

/** The identities the project's plugins declare, or undefined when the configuration does not load. */
export type ConfiguredIdentities = readonly DeclaredIdentity[] | undefined;

/** What the project's configuration says, read by its schema alone. */
export interface Configured {
	owners: ConfiguredOwners;
	identities: ConfiguredIdentities;
}

/** A refusal: the message is the whole answer, printed as it is. */
class Refusal extends Error {}

const describe = (principal: PrincipalRecord): string =>
	`${principal.displayName}${principal.pronouns ? ` (${principal.pronouns})` : ""}`;

const named = (principal: PrincipalRecord): string =>
	`principal ${principal.id} (${principal.displayName})`;

const stamp = (date: Date): string => date.toISOString();

/**
 * The principal a reference names: its id, or the principal an identity is linked to. A 0.8 id
 * can be both, such as a web user's `oidc:…` id once that identity is linked to someone else;
 * then it is refused rather than guessed.
 */
async function find(
	store: PgPrincipalStore,
	reference: string | undefined,
): Promise<PrincipalRecord> {
	if (reference === undefined) throw new Refusal("name a principal");
	const byId = await store.get(reference);
	const identity = parseIdentity(reference);
	const link =
		identity && (await store.identity(identity.provider, identity.subject));
	const linked = link ? await store.get(link.principalId) : undefined;
	if (byId && linked && byId.id !== linked.id)
		throw new Refusal(
			`${reference} names two principals: ${named(byId)} by its id, and ${named(linked)} by the identity linked to it. Name ${linked.id} by its id; to reach ${byId.id}, unlink ${reference} first, then link it to ${linked.id} again`,
		);
	const found = byId ?? linked;
	if (found) return found;
	throw new Refusal(
		`there is no principal ${reference}, and no identity ${reference} is linked; roundtable principal list shows them`,
	);
}

function identityArgument(text: string | undefined) {
	const identity = text === undefined ? undefined : parseIdentity(text);
	if (!identity)
		throw new Refusal(
			`expected an identity written <provider>:<subject>, such as discord:<user id>, got ${JSON.stringify(text ?? "")}`,
		);
	return identity;
}

function tierArgument(text: string | undefined): Tier {
	if (!TIERS.includes(text as Tier))
		throw new Refusal(
			`expected a role, one of member, admin, or owner, got ${JSON.stringify(text ?? "")}`,
		);
	return text as Tier;
}

/** The plugin of the configuration that declares the identity; undefined when none does, unknown when the configuration does not load. */
function declarer(
	identities: ConfiguredIdentities,
	link: IdentityLink,
): string | undefined | "unknown" {
	if (identities === undefined) return "unknown";
	const text = identityOf(link);
	return identities.find((declared) => declared.identity === text)?.plugin;
}

/** Where a link came from, and for a plugin's, which plugin declares it. */
function sourceText(link: IdentityLink, configured: Configured): string {
	if (link.source !== "plugin") return link.source;
	const plugin = declarer(configured.identities, link);
	if (plugin === "unknown") return "plugin";
	return plugin === undefined
		? "plugin, which no plugin declares any more: the next start unlinks it"
		: `plugin ${plugin}`;
}

const linkLine = (link: IdentityLink, configured: Configured): string =>
	`    ${identityOf(link)}  (${sourceText(link, configured)})`;

const rolesText = (roles: readonly RoleGrant[]): string =>
	roles.length === 0
		? "none"
		: roles.map((grant) => `${grant.role} (${grant.source})`).join(", ");

/** Whether the person of its 0.8 id still links their own identity at first contact, as the identity service claims it. */
const claimable = (
	principal: PrincipalRecord,
	roles: readonly RoleGrant[],
): boolean =>
	principal.claimable && !roles.some((grant) => grant.role === "owner");

async function list(
	store: PgPrincipalStore,
	io: PrincipalIo,
	configured: Configured,
): Promise<void> {
	const principals = await store.list();
	for (const principal of principals) {
		const roles = await store.rolesOf(principal.id);
		io.out(
			`${principal.id}  ${describe(principal)}${principal.disabled ? "  disabled" : ""}  roles: ${rolesText(roles)}`,
		);
		const links = await store.identitiesOf(principal.id);
		for (const link of links) io.out(linkLine(link, configured));
		if (links.length === 0)
			io.out(
				claimable(principal, roles)
					? `    no identity linked yet; carried over from 0.8, so ${principal.id} links its own at its first contact`
					: `    no identity linked yet; link one with roundtable principal link ${principal.id} <provider>:<subject>`,
			);
	}
	io.out(
		`${principals.length} ${principals.length === 1 ? "principal" : "principals"}. Each identity is written <provider>:<subject>, as access in roundtable.config.ts and roundtable principal link take it.`,
	);
}

async function show(
	store: PgPrincipalStore,
	principal: PrincipalRecord,
	io: PrincipalIo,
	configured: Configured,
): Promise<void> {
	io.out(`principal ${principal.id}`);
	io.out(`  name: ${describe(principal)}`);
	io.out(`  status: ${principal.disabled ? "disabled" : "enabled"}`);
	io.out(`  created: ${stamp(principal.createdAt)}`);
	io.out(
		`  last seen: ${principal.lastSeenAt ? `${stamp(principal.lastSeenAt)} as ${principal.lastTier ?? "unknown"}` : "never"}`,
	);
	io.out(`  roles: ${rolesText(await store.rolesOf(principal.id))}`);
	const links = await store.identitiesOf(principal.id);
	io.out(`  identities: ${links.length === 0 ? "none" : ""}`.trimEnd());
	for (const link of links)
		io.out(
			`    ${identityOf(link)}  (${sourceText(link, configured)}, linked ${stamp(link.linkedAt)})`,
		);
}

/** The value after `flag`, and the arguments without both. */
function option(
	args: readonly string[],
	flag: string,
): { value: string | undefined; rest: string[] } {
	const at = args.indexOf(flag);
	if (at === -1) return { value: undefined, rest: [...args] };
	return { value: args[at + 1], rest: args.toSpliced(at, 2) };
}

/** Each subcommand and how many arguments it takes. */
const ARITY: Record<string, number> = {
	list: 0,
	show: 1,
	link: 2,
	unlink: 1,
	grant: 2,
	revoke: 2,
	disable: 1,
	enable: 1,
};

/**
 * Where the configuration lists an identity it linked: under the owner of the principal it is
 * linked to (or an owner found by their identities), under another owner, nowhere any more, or
 * unknown when the configuration does not load.
 */
function listedUnder(
	owners: ConfiguredOwners,
	link: IdentityLink,
): "this principal" | "another owner" | "nowhere" | "unknown" {
	if (owners === undefined) return "unknown";
	const text = identityOf(link);
	const holders = owners.filter((owner) =>
		owner.identities.some((written) => {
			const ref = parseIdentity(written);
			return ref !== undefined && identityOf(ref) === text;
		}),
	);
	if (holders.length === 0) return "nowhere";
	return holders.some(
		(owner) =>
			owner.principal === undefined || owner.principal === link.principalId,
	)
		? "this principal"
		: "another owner";
}

async function run(
	store: PgPrincipalStore,
	args: readonly string[],
	io: PrincipalIo,
	configured: Configured,
): Promise<void> {
	const { owners } = configured;
	const [command, ...rest] = args;
	if (command === "create") {
		const name = option(rest, "--name");
		const pronouns = option(name.rest, "--pronouns");
		if (!name.value?.trim() || name.value.startsWith("--"))
			throw new Refusal(
				"create takes --name <name>, the name to address them by",
			);
		if (pronouns.rest.length > 0)
			throw new Refusal(
				`create takes --name and --pronouns, not ${pronouns.rest.join(" ")}`,
			);
		if (
			pronouns.value !== undefined &&
			!PRONOUNS.includes(pronouns.value as Pronouns)
		)
			throw new Refusal(
				`--pronouns takes he, she, or they, not ${JSON.stringify(pronouns.value)}`,
			);
		const made = await store.create({
			displayName: name.value.trim(),
			...(pronouns.value ? { pronouns: pronouns.value as Pronouns } : {}),
		});
		io.out(
			`Created ${named(made)}. Link an identity to it with roundtable principal link ${made.id} <provider>:<subject>.`,
		);
		io.out(HOST_DELAY);
		return;
	}
	const arity = command === undefined ? undefined : ARITY[command];
	if (arity === undefined)
		throw new Refusal(`unknown principal command. Usage:\n${PRINCIPAL_USAGE}`);
	if (arity !== rest.length)
		throw new Refusal(
			`${command} takes ${arity} ${arity === 1 ? "argument" : "arguments"}. Usage:\n${PRINCIPAL_USAGE}`,
		);
	if (command === "list") return list(store, io, configured);
	if (command === "unlink") {
		const identity = identityArgument(rest[0]);
		const link = await store.identity(identity.provider, identity.subject);
		// A plugin's identity is linked again by the next start while the plugin declares it.
		const plugin =
			link?.source === "plugin"
				? declarer(configured.identities, link)
				: undefined;
		if (link && plugin === "unknown")
			throw new Refusal(
				`${identityOf(identity)} is linked to principal ${link.principalId} as an identity a plugin declares, and ${CONFIG_FILE} does not load here to say whether a plugin still declares it; fix it, then try again`,
			);
		if (link && plugin !== undefined)
			throw new Refusal(
				`${identityOf(identity)} is linked to principal ${link.principalId} as an identity plugin ${plugin} declares; change that plugin's options in ${CONFIG_FILE} instead, and the next start moves or unlinks it`,
			);
		// Whoever linked it (the configuration, a first contact, the CLI, or a 0.8 claim), an identity
		// an owner is listed by would be admitted by a running host as someone new once unlinked here,
		// and the next start would fail on it.
		const listed = link ? listedUnder(owners, link) : "nowhere";
		if (link && (listed === "this principal" || listed === "unknown"))
			throw new Refusal(
				`${identityOf(identity)} is linked to principal ${link.principalId}, ${listed === "unknown" ? `and ${CONFIG_FILE} does not load here to say whether it lists it under an owner; fix it, or` : "which the configuration lists under an owner;"} remove it from access.owners[*].identities in ${CONFIG_FILE} instead, ${link.source === "config" ? "and the next start unlinks it" : "then unlink it here once the host has started with that configuration"}`,
			);
		if (!link || !(await store.unlink(identity.provider, identity.subject)))
			throw new Refusal(
				`${identityOf(identity)} is not linked to any principal`,
			);
		io.out(
			`Unlinked ${identityOf(identity)} from principal ${link.principalId}.`,
		);
		if (listed === "another owner")
			io.out(
				"The configuration lists it under another owner, which a running host does not read: stop the host, then start it with this configuration. If a new p_… principal appears with this identity before then, unlink it again.",
			);
		io.out(HOST_DELAY);
		return;
	}
	const principal = await find(store, rest[0]);
	if (command === "show") return show(store, principal, io, configured);
	if (command === "link") {
		const identity = identityArgument(rest[1]);
		const spends = claimable(principal, await store.rolesOf(principal.id));
		await store.link(principal.id, identity, "cli");
		io.out(`Linked ${identityOf(identity)} to ${named(principal)}.`);
		if (spends)
			io.out(
				`This uses up the 0.8 claim of principal ${principal.id}: its 0.8 id no longer links its own identity at first contact, even once this one is unlinked. Link each of their other identities here.`,
			);
	} else if (command === "grant") {
		const role = tierArgument(rest[1]);
		// Granting it again would make it the CLI's, outliving its removal from the configuration.
		const held = (await store.rolesOf(principal.id)).find(
			(grant) => grant.role === role,
		);
		if (held?.source === "config") {
			io.out(
				`${named(principal)} already holds ${role}, granted by the configuration; nothing changed.`,
			);
			return;
		}
		await store.grant(principal.id, role, "cli");
		io.out(`Granted ${role} to ${named(principal)}.`);
		if (role === "owner")
			io.out(
				"The owner role is granted only here and in the configuration; no role a surface reports makes an owner.",
			);
	} else if (command === "revoke") {
		const role = tierArgument(rest[1]);
		const grant = (await store.rolesOf(principal.id)).find(
			(held) => held.role === role,
		);
		if (!grant)
			throw new Refusal(`principal ${principal.id} does not hold ${role}`);
		if (grant.source === "config")
			throw new Refusal(
				`principal ${principal.id} holds ${role} from the configuration, which grants it again at every start; remove them from access.owners in roundtable.config.ts instead`,
			);
		await store.revoke(principal.id, role, "cli");
		io.out(`Revoked ${role} from ${named(principal)}.`);
	} else if (command === "disable") {
		await store.disable(principal.id);
		io.out(
			`Disabled ${named(principal)}: no surface serves them, and their background turns are skipped.`,
		);
	} else {
		await store.enable(principal.id);
		io.out(`Enabled ${named(principal)}.`);
	}
	io.out(HOST_DELAY);
}

/** Whether the host has made the principal tables, which its first start on 0.9 does. */
async function hasTables(sql: SQL): Promise<boolean> {
	const [row] = await sql`
		SELECT to_regclass('principals') IS NOT NULL
			AND to_regclass('principal_identities') IS NOT NULL
			AND to_regclass('principal_roles') IS NOT NULL AS made`;
	return row?.made === true;
}

/**
 * Runs one `roundtable principal` command on the database at `url`, beside a host that may be
 * running, and returns the exit code. It changes the database directly; a running host's cache
 * catches up within 30 seconds, which every change says.
 */
export async function principalCommand(
	url: string,
	args: readonly string[],
	io: PrincipalIo,
	configured: Configured,
): Promise<number> {
	const sql = openPool(url);
	try {
		if (!(await hasTables(sql))) {
			io.err(
				"This database has no principals yet: start the host on pi-roundtable 0.9 once, and its migrations make them from the people it already knows.",
			);
			return 1;
		}
		await run(await PgPrincipalStore.attach(sql), args, io, configured);
		return 0;
	} catch (error) {
		if (error instanceof Refusal || error instanceof IdentityError) {
			io.err(error.message);
			return 1;
		}
		throw error;
	} finally {
		await sql.close();
	}
}
