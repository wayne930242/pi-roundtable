import type { Tier } from "pi-roundtable";
import type { WebIdentity } from "./oidc.ts";

/** Who holds a tier: speaker ids, role or group names from the token, or everyone the provider signs in. */
export interface WebTierMembers {
	users?: readonly string[];
	roles?: readonly string[];
	everyone?: boolean;
}

/**
 * Who may chat, and at which tier. Owners are named only by speaker id, so no claim a provider
 * issues can make someone the owner; admins and members may be named by role as well. A person
 * the map gives no tier is not admitted: no connection, no conversation, no turn.
 */
export interface WebAccessMap {
	/** Speaker ids, such as `oidcSpeakerId(issuer, subject)`; never roles. */
	owners?: readonly string[];
	admins?: WebTierMembers;
	members?: WebTierMembers;
}

/** The tier a verified person chats at, or undefined when they are not admitted. */
export interface WebAccess {
	tierOf(identity: WebIdentity): Tier | undefined;
}

const isStrings = (value: unknown): value is readonly string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Throws unless `tier` is a `WebTierMembers` whose `users` and `roles` are lists of strings and
 * whose `everyone` is a boolean: a JavaScript configuration is not type-checked, and a string
 * where a list belongs would match its substrings.
 */
function checkTier(name: string, tier: unknown): void {
	if (tier === undefined) return;
	if (typeof tier !== "object" || tier === null || Array.isArray(tier))
		throw new Error(
			`webAccess: ${name} is { users?, roles?, everyone? }; got ${JSON.stringify(tier)}`,
		);
	const { users, roles, everyone } = tier as Record<string, unknown>;
	for (const [field, value] of [
		["users", users],
		["roles", roles],
	] as const)
		if (value !== undefined && !isStrings(value))
			throw new Error(
				`webAccess: ${name}.${field} must be a list of strings; got ${JSON.stringify(value)}`,
			);
	if (everyone !== undefined && typeof everyone !== "boolean")
		throw new Error(
			`webAccess: ${name}.everyone must be true or false; got ${JSON.stringify(everyone)}`,
		);
}

function admitsSomeone(tier: WebTierMembers | undefined): boolean {
	return (
		tier !== undefined &&
		(tier.everyone === true ||
			(tier.users?.length ?? 0) > 0 ||
			(tier.roles?.length ?? 0) > 0)
	);
}

/**
 * The policy of an access map: the highest tier a person qualifies for wins. A map that admits
 * no one is a configuration mistake and throws.
 */
export function webAccess(map: WebAccessMap): WebAccess {
	if (map.owners !== undefined && !isStrings(map.owners))
		throw new Error(
			"webAccess: owners is a list of speaker ids; a provider's roles cannot name an owner",
		);
	checkTier("admins", map.admins);
	checkTier("members", map.members);
	const owners = new Set(map.owners ?? []);
	if (
		owners.size === 0 &&
		!admitsSomeone(map.admins) &&
		!admitsSomeone(map.members)
	)
		throw new Error(
			"webAccess: the map admits no one; name owners, or admins or members by user, role, or everyone",
		);
	const holds = (tier: WebTierMembers | undefined, identity: WebIdentity) =>
		tier !== undefined &&
		(tier.everyone === true ||
			tier.users?.includes(identity.id) === true ||
			identity.roles.some((role) => tier.roles?.includes(role)));
	return {
		tierOf(identity) {
			if (owners.has(identity.id)) return "owner";
			if (holds(map.admins, identity)) return "admin";
			if (holds(map.members, identity)) return "member";
			return undefined;
		},
	};
}
