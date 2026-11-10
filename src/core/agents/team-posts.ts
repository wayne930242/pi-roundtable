import { supportOf } from "../domain/block-support.ts";
import type {
	ChannelKey,
	IntercomCard,
	ReplyFile,
} from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { InterimPosts } from "../domain/interim.ts";
import { chunksFor } from "../presentation/reply-chunks.ts";
import type { Agent } from "./agent-store.ts";
import type { TeamTurnsOptions } from "./team-turn-types.ts";

/**
 * How the team's turns reach a place: whether a reply there may carry files, how its text is cut,
 * and the interim posts and replies under the agent's name, which the place's provider carries.
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
	 * Whether a reply in the channel may carry files: only when the surface that serves it declares
	 * `supportsFiles`, since a reply with files that surface refuses is lost whole.
	 */
	carriesFiles(channel: ChannelKey): boolean {
		return this.#options.surfaces?.of(channel)?.supportsFiles === true;
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
	 * during the turn shows; none in a channel no agent or group owns any more, and none where the
	 * place's provider shows none.
	 */
	interim(channel: ChannelKey, agent: Agent): InterimPosts | undefined {
		const { places } = this.#options;
		const provider = places.providerOf(channel);
		const first = provider?.interim?.(channel, this.author(agent));
		if (!provider || !first) return undefined;
		return {
			...(first.tools === false ? { tools: false } : {}),
			// The poster cuts text for the surface the posts go to.
			...(first.blocks ? { blocks: first.blocks } : {}),
			...(first.blockText ? { blockText: first.blockText } : {}),
			post: async (text) => {
				if (!places.ownerKind(channel))
					throw new AgentError(`${channel} is archived`);
				const posts = provider.interim?.(
					channel,
					this.author(this.#current(agent)),
				);
				if (!posts) throw new AgentError(`${channel} shows no interim posts`);
				return posts.post(text);
			},
		};
	}

	/**
	 * Posts under the agent's name through the place's provider. A channel no agent or group owns
	 * any more, archived while a turn ran, gets nothing, so its webhook is not made again.
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
		const { places, logger } = this.#options;
		if (!places.ownerKind(channel)) {
			logger.info(
				{ channel, agent: as.name },
				"post to an archived channel dropped",
			);
			return;
		}
		const provider = places.providerOf(channel);
		if (!provider)
			throw new AgentError(`no surface serves the place ${channel}`);
		const { threadId, thinking, chunks, files, failed, intercom } = body;
		return provider.post(channel, {
			author: this.author(as),
			...(thinking ? { thinking } : {}),
			chunks,
			...(files?.length ? { files } : {}),
			...(threadId === undefined ? {} : { thread: threadId }),
			...(failed ? { failed } : {}),
			...(intercom ? { intercom } : {}),
		});
	}

	/** Who speaks for the agent: its name and look. */
	author(agent: Agent) {
		return {
			name: agent.displayName,
			agent: agent.name,
			avatarUrl: this.#options.studio.url(agent.avatarHash),
		};
	}
}
