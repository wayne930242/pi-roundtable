import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineRoundtable, discordOwnerOf } from "../define-roundtable.ts";
import { ConfigError } from "../domain/errors.ts";
import { speakerPolicyOf } from "../identity/access-policy.ts";
import type { SpeakerFacts, Tier } from "../speakers.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import { LEGACY_ACCESS } from "./access.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";

const OWNER = "966666600000000001";
const ADMIN = "966666600000000011";
const ADMIN_ROLE = "966666600000000077";
const MEMBER_ROLE = "966666600000000078";

const base = {
	discord: {
		token: "token",
		guild: "966666600000000002",
		entryChannel: "966666600000000004",
	},
	database: { url: "postgres://localhost/roundtable" },
	dataDir: "/data",
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.com" },
} satisfies Partial<RoundtableConfig>;

/** A 0.8 configuration: one owner, admins by user and role, members by role. */
const legacy: RoundtableConfig = {
	...base,
	owner: { id: OWNER, name: "Ada", pronouns: "she" },
	speakers: {
		admins: { users: [ADMIN], roles: [ADMIN_ROLE] },
		members: { roles: [MEMBER_ROLE] },
	},
};

/** The same people, written with access. */
const written: RoundtableConfig = {
	...base,
	access: {
		owners: [
			{
				name: "Ada",
				pronouns: "she",
				principal: OWNER,
				identities: [`discord:${OWNER}`],
			},
		],
		admins: {
			identities: [`discord:${ADMIN}`],
			roles: [`discord:role:${ADMIN_ROLE}`],
		},
		members: { roles: [`discord:role:${MEMBER_ROLE}`] },
	},
};

/** The tier 0.8's speaker policy gave an author, as it decided it. */
function tier08(
	config: RoundtableConfig,
	author: SpeakerFacts,
): Tier | undefined {
	const owner = config.owner?.id;
	const holds = (
		tier:
			| {
					users?: readonly string[];
					roles?: readonly string[];
					everyone?: boolean;
			  }
			| undefined,
	) =>
		tier !== undefined &&
		(tier.everyone === true ||
			tier.users?.includes(author.id) === true ||
			(author.roleIds ?? []).some((role) => tier.roles?.includes(role)));
	if (author.id === owner) return "owner";
	if (holds(config.speakers?.admins)) return "admin";
	if (holds(config.speakers?.members)) return "member";
	return undefined;
}

/** Discord authors: the owner, admins by id and by role, members, an author with both roles, and strangers. */
const AUTHORS: SpeakerFacts[] = [
	{ id: OWNER, name: "Ada" },
	{ id: OWNER, name: "Ada", roleIds: [MEMBER_ROLE] },
	{ id: ADMIN, name: "Bo" },
	{ id: "966666600000000012", name: "Cy", roleIds: [ADMIN_ROLE] },
	{ id: "966666600000000013", name: "Di", roleIds: [MEMBER_ROLE] },
	{ id: "966666600000000014", name: "Ed", roleIds: [MEMBER_ROLE, ADMIN_ROLE] },
	{ id: "966666600000000015", name: "Fy" },
	{ id: "966666600000000016", name: "Gu", roleIds: ["966666600000000099"] },
];

describe("the access configuration", () => {
	test("a 0.8 owner and speakers and the same people written with access give every author the same tier", () => {
		for (const [old, now] of [
			[legacy, written],
			[
				{ ...legacy, speakers: { members: { everyone: true } } },
				{
					...written,
					access: {
						...written.access,
						owners: written.access?.owners ?? [],
						admins: {},
						members: { everyone: ["discord"] },
					},
				},
			],
		] as const) {
			const fromOld = speakerPolicyOf(resolveConfig(old).access);
			const fromNow = speakerPolicyOf(resolveConfig(now).access);
			const table = AUTHORS.map((author) => [
				author.id,
				tier08(old, author),
				fromOld.resolve(author)?.tier,
				fromNow.resolve(author)?.tier,
			]);
			for (const [id, expected, a, b] of table) {
				expect({ id, tier: a }).toEqual({ id, tier: expected });
				expect({ id, tier: b }).toEqual({ id, tier: expected });
			}
		}
		expect(resolveConfig(legacy).access).toEqual(resolveConfig(written).access);
	});

	test("the primary owner is the first owner; owner stays as their 0.8 form", () => {
		const config = resolveConfig(written);
		expect(config.primaryOwner).toEqual({
			id: OWNER,
			name: "Ada",
			pronouns: { subject: "she", object: "her", possessive: "her" },
			discordId: OWNER,
		});
		const { discordId: _discordId, ...owner } = config.primaryOwner;
		expect(config.owner).toEqual(owner);
		expect(config.deprecations).toEqual([]);
		expect(resolveConfig(legacy).owner).toEqual(config.owner);
		expect(resolveConfig(legacy).deprecations).toEqual([LEGACY_ACCESS]);
	});

	test("access defaults: provisioning admitted, background turns stale after 30 days, no identities", () => {
		const config = resolveConfig({
			...base,
			discord: undefined,
			http: undefined,
			access: { owners: [{ name: "Ops", principal: "operator" }] },
		});
		expect(config.access).toEqual({
			owners: [{ name: "Ops", principal: "operator", identities: [] }],
			provisioning: "admitted",
			backgroundStaleDays: 30,
		});
		expect(config.primaryOwner.id).toBe("operator");
		expect(config.primaryOwner.discordId).toBeUndefined();
	});

	test("the 0.8 owner of a host without Discord gets no Discord identity", () => {
		const config = resolveConfig({
			...base,
			discord: undefined,
			http: undefined,
			owner: { id: "operator", name: "Ops" },
		});
		expect(config.access.owners).toEqual([
			{ name: "Ops", principal: "operator", identities: [] },
		]);
		expect(config.primaryOwner.discordId).toBeUndefined();
		// With Discord the same owner keeps their Discord identity, as before.
		expect(resolveConfig(legacy).access.owners[0]?.identities).toEqual([
			`discord:${OWNER}`,
		]);
	});

	test("access together with owner or speakers, neither, a primary owner without a principal, or Discord without the primary owner's Discord identity is refused", () => {
		const refused = (input: unknown) => {
			try {
				resolveConfig(input);
			} catch (error) {
				if (error instanceof ConfigError) return error.message;
				throw error;
			}
			return "";
		};
		expect(refused({ ...written, owner: legacy.owner })).toStartWith(
			"config access: write the owners in access or in owner and speakers, not both.",
		);
		expect(refused({ ...written, speakers: legacy.speakers })).toStartWith(
			"config access: write the owners in access or in owner and speakers, not both.",
		);
		const { access: _access, ...without } = written;
		expect(refused(without)).toStartWith("config access: required");
		expect(
			refused({
				...written,
				access: { owners: [{ name: "Ada", identities: [`discord:${OWNER}`] }] },
			}),
		).toStartWith("config access.owners[0].principal: required");
		expect(
			refused({
				...written,
				access: {
					owners: [
						{ name: "Ada", principal: "ada", identities: ["token:remote-mcp"] },
					],
				},
			}),
		).toStartWith(
			"config access.owners[0].identities: the primary owner needs a discord:<user id> identity",
		);
		expect(
			refused({
				...written,
				access: {
					owners: [{ name: "Ada", principal: "ada" }],
					members: { everyone: "yes" },
				},
			}),
		).toContain(
			"config access.members.everyone: expected true, false, or a list of surfaces",
		);
		// A second owner may leave principal out.
		expect(
			refused({
				...written,
				access: {
					owners: [
						...(written.access?.owners ?? []),
						{ name: "Bo", identities: [`discord:${ADMIN}`] },
					],
				},
			}),
		).toBe("");
	});

	test("the Discord parts act for the primary owner's Discord identity, whatever their principal id", () => {
		const config = resolveConfig({
			...written,
			access: {
				owners: [
					{ name: "Ada", principal: "ada", identities: [`discord:${OWNER}`] },
				],
			},
		});
		expect(config.owner.id).toBe("ada");
		expect(discordOwnerOf(config)).toEqual({ ...config.owner, id: OWNER });
	});

	test("the 0.8 form warns once per host logger, however often the host is defined", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roundtable-access-"));
		const modelRuntime = await ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const { logger, lines } = recordingLogger();
		await defineRoundtable(
			{ ...legacy, dataDir: dir },
			{ logger, modelRuntime },
		);
		await defineRoundtable(
			{ ...legacy, dataDir: dir },
			{ logger, modelRuntime },
		);
		await defineRoundtable(
			{ ...written, dataDir: dir },
			{ logger, modelRuntime },
		);
		expect(lines.filter((line) => line.level === "warn")).toEqual([
			{ level: "warn", fields: {}, message: `deprecated: ${LEGACY_ACCESS}` },
		]);
	});
});
