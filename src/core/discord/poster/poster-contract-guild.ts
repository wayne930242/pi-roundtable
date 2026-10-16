import { expect } from "bun:test";
import {
	expectFailure,
	freshId,
	type Scenario,
	type ViewCase,
} from "./poster-contract-support.ts";

const PERSON = "900000000000000444";

export const guildScenarios: Scenario[] = [
	{
		name: "10. threads: started for a week, archived and opened again, woken by the bot; the closer comes from the audit log",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const root = await poster.say(ch, { content: "root" });
			const thread = await poster.startThread(ch, root.messageId, "talk");
			expect(world.autoArchiveMinutes(thread)).toBe(10_080);
			const open = await poster.threadState(thread);
			expect(open.archived).toBe(false);
			expect(open.locked).toBe(false);
			// The bot archives its own thread, and is told apart from a person.
			await poster.setThreadArchived(thread, true);
			const byBot = await poster.threadState(thread);
			expect(byBot.archived).toBe(true);
			expect(typeof byBot.archivedAt).toBe("number");
			expect(await poster.threadCloser(thread, byBot)).toEqual({ kind: "bot" });
			await poster.setThreadArchived(thread, false);
			expect((await poster.threadState(thread)).archived).toBe(false);
			// A post by the bot wakes an archived thread.
			await poster.setThreadArchived(thread, true);
			await poster.say(thread, { content: "wake" });
			expect((await poster.threadState(thread)).archived).toBe(false);
			// A person archives; Discord's own archiving logs no one.
			const byPerson = await newThread(poster, ch, "person");
			world.personArchives(byPerson, PERSON);
			const personState = await poster.threadState(byPerson);
			expect(await poster.threadCloser(byPerson, personState)).toEqual({
				kind: "person",
				userId: PERSON,
			});
			const quiet = await newThread(poster, ch, "quiet");
			world.autoArchive(quiet);
			const quietState = await poster.threadState(quiet);
			expect(quietState.archived).toBe(true);
			expect(await poster.threadCloser(quiet, quietState)).toEqual({
				kind: "unknown",
			});
			// An entry far from the archive's moment is not that archive.
			const stale = await newThread(poster, ch, "stale");
			world.personArchives(stale, PERSON, { auditSkew: 5 * 60_000 });
			expect(
				await poster.threadCloser(stale, await poster.threadState(stale)),
			).toEqual({ kind: "unknown" });
			// A locked thread opens again only with Manage Threads, and its closer is read from the lock.
			const locked = await newThread(poster, ch, "locked");
			world.personArchives(locked, PERSON, { lock: true });
			const lockedState = await poster.threadState(locked);
			expect(lockedState.locked).toBe(true);
			await expectFailure(poster.setThreadArchived(locked, false), "forbidden");
			expect(await poster.threadCloser(locked, lockedState)).toEqual({
				kind: "person",
				userId: PERSON,
			});
			// Without View Audit Log nobody can be told apart.
			world.auditLog(false);
			await expectFailure(
				poster.threadCloser(byPerson, personState),
				"forbidden",
			);
			world.auditLog(true);
			await expectFailure(
				poster.threadState("900000000000099999"),
				"channel_gone",
			);
			await expectFailure(
				poster.startThread(ch, "900000000000099999", "x"),
				"message_gone",
			);
		},
	},
	{
		name: "11. channels: made under a category with a topic, listed by category, deleted; full, not-a-category and missing are told apart",
		async run({ poster, world }) {
			const cat = freshId();
			const other = freshId();
			world.category(cat);
			world.category(other);
			const alpha = await poster.createTextChannel(cat, "alpha", "about alpha");
			const beta = await poster.createTextChannel(cat, "beta");
			await poster.createTextChannel(other, "gamma");
			expect(await poster.textChannels(cat)).toEqual([
				{ id: alpha, name: "alpha", topic: "about alpha" },
				{ id: beta, name: "beta", topic: "" },
			]);
			const plain = freshId();
			world.channel(plain);
			await expectFailure(poster.createTextChannel(plain, "x"), "invalid", {
				reason: "not_category",
			});
			await expectFailure(
				poster.createTextChannel("900000000000099999", "x"),
				"channel_gone",
			);
			await expectFailure(poster.createTextChannel(cat, ""), "invalid");
			await expectFailure(
				poster.createTextChannel(cat, "x".repeat(101)),
				"invalid",
			);
			await expectFailure(
				poster.textChannels("900000000000099999"),
				"channel_gone",
			);
			const small = freshId();
			world.category(small);
			world.categoryLimit(2);
			await poster.createTextChannel(small, "one");
			await poster.createTextChannel(small, "two");
			await expectFailure(
				poster.createTextChannel(small, "three"),
				"rejected",
				{ reason: "category_full" },
			);
			world.categoryLimit(50);
			expect(await poster.channelGuild(cat)).toBe(world.guildId);
			const before = world.requests();
			expect(await poster.channelGuild(cat)).toBe(world.guildId);
			expect(world.requests()).toBe(before);
			await poster.deleteChannel(alpha);
			await expectFailure(poster.deleteChannel(alpha), "channel_gone");
			expect((await poster.textChannels(cat)).map((c) => c.name)).toEqual([
				"beta",
			]);
		},
	},
	{
		name: "12. a channel is renamed twice in ten minutes; the third is not queued",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			await poster.renameChannel(ch, "first");
			await poster.renameChannel(ch, "second");
			const error = await expectFailure(
				poster.renameChannel(ch, "third"),
				"unavailable",
			);
			expect(error.retryable).toBe(true);
			await expectFailure(poster.renameChannel(ch, ""), "invalid");
			await expectFailure(poster.renameChannel(ch, "x".repeat(101)), "invalid");
		},
	},
	{
		name: "13. canView: owner, administrator and an allowing overwrite see; a denied member and a non-member do not",
		async run({ poster, world }) {
			const cases: ViewCase[] = [
				"owner",
				"administrator",
				"member-allowed",
				"member-denied",
				"non-member",
			];
			for (const how of cases) {
				const ch = freshId();
				const user = freshId();
				world.channel(ch);
				const expected = world.viewCase(ch, user, how);
				expect(await poster.canView(ch, user)).toBe(expected);
			}
		},
	},
	{
		name: "14. memberName: nickname first, then global name, then username; none for a non-member",
		async run({ poster, world }) {
			const [nick, global, plain, stranger] = [
				freshId(),
				freshId(),
				freshId(),
				freshId(),
			];
			world.member(nick, { nick: "Nick", global: "Global", username: "user1" });
			world.member(global, { global: "Global", username: "user2" });
			world.member(plain, { username: "user3" });
			expect(await poster.memberName(world.guildId, nick)).toBe("Nick");
			expect(await poster.memberName(world.guildId, global)).toBe("Global");
			expect(await poster.memberName(world.guildId, plain)).toBe("user3");
			expect(await poster.memberName(world.guildId, stranger)).toBeUndefined();
		},
	},
];

async function newThread(
	poster: import("./poster.ts").DiscordPoster,
	channelId: string,
	name: string,
): Promise<string> {
	const root = await poster.say(channelId, { content: name });
	return poster.startThread(channelId, root.messageId, name);
}
