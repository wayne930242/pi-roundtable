import { expect } from "bun:test";
import type { DiscordCard } from "./poster.ts";
import {
	expectFailure,
	freshId,
	type Scenario,
} from "./poster-contract-support.ts";

const CARD: DiscordCard = { title: "Ticket", sections: ["first"] };

/** The scenarios of a forum post that has archived. */
export const archivedScenarios: Scenario[] = [
	{
		name: "23. an archived forum post: a retag, a rename and an edit of its first message open it again; another message's edit is refused until the thread is opened; a locked post stays closed",
		async run({ poster, world }) {
			const forum = freshId();
			world.forum(forum);
			const [bug, idea] = await poster.setForumTags(forum, [
				{ name: "bug" },
				{ name: "idea" },
			]);
			if (!(bug && idea)) throw new Error("the forum made no tags");
			const post = await poster.createForumPost(forum, {
				name: "ticket",
				card: CARD,
				appliedTags: [bug.id],
			});
			const thread = post.threadId;
			const reply = await poster.sayCard(thread, CARD);
			const archived = async () => (await poster.threadState(thread)).archived;
			// New tags go with `archived: false`, so the post is open afterwards.
			world.autoArchive(thread);
			expect(await archived()).toBe(true);
			await poster.setPostTags(thread, [idea.id]);
			expect(world.appliedTags(thread)).toEqual([idea.id]);
			expect(await archived()).toBe(false);
			// So does a rename.
			world.autoArchive(thread);
			await poster.renameChannel(thread, "ticket (done)");
			expect(await archived()).toBe(false);
			// The first message has the post's id: the poster opens the post and edits it.
			world.autoArchive(thread);
			await poster.editCard(thread, post.messageId, {
				...CARD,
				title: "Ticket 2",
			});
			expect(await archived()).toBe(false);
			expect(world.isCard(thread, post.messageId)).toBe(true);
			// Another message cannot open the thread: Discord refuses the edit (50083).
			world.autoArchive(thread);
			const refused = await expectFailure(
				poster.editCard(thread, reply.messageId, { ...CARD, title: "Reply" }),
				"rejected",
			);
			expect(refused.discordCode).toBe(50083);
			expect(await archived()).toBe(true);
			await poster.setThreadArchived(thread, false);
			await poster.editCard(thread, reply.messageId, {
				...CARD,
				title: "Reply",
			});
			// A locked post is opened only with Manage Threads, which the bot does not have.
			world.personArchives(thread, freshId(), { lock: true });
			await expectFailure(poster.setPostTags(thread, [bug.id]), "forbidden");
			await expectFailure(poster.renameChannel(thread, "again"), "forbidden");
			await expectFailure(
				poster.editCard(thread, post.messageId, CARD),
				"forbidden",
			);
			expect(world.appliedTags(thread)).toEqual([idea.id]);
		},
	},
];
