import { channelKey, parseChannelKey } from "../contract/surface.ts";
import { supportOf } from "../domain/block-support.ts";
import type {
	ChannelKey,
	IntercomCard,
	PostAuthor,
	ReplyFile,
} from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { InterimPosts } from "../domain/interim.ts";
import { chunksFor } from "../presentation/reply-chunks.ts";
import type { Agent } from "./agent-store.ts";
import { channelIdOf, discordIdOf } from "./team-keys.ts";
import type { TeamTurnsOptions } from "./team-turn-types.ts";

/**
 * How the team's turns reach a place: whether a reply there may carry files, how its text is cut,
 * and the interim posts and replies under the agent's name, which Discord's channels or a room's
 * surface carry.
 */
export class TeamPosts {
	readonly #options: TeamTurnsOptions;

	constructor(options: TeamTurnsOptions) {
		this.#options = options;
	}

	/** The agent's latest row, so a display name or avatar changed during the turn shows. */
	#current(agent: Agent): Agent {
		return this.#options.store.agent(agent.name) ?? agent;
	}

	/**
	 * Whether a reply in the channel may carry files: Discord's webhook posts do; a room only when
	 * its surface declares `supportsFiles`, since a reply with files that surface refuses is lost whole.
	 */
	carriesFiles(channel: ChannelKey): boolean {
		return (
			discordIdOf(channel) !== undefined ||
			this.#options.surfaces?.of(channel)?.supportsFiles === true
		);
	}

	/** What the surface that serves the channel does there (see `supportOf`). */
	support(channel: ChannelKey) {
		return supportOf(
			this.#options.surfaces?.of(channel),
			channel,
			this.#options.surfaces?.lang,
		);
	}

	/** The messages that carry an agent's text to the channel, cut for the surface that serves it. */
	chunks(channel: ChannelKey, text: string): string[] {
		return chunksFor(this.support(channel), text);
	}

	/**
	 * The turn's interim posts under the agent's name, read as each goes out so a name changed
	 * during the turn shows; none in a channel no agent or group owns any more.
	 */
	interim(channel: ChannelKey, agent: Agent): InterimPosts | undefined {
		const { places, channels, studio, surfaces } = this.#options;
		if (discordIdOf(channel) === undefined) {
			// A room's interim posts are its surface's, under the agent as author.
			const first = surfaces?.interim(channel, this.author(agent));
			if (!surfaces || !first) return undefined;
			return {
				...(first.tools === false ? { tools: false } : {}),
				// The poster cuts text for the surface the posts go to.
				...(first.blocks ? { blocks: first.blocks } : {}),
				...(first.blockText ? { blockText: first.blockText } : {}),
				post: async (text) => {
					if (!places.ownerKind(channel))
						throw new AgentError(`${channel} is archived`);
					const posts = surfaces.interim(
						channel,
						this.author(this.#current(agent)),
					);
					if (!posts) throw new AgentError(`${channel} shows no interim posts`);
					return posts.post(text);
				},
			};
		}
		if (!channels?.interim) return undefined;
		const interim = channels.interim.bind(channels);
		return {
			post: async (text) => {
				if (!places.ownerKind(channel))
					throw new AgentError(`${channel} is archived`);
				const as = this.#current(agent);
				return interim(channelIdOf(channel), {
					name: as.displayName,
					avatarUrl: studio.url(as.avatarHash),
				}).post(text);
			},
		};
	}

	/**
	 * Posts under the agent's name. A channel no agent or group owns any more, archived while a
	 * turn ran, gets nothing, so its webhook is not made again.
	 */
	async post(
		channel: ChannelKey,
		as: Agent,
		body: {
			thinking?: string;
			chunks: string[];
			files?: ReplyFile[];
			threadId?: string;
			failed?: true;
			intercom?: IntercomCard;
		},
	): Promise<void> {
		const { places, channels, studio, surfaces, logger } = this.#options;
		if (!places.ownerKind(channel)) {
			logger.info(
				{ channel, agent: as.name },
				"post to an archived channel dropped",
			);
			return;
		}
		// Discord ignores `failed`.
		const { failed, ...rest } = body;
		if (discordIdOf(channel) === undefined) {
			if (!surfaces)
				throw new AgentError(`no surface serves the room ${channel}`);
			const { thinking, chunks, files, threadId, intercom } = rest;
			// A thread of the room's surface is a channel of that surface, and speaks there.
			return surfaces.sendReply(
				threadId === undefined
					? channel
					: channelKey(parseChannelKey(channel).surface, threadId),
				{
					...(thinking ? { thinking } : {}),
					chunks,
					...(files?.length ? { files } : {}),
					author: this.author(as),
					...(failed ? { failed } : {}),
					...(intercom ? { intercom } : {}),
				},
			);
		}
		if (!channels) throw new AgentError(`no Discord channels serve ${channel}`);
		return channels.post(channelIdOf(channel), {
			name: as.displayName,
			avatarUrl: studio.url(as.avatarHash),
			...rest,
		});
	}

	/** Who speaks for the agent on a surface that shows authors. */
	author(agent: Agent): PostAuthor {
		return { name: agent.displayName, agent: agent.name };
	}
}
