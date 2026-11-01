import { channelOf, type Route } from "./discord-api-emulator-guild.ts";
import { add, checkCard } from "./discord-api-emulator-messages.ts";
import {
	BOT_ID,
	channelJson,
	checkAppliedTags,
	type EmuChannel,
	type EmuState,
	formError,
	HttpError,
	messageJson,
	newId,
	object,
	str,
} from "./discord-api-emulator-state.ts";

/** The forum channel type. */
const FORUM = 15;

/** Posts in a forum: a thread made with its first message, whose id is the thread's own. */
export function forumRoutes(state: EmuState): Route[] {
	return [
		[
			"POST",
			/^\/channels\/(\d+)\/threads$/,
			({ params, body }) => {
				const parent = channelOf(state, params[0]);
				const name = str(body.name);
				if (!name) throw formError("name", "BASE_TYPE_REQUIRED", "required");
				const thread: EmuChannel = {
					id: newId(state),
					type: 11,
					name,
					...(parent.guildId ? { guildId: parent.guildId } : {}),
					parentId: parent.id,
					overwrites: [],
					messages: [],
					pins: [],
					renames: [],
					thread: {
						archived: false,
						locked: false,
						archiveTimestamp: Date.now(),
						autoArchiveDuration: Number(body.auto_archive_duration ?? 1440),
					},
				};
				if (parent.type !== FORUM) {
					// A text channel makes a thread with no message; the poster never asks it to.
					state.channels.set(thread.id, thread);
					return channelJson(thread);
				}
				const first = object(body.message);
				if (Object.keys(first).length === 0)
					throw formError("message", "BASE_TYPE_REQUIRED", "required");
				thread.appliedTags = checkAppliedTags(
					parent,
					Array.isArray(body.applied_tags) ? body.applied_tags : [],
				);
				checkCard(first);
				if (
					!str(first.content) &&
					first.components === undefined &&
					!Array.isArray(first.embeds)
				)
					throw new HttpError(400, 50006, "Cannot send an empty message");
				state.channels.set(thread.id, thread);
				// The first message of a post has the post's own id.
				const message = add(
					state,
					thread,
					{ id: thread.id, authorId: BOT_ID },
					first,
				);
				return { ...channelJson(thread), message: messageJson(message) };
			},
		],
	];
}
