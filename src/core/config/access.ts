import { ConfigError } from "../domain/errors.ts";
import {
	type AccessRules,
	type AccessTier,
	checkAccessRules,
	rulesOfSpeakerMap,
} from "../identity/access-policy.ts";
import { parseIdentity } from "../identity/actor-facts.ts";
import { PRONOUNS } from "../identity.ts";
import type { Logger } from "../log.ts";
import type { TierMembers } from "../speakers.ts";
import type { Pronouns, ResolvedConfig, RoundtableConfig } from "./config.ts";
import {
	type Field,
	guarded,
	integer,
	list,
	oneOf,
	optional,
	shape,
	text,
} from "./schema.ts";

/** Who holds a tier besides the owners: identities, roles written `<surface>:role:<name>`, or everyone, on every surface or on those listed. */
export interface AccessTierConfig {
	identities?: readonly string[];
	roles?: readonly string[];
	everyone?: boolean | readonly string[];
}

/** One owner: their name and pronouns, their principal, and the identities that are theirs. */
export interface AccessOwnerConfig {
	name: string;
	pronouns?: Pronouns;
	/**
	 * Their principal's id. Required for the first owner, the primary one: give the old
	 * `owner.id`, which `roundtable upgrade` writes, or an id of your choosing, such as their
	 * Discord user id. Another owner without one gets a new `p_` principal at the first boot.
	 */
	principal?: string;
	/** `<provider>:<subject>` strings, such as `discord:<user id>` or `token:remote-mcp`; `roundtable principal list` prints them. */
	identities?: readonly string[];
}

/** Who the host serves, and at which tier: the owners, then admins and members by identity, role, or everyone. */
export interface AccessConfig {
	/** The owners, the first of them the primary owner, whose Discord identity the Discord parts act for until 0.10. */
	owners: readonly AccessOwnerConfig[];
	admins?: AccessTierConfig;
	members?: AccessTierConfig;
	/** `admitted` (default): someone the rules admit gets a principal at first contact, and a 0.8 speaker claims theirs; `linked`: only identities linked with the CLI, or the owners' configured ones, are served, and no one claims a 0.8 principal. */
	provisioning?: "admitted" | "linked";
	/** How many days someone whose tier comes only from the rules may go unseen before their background turns are refused; default 30. */
	backgroundStaleDays?: number;
}

const everyone: Field<boolean | string[]> = guarded(
	"true, false, or a list of surfaces",
	(value): value is boolean | string[] =>
		typeof value === "boolean" ||
		(Array.isArray(value) &&
			value.every((item) => typeof item === "string" && item.trim() !== "")),
);

const tierShape = shape({
	identities: optional(list(text)),
	roles: optional(list(text)),
	everyone: optional(everyone),
});

/** The `access` key's shape. */
export const accessShape = shape({
	owners: list(
		shape({
			name: text,
			pronouns: optional(oneOf<Pronouns>("he", "she", "they")),
			principal: optional(text),
			identities: optional(list(text)),
		}),
	),
	admins: optional(tierShape),
	members: optional(tierShape),
	provisioning: optional(oneOf<"admitted" | "linked">("admitted", "linked")),
	backgroundStaleDays: optional(integer(1, 36_500)),
});

/** The days an unseen principal's background turns keep their last tier, by default. */
export const BACKGROUND_STALE_DAYS = 30;

/** The deprecation the 0.8 `owner` and `speakers` print, once per host logger. */
export const LEGACY_ACCESS =
	"config owner and speakers are deprecated and go away in 0.10: write access: { owners, admins, members } instead; roundtable upgrade rewrites them";

function tierOf(config: AccessTierConfig | undefined): AccessTier | undefined {
	if (!config) return undefined;
	return {
		...(config.identities ? { identities: config.identities } : {}),
		...(config.roles ? { roles: config.roles } : {}),
		...(config.everyone === undefined ? {} : { everyone: config.everyone }),
	};
}

/** The rules an `access` configuration means, checked. */
export function rulesOfAccess(config: AccessConfig): AccessRules {
	if (config.owners.length === 0)
		throw new ConfigError(
			"config access.owners: expected at least one owner. Name the person who runs this host.",
		);
	const [primary] = config.owners;
	if (primary?.principal === undefined)
		throw new ConfigError(
			"config access.owners[0].principal: required for the primary owner in 0.9, expected their principal id. Give the old owner.id (roundtable upgrade writes it), or an id of your choosing, such as their Discord user id.",
		);
	const admins = tierOf(config.admins);
	const members = tierOf(config.members);
	return checkAccessRules({
		owners: config.owners.map((owner) => ({
			name: owner.name,
			...(owner.pronouns ? { pronouns: owner.pronouns } : {}),
			...(owner.principal === undefined ? {} : { principal: owner.principal }),
			identities: owner.identities ?? [],
		})),
		...(admins ? { admins } : {}),
		...(members ? { members } : {}),
		provisioning: config.provisioning ?? "admitted",
		backgroundStaleDays: config.backgroundStaleDays ?? BACKGROUND_STALE_DAYS,
	});
}

/**
 * The rules the 0.8 `owner` and `speakers` mean: the owner as the primary owner, their principal
 * the old `owner.id`, which is also their Discord identity on a host with Discord, and the tiers
 * by Discord user and role ids, with `everyone` meaning everyone on Discord, the one surface it
 * reached in 0.8.
 */
export function rulesOfLegacy(
	owner: { id: string; name: string; pronouns?: Pronouns },
	speakers: { admins?: TierMembers; members?: TierMembers } = {},
	withDiscord = true,
): AccessRules {
	const map = rulesOfSpeakerMap({
		owners: [owner.id],
		...(speakers.admins ? { admins: speakers.admins } : {}),
		...(speakers.members ? { members: speakers.members } : {}),
	});
	return checkAccessRules({
		...map,
		owners: [
			{
				name: owner.name,
				...(owner.pronouns ? { pronouns: owner.pronouns } : {}),
				principal: owner.id,
				identities: withDiscord ? [`discord:${owner.id}`] : [],
			},
		],
		provisioning: "admitted",
		backgroundStaleDays: BACKGROUND_STALE_DAYS,
	});
}

/** The Discord user id among an owner's identities, if they list one. */
export function discordIdOf(identities: readonly string[]): string | undefined {
	for (const identity of identities) {
		const ref = parseIdentity(identity);
		if (ref?.provider === "discord") return ref.subject;
	}
	return undefined;
}

const warned = new WeakMap<Logger, Set<string>>();

/** Logs each deprecation once per logger, so a host warns once however often it is defined. */
export function warnDeprecations(
	logger: Logger,
	deprecations: readonly string[],
): void {
	let seen = warned.get(logger);
	if (!seen) {
		seen = new Set();
		warned.set(logger, seen);
	}
	for (const message of deprecations) {
		if (seen.has(message)) continue;
		seen.add(message);
		logger.warn(`deprecated: ${message}`);
	}
}

/** The access rules and the primary owner, from `access` or the deprecated `owner` and `speakers`. */
export function accessOf(
	config: Pick<RoundtableConfig, "owner" | "speakers" | "access">,
	withDiscord: boolean,
): Pick<ResolvedConfig, "access" | "primaryOwner" | "deprecations"> {
	const { owner, speakers, access } = config;
	if (access && (owner || speakers))
		throw new ConfigError(
			"config access: write the owners in access or in owner and speakers, not both. Remove owner and speakers; roundtable upgrade rewrites them as access.",
		);
	if (!access && !owner)
		throw new ConfigError(
			'config access: required, expected who runs this host, such as access: { owners: [{ name: "Ada", principal: "<id>", identities: ["discord:<user id>"] }] }. Add it to roundtable.config.ts.',
		);
	const rules = access
		? rulesOfAccess(access)
		: rulesOfLegacy(
				// The schema checked that one of the two is here.
				owner as NonNullable<typeof owner>,
				speakers,
				withDiscord,
			);
	const [primary] = rules.owners;
	if (primary?.principal === undefined)
		throw new ConfigError("config access.owners[0].principal: required");
	const discordId = discordIdOf(primary.identities);
	if (withDiscord && discordId === undefined)
		throw new ConfigError(
			'config access.owners[0].identities: the primary owner needs a discord:<user id> identity while Discord is configured; the Discord parts act for them until 0.10. Add it, such as identities: ["discord:<your user id>"].',
		);
	return {
		access: rules,
		primaryOwner: {
			id: primary.principal,
			name: primary.name,
			pronouns: PRONOUNS[primary.pronouns ?? "they"],
			...(discordId === undefined ? {} : { discordId }),
		},
		deprecations: access ? [] : [LEGACY_ACCESS],
	};
}
