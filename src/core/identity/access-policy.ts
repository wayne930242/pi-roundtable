import type { Pronouns } from "../config/config.ts";
import { ConfigError } from "../domain/errors.ts";
import type { ChannelKey } from "../sessions.ts";
import type {
	SpeakerFacts,
	SpeakerMap,
	SpeakerPolicy,
	Tier,
	TierMembers,
} from "../speakers.ts";
import {
	type ActorFacts,
	identityOf,
	parseIdentity,
	surfaceOf,
} from "./actor-facts.ts";
import { SYSTEM_PRINCIPAL } from "./principal-store.ts";

/** One owner the configuration names: whom they are, and the identities that are theirs. */
export interface AccessOwner {
	name: string;
	pronouns?: Pronouns;
	/** Their principal's id, such as the 0.8 `owner.id`; without it, a new `p_` principal is made at the first boot and found again by the identities after. */
	principal?: string;
	/** `<provider>:<subject>` strings, such as `discord:<user id>` or `token:remote-mcp`. */
	identities: readonly string[];
}

/**
 * Who holds a tier besides the owners: identities, roles, or everyone. Roles are written
 * `<surface>:role:<name>`. `everyone: true` admits everyone on every surface, a list only on
 * those surfaces.
 */
export interface AccessTier {
	identities?: readonly string[];
	roles?: readonly string[];
	everyone?: boolean | readonly string[];
}

/** Who the host serves, and at which tier. */
export interface AccessRules {
	/** The owners, the first of them the primary owner. The owner tier comes only from here or the CLI, never from a role a surface reports. */
	owners: readonly AccessOwner[];
	admins?: AccessTier;
	members?: AccessTier;
	/** `admitted`: someone the rules admit gets a principal at first contact, and a 0.8 speaker claims theirs; `linked`: only identities already linked, such as by the CLI or the configuration, are served. Owners are never admitted. */
	provisioning: "admitted" | "linked";
	/** How many days a principal whose tier came only from the rules on contact may go unseen before their background turns are refused. */
	backgroundStaleDays: number;
}

const holds = (
	tier: AccessTier | undefined,
	facts: ActorFacts,
	surface: string,
): boolean => {
	if (!tier) return false;
	const { everyone } = tier;
	if (everyone === true) return true;
	if (Array.isArray(everyone) && everyone.includes(surface)) return true;
	if (tier.identities?.includes(identityOf(facts))) return true;
	return (facts.roles ?? []).some((role) => tier.roles?.includes(role));
};

/**
 * The tier the rules give these facts on this contact: admin, member, or none. Never owner: an
 * owner is one by the configuration's owners or a lasting role, not by what a surface reports.
 */
export function factsTier(
	rules: Pick<AccessRules, "admins" | "members">,
	facts: ActorFacts,
	conversation?: ChannelKey,
): Exclude<Tier, "owner"> | undefined {
	const surface = surfaceOf(facts, conversation);
	if (holds(rules.admins, facts, surface)) return "admin";
	if (holds(rules.members, facts, surface)) return "member";
	return undefined;
}

/** The configured owner whose identities include these facts', if any. */
export function ownerOfFacts(
	rules: Pick<AccessRules, "owners">,
	facts: ActorFacts,
): AccessOwner | undefined {
	const identity = identityOf(facts);
	return rules.owners.find((owner) => owner.identities.includes(identity));
}

const ROLE = /^[^:]+:role:.+$/;

function checkTier(tier: AccessTier | undefined, path: string): void {
	if (!tier) return;
	tier.identities?.forEach((identity, i) => {
		if (!parseIdentity(identity))
			throw new ConfigError(
				`config ${path}.identities[${i}]: expected <provider>:<subject>, got ${JSON.stringify(identity)}. Write it like discord:<user id>; roundtable principal list prints them.`,
			);
	});
	tier.roles?.forEach((role, i) => {
		if (!ROLE.test(role))
			throw new ConfigError(
				`config ${path}.roles[${i}]: expected <surface>:role:<name>, got ${JSON.stringify(role)}. Write it like discord:role:<role id> or web:role:<role name>.`,
			);
	});
}

/** The rules, checked: identities and roles well formed, no identity or principal under two owners, no owner as the system principal. */
export function checkAccessRules(rules: AccessRules): AccessRules {
	const seenIdentity = new Map<string, number>();
	const seenPrincipal = new Map<string, number>();
	rules.owners.forEach((owner, n) => {
		const path = `access.owners[${n}]`;
		if (owner.principal === SYSTEM_PRINCIPAL)
			throw new ConfigError(
				`config ${path}.principal: "${SYSTEM_PRINCIPAL}" is the host's own principal. Give the owner's own id, or leave principal out.`,
			);
		if (owner.principal === undefined && owner.identities.length === 0)
			throw new ConfigError(
				`config ${path}: give the owner a principal id or at least one identity, so each boot finds the same principal.`,
			);
		if (owner.principal !== undefined) {
			const other = seenPrincipal.get(owner.principal);
			if (other !== undefined)
				throw new ConfigError(
					`config ${path}.principal: access.owners[${other}] has the same principal ${owner.principal}. Merge the two owners into one.`,
				);
			seenPrincipal.set(owner.principal, n);
		}
		owner.identities.forEach((identity, i) => {
			if (!parseIdentity(identity))
				throw new ConfigError(
					`config ${path}.identities[${i}]: expected <provider>:<subject>, got ${JSON.stringify(identity)}. Write it like discord:<user id>; roundtable principal list prints them.`,
				);
			const other = seenIdentity.get(identity);
			if (other !== undefined)
				throw new ConfigError(
					`config ${path}.identities[${i}]: ${identity} is also listed under access.owners[${other}]. An identity is one person's; keep it under one owner.`,
				);
			seenIdentity.set(identity, n);
		});
	});
	checkTier(rules.admins, "access.admins");
	checkTier(rules.members, "access.members");
	if (
		!(
			Number.isInteger(rules.backgroundStaleDays) &&
			rules.backgroundStaleDays > 0
		)
	)
		throw new ConfigError(
			`config access.backgroundStaleDays: expected a positive whole number of days, got ${JSON.stringify(rules.backgroundStaleDays)}.`,
		);
	return rules;
}

function tierOfMembers(
	members: TierMembers | undefined,
	provider: string,
): AccessTier | undefined {
	if (!members) return undefined;
	return {
		...(members.users
			? { identities: members.users.map((id) => `${provider}:${id}`) }
			: {}),
		...(members.roles
			? { roles: members.roles.map((role) => `${provider}:role:${role}`) }
			: {}),
		...(members.everyone === undefined
			? {}
			: { everyone: members.everyone ? [provider] : false }),
	};
}

/**
 * The rules a 0.8 speaker map means on one surface: its owners by id, its users as identities of
 * that surface, its roles as that surface's roles, and `everyone` as everyone there.
 */
export function rulesOfSpeakerMap(
	map: SpeakerMap,
	provider = "discord",
): Pick<AccessRules, "owners" | "admins" | "members"> {
	const admins = tierOfMembers(map.admins, provider);
	const members = tierOfMembers(map.members, provider);
	return {
		owners: map.owners.map((id) => ({
			name: id,
			principal: id,
			identities: [`${provider}:${id}`],
		})),
		...(admins ? { admins } : {}),
		...(members ? { members } : {}),
	};
}

/**
 * The 0.8 policy over these rules on one surface, for the code that still resolves a speaker
 * from a surface's facts by itself: an author is an owner when one of the owners lists their
 * identity there, and otherwise holds the tier the rules give them. Its speakers carry no
 * principal; the identity service gives those.
 */
export function speakerPolicyOf(
	rules: Pick<AccessRules, "owners" | "admins" | "members">,
	provider = "discord",
): SpeakerPolicy {
	return {
		resolve(author: SpeakerFacts) {
			const facts: ActorFacts = {
				provider,
				subject: author.id,
				name: author.name,
				surface: provider,
				roles: (author.roleIds ?? []).map((role) => `${provider}:role:${role}`),
			};
			const tier: Tier | undefined = ownerOfFacts(rules, facts)
				? "owner"
				: factsTier(rules, facts);
			return tier && { id: author.id, name: author.name, tier };
		},
	};
}
