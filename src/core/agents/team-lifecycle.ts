import {
	type CharacterSpec,
	resolveCharacter,
	suggestCharacter,
} from "../../characters/index.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { AgentChannels } from "./agent-ports.ts";
import type { Agent, AgentGroup } from "./agent-store.ts";
import {
	coordinatorOf,
	discordIdOf,
	groupLogName,
	groupRoomKey,
	groupSessionKey,
	homeScope,
	keysOf,
	roomOf,
	roomScope,
} from "./team-keys.ts";
import { categoryKind, groupTopic } from "./team-layout.ts";
import type { TeamContext } from "./team-options.ts";

/** The team's startup, fresh starts, and archiving of agents and groups. */
export class TeamLifecycle {
	readonly #ctx: TeamContext;

	constructor(ctx: TeamContext) {
		this.#ctx = ctx;
	}

	// ── Startup ────────────────────────────────────────────────────────────

	/**
	 * Inserts the seed agents, gives every active agent a channel, archives agents and groups
	 * whose channels were deleted while the assistant was down, and dresses agents without a
	 * character in the background. Without Discord channels the agents live in rooms, which need no setup, so
	 * none is made or checked.
	 */
	async start(): Promise<void> {
		const { store, channels, seeds, logger } = this.#ctx.options;
		const added = await store.seed(seeds());
		if (added.length > 0) logger.info({ added }, "seed agents added");
		if (channels) await this.#startChannels(channels);
		this.#ctx.changed();
		void this.#dressMissing();
	}

	async #startChannels(channels: AgentChannels): Promise<void> {
		const { store, logger } = this.#ctx.options;
		for (const agent of store.agents()) {
			if (agent.status !== "active") continue;
			if (!agent.channelId) {
				const id = await channels.createChannel(
					agent.name,
					agent.displayName,
					"Agents",
				);
				await store.updateAgent(agent.name, { channelId: id });
				logger.info(
					{ agent: agent.name, channel: id },
					"agent channel created",
				);
			} else if (!(await channels.exists(agent.channelId))) {
				await this.channelDeleted(agent.channelId);
			}
		}
		const layout = await channels.layout();
		for (const group of store.groups()) {
			// A group of a team that once ran without Discord lives in rooms only.
			if (group.status !== "active" || !group.channelId) continue;
			const { channelId } = group;
			if (!(await channels.exists(channelId))) {
				await this.channelDeleted(channelId);
				continue;
			}
			this.retitle(group);
			const home = layout.find((c) => c.channelIds.includes(channelId));
			if (home && categoryKind(home.name) === "Groups") continue;
			if (await channels.placeIn(channelId, "Groups"))
				logger.info({ group: group.name }, "group channel moved to Groups");
		}
	}

	/**
	 * Dresses every active agent that has no character: the seed of that name gives it (its fields
	 * over what the role suggests), otherwise the suggestion for the role, spread over the looks
	 * already worn. The picture is rendered and replaces the old hash. A failure is logged for that
	 * agent, which keeps its picture until the next start; a second pass finds nothing to do.
	 */
	async #dressMissing(): Promise<void> {
		const { store, studio, seeds, logger } = this.#ctx.options;
		const seeded = new Map(seeds().map((seed) => [seed.name, seed]));
		const worn: CharacterSpec[] = store
			.agents()
			.flatMap((agent) =>
				agent.status === "active" && agent.character ? [agent.character] : [],
			);
		for (const agent of store.agents()) {
			if (agent.status !== "active" || agent.character) continue;
			try {
				const suggested = suggestCharacter(agent, worn);
				const wanted = seeded.get(agent.name)?.character;
				const character = wanted
					? resolveCharacter(
							wanted.class !== undefined && !wanted.palette && !wanted.colors
								? { ...wanted, colors: suggested.colors }
								: wanted,
							suggested,
						)
					: suggested;
				const avatarHash = await studio.render(character);
				await store.updateAgent(agent.name, { character, avatarHash });
				worn.push(character);
				logger.info(
					{ agent: agent.name, class: character.class },
					"agent dressed",
				);
			} catch (error) {
				logger.warn({ agent: agent.name, err: error }, "agent not dressed");
			}
		}
	}

	/** Starts an agent's or every group member's conversation over; call inside the channel's queue. */
	async startFresh(channel: ChannelKey): Promise<void> {
		const { store, surfaces } = this.#ctx.options;
		const runtime = this.#ctx.options.runtime();
		const id = discordIdOf(channel);
		// A Discord channel and each room are conversations of their own: a room starts over alone.
		const room =
			id === undefined
				? roomOf(channel, surfaces?.roomSurfaces() ?? [])
				: undefined;
		const agent =
			id !== undefined
				? store.agentByChannel(id)
				: room?.kind === "agent"
					? store.agent(room.name)
					: undefined;
		if (agent?.status === "active") {
			await runtime.startFresh(
				id === undefined
					? roomScope(agent, channel).session
					: homeScope(agent).session,
			);
			this.#ctx.changed();
			return;
		}
		const group =
			id !== undefined
				? store.groupByChannel(id)
				: room?.kind === "group"
					? store.group(room.name)
					: undefined;
		if (group?.status !== "active") return;
		for (const member of group.members)
			await runtime.startFresh(groupSessionKey(group, member, channel));
		await store.catchUp(group, groupLogName(group, channel));
	}

	// ── Archive ────────────────────────────────────────────────────────────

	/** A deleted channel archives the agent or group that owned it. */
	async channelDeleted(channelId: string): Promise<void> {
		const { store } = this.#ctx.options;
		const agent = store.agentByChannel(channelId);
		if (agent) return this.#archiveAgent(agent);
		const group = store.groupByChannel(channelId);
		if (group) await this.#archiveGroup(group);
	}

	/**
	 * Archives an agent or group like a deleted channel, then keeps its channel under Archive,
	 * where no one owns it and so nothing answers; an agent or group without a Discord channel
	 * only stops answering in its rooms. Runs at once, not in the target's queue: the caller may be
	 * a member of the group it archives, and the round stops at its next turn.
	 */
	async archive(caller: AgentTurnScope, name: string): Promise<string> {
		const { store, channels, logger } = this.#ctx.options;
		const agent = store.agent(name);
		const group = agent ? undefined : store.group(name);
		const target = agent ?? group;
		if (!target)
			throw new AgentError(
				`There is no agent or group "${name}"; see agent_list.`,
			);
		if (target.status !== "active")
			throw new AgentError(`"${name}" is already archived.`);
		if (agent && coordinatorOf(store, this.#ctx.options)?.name === name)
			throw new AgentError("The coordinator cannot be archived.");
		if (agent && name === caller.name)
			throw new AgentError("You cannot archive yourself; ask another agent.");
		const { channelId } = target;
		if (agent) await this.#archiveAgent(agent);
		else if (group) await this.#archiveGroup(group);
		if (!channelId || !channels)
			return `Archived "${target.displayName}"; it no longer answers anywhere.`;
		try {
			await channels.removeWebhook(channelId);
		} catch (error) {
			logger.warn(
				{ name, err: error },
				"archived channel's webhook not removed",
			);
		}
		try {
			await channels.placeIn(channelId, "Archive");
		} catch (error) {
			logger.error({ name, err: error }, "archived channel not moved");
			return `Archived "${target.displayName}", but its channel <#${channelId}> could not be moved to Archive (${error instanceof Error ? error.message : String(error)}); it stays silent where it is.`;
		}
		return `Archived "${target.displayName}"; its channel <#${channelId}> is kept under Archive.`;
	}

	async #archiveAgent(agent: Agent): Promise<void> {
		const { store, schedules, logger } = this.#ctx.options;
		const runtime = this.#ctx.options.runtime();
		const rooms = this.#rooms();
		const left = await store.archiveAgent(agent.name);
		// The agent's Discord channel and each of its rooms are conversations of their own.
		for (const key of keysOf(store, agent.name, rooms)) {
			for (const schedule of await schedules.forChannel(key))
				await schedules.remove(schedule.id, key);
			await runtime.startFresh(key);
		}
		for (const group of left) {
			for (const seat of this.#seats(group, agent.name, rooms))
				await runtime.startFresh(seat);
			if (group.status === "active") this.retitle(group);
		}
		logger.info(
			{ agent: agent.name, groups: left.map((g) => g.name) },
			"agent archived",
		);
		this.#ctx.changed();
	}

	async #archiveGroup(group: AgentGroup): Promise<void> {
		const { store, logger } = this.#ctx.options;
		const runtime = this.#ctx.options.runtime();
		const rooms = this.#rooms();
		await store.archiveGroup(group.name);
		for (const member of group.members)
			for (const seat of this.#seats(group, member, rooms))
				await runtime.startFresh(seat);
		logger.info({ group: group.name }, "group archived");
		this.#ctx.changed();
	}

	/** The surfaces that host rooms; none for a team without a surface port. */
	#rooms(): readonly string[] {
		return this.#ctx.options.surfaces?.roomSurfaces() ?? [];
	}

	/**
	 * Every conversation of an agent's seat in a group: the Discord channel's, when the group has
	 * one, then each room's.
	 */
	#seats(
		group: AgentGroup,
		agent: string,
		rooms: readonly string[],
	): ChannelKey[] {
		return [
			...(group.channelId ? [groupSessionKey(group, agent)] : []),
			...rooms.map((surface) =>
				groupSessionKey(group, agent, groupRoomKey(surface, group.name)),
			),
		];
	}

	/** Writes a group's members and host into its channel topic, without waiting on Discord; a group without a channel has no topic. */
	retitle(group: AgentGroup): void {
		const { channels, store, logger } = this.#ctx.options;
		const { channelId } = group;
		if (!channels || !channelId) return;
		channels
			.setTopic(channelId, groupTopic(group, store))
			.catch((error: unknown) =>
				logger.warn(
					{ group: group.name, err: error },
					"group topic not updated",
				),
			);
	}
}
