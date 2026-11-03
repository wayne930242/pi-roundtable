import { expect } from "bun:test";
import {
	expectFailure,
	freshId,
	type PosterSubject,
	type Scenario,
} from "./poster-contract-support.ts";

const REASON = "sync roles for the contract";

/** A guild with a bot role above the roles it may give, and one member who keeps a role of their own. */
function arrange({ world }: PosterSubject) {
	const keep = freshId();
	const low = freshId();
	const mid = freshId();
	const botRole = freshId();
	const high = freshId();
	const managed = freshId();
	world.role({ id: keep, name: "keep", position: 1 });
	world.role({ id: low, name: "low", position: 2 });
	world.role({ id: mid, name: "mid", position: 3 });
	world.role({ id: botRole, name: "bot", position: 5 });
	world.role({ id: high, name: "high", position: 9 });
	world.role({ id: managed, name: "managed", position: 2, managed: true });
	world.botRoles([botRole]);
	const member = freshId();
	world.member(member, { username: "ann" });
	world.holdRoles(member, [keep]);
	return { keep, low, mid, botRole, high, managed, member };
}

const sorted = (ids: readonly string[]) => [...ids].sort();

export const memberScenarios: Scenario[] = [
	{
		name: "15. memberRoles: the ids a member holds; none for someone who is not a member",
		async run(subject) {
			const { poster, world } = subject;
			const { keep, low, member } = arrange(subject);
			expect(await poster.memberRoles(world.guildId, member)).toEqual([keep]);
			world.holdRoles(member, [keep, low]);
			expect(
				sorted((await poster.memberRoles(world.guildId, member)) ?? []),
			).toEqual(sorted([keep, low]));
			expect(
				await poster.memberRoles(world.guildId, freshId()),
			).toBeUndefined();
			await expectFailure(poster.memberRoles("12", member), "invalid");
		},
	},
	{
		name: "16. addMemberRoles and removeMemberRoles touch only the roles named, with the audit-log reason",
		async run(subject) {
			const { poster, world } = subject;
			const { keep, low, mid, member } = arrange(subject);
			await poster.addMemberRoles(world.guildId, member, [low, mid], REASON);
			expect(sorted(world.rolesHeldBy(member))).toEqual(
				sorted([keep, low, mid]),
			);
			// A role the member holds is left as it is.
			await poster.addMemberRoles(world.guildId, member, [low], REASON);
			expect(sorted(world.rolesHeldBy(member))).toEqual(
				sorted([keep, low, mid]),
			);
			await poster.removeMemberRoles(world.guildId, member, [low], REASON);
			expect(sorted(world.rolesHeldBy(member))).toEqual(sorted([keep, mid]));
			// A role the member lacks is left alone, and so is every role not named.
			await poster.removeMemberRoles(world.guildId, member, [low], REASON);
			expect(sorted(world.rolesHeldBy(member))).toEqual(sorted([keep, mid]));
			const changes = world.roleChanges();
			expect(changes.length).toBeGreaterThanOrEqual(4);
			for (const change of changes) {
				expect(change.reason).toBe(REASON);
				expect(change.userId).toBe(member);
			}
			expect(changes[0]).toMatchObject({ action: "add", roleId: low });
			expect(changes[1]).toMatchObject({ action: "add", roleId: mid });
		},
	},
	{
		name: "17. roles the bot may not give are refused before any is given: @everyone, managed, at or above its own, unknown; so are a non-member and bad arguments",
		async run(subject) {
			const { poster, world } = subject;
			const { low, botRole, high, managed, member } = arrange(subject);
			const before = world.roleChanges().length;
			const refused = async (
				roleIds: string[],
				kind: "invalid" | "forbidden" | "rejected",
				reason?: "role_unassignable" | "unknown_role",
			) => {
				for (const verb of ["addMemberRoles", "removeMemberRoles"] as const)
					await expectFailure(
						poster[verb](world.guildId, member, roleIds, REASON),
						kind,
						reason ? { reason } : {},
					);
			};
			await refused([world.guildId], "invalid", "role_unassignable");
			await refused([managed], "forbidden", "role_unassignable");
			await refused([botRole], "forbidden", "role_unassignable");
			await refused([high], "forbidden", "role_unassignable");
			await refused([freshId()], "rejected", "unknown_role");
			// One refused role among allowed ones gives none of them.
			await refused([low, high], "forbidden", "role_unassignable");
			expect(world.rolesHeldBy(member)).not.toContain(low);
			expect(world.roleChanges().length).toBe(before);
			const stranger = freshId();
			await expectFailure(
				poster.addMemberRoles(world.guildId, stranger, [low], REASON),
				"rejected",
				{ reason: "not_member" },
			);
			await expectFailure(
				poster.addMemberRoles(world.guildId, member, [], REASON),
				"invalid",
			);
			await expectFailure(
				poster.addMemberRoles(world.guildId, member, ["x"], REASON),
				"invalid",
			);
			await expectFailure(
				poster.addMemberRoles(world.guildId, member, [low], "  "),
				"invalid",
			);
			await expectFailure(
				poster.addMemberRoles(world.guildId, member, [low], "r".repeat(513)),
				"invalid",
			);
			await expectFailure(
				poster.removeMemberRoles(
					world.guildId,
					member,
					Array.from({ length: 21 }, () => freshId()),
					REASON,
				),
				"invalid",
			);
		},
	},
	{
		name: "18. ensureRole: finds a role by exact name and never edits it; makes one with no permissions when there is none, once for calls at the same time",
		async run(subject) {
			const { poster, world } = subject;
			const { low, member } = arrange(subject);
			// An existing role is returned and nothing is made.
			expect(await poster.ensureRole(world.guildId, "low", REASON)).toBe(low);
			expect(world.roleChanges().filter((c) => c.action === "create")).toEqual(
				[],
			);
			// A managed role of the name is not the one; a made role is.
			const clash = freshId();
			world.role({ id: clash, name: "marker", position: 2, managed: true });
			const [first, second] = await Promise.all([
				poster.ensureRole(world.guildId, "marker", REASON),
				poster.ensureRole(world.guildId, "marker", REASON),
			]);
			expect(first).toBe(second);
			expect(first).not.toBe(clash);
			expect(world.roleIdsNamed("marker").filter((id) => id !== clash)).toEqual(
				[first],
			);
			const created = world.roleChanges().filter((c) => c.action === "create");
			expect(created).toHaveLength(1);
			expect(created[0]).toMatchObject({ roleId: first, reason: REASON });
			expect(await poster.ensureRole(world.guildId, "marker", REASON)).toBe(
				first,
			);
			// The role made sits below the bot's, so it can be given at once.
			await poster.addMemberRoles(world.guildId, member, [first], REASON);
			expect(world.rolesHeldBy(member)).toContain(first);
			// Of several with the name, the oldest.
			const older = freshId();
			const newer = freshId();
			world.role({ id: newer, name: "twin", position: 2 });
			world.role({ id: older, name: "twin", position: 2 });
			const oldest = BigInt(older) < BigInt(newer) ? older : newer;
			expect(await poster.ensureRole(world.guildId, "twin", REASON)).toBe(
				oldest,
			);
			await expectFailure(
				poster.ensureRole(world.guildId, "", REASON),
				"invalid",
			);
			await expectFailure(
				poster.ensureRole(world.guildId, "@everyone", REASON),
				"invalid",
			);
			await expectFailure(
				poster.ensureRole(world.guildId, "x".repeat(101), REASON),
				"invalid",
			);
			await expectFailure(
				poster.ensureRole(world.guildId, "ok", ""),
				"invalid",
			);
		},
	},
];
