import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { AgentGroup } from "./agent-store.ts";
import {
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
	 * whose channels were deleted while the assistant was down, and draws missing avatars in the
	 * background.
	 */
	async start(): Promise<void> {
		const { store, channels, seeds, logger } = this.#ctx.options;
		const added = await store.seed(seeds());
		if (added.length > 0) logger.info({ added }, "seed agents added");
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
			if (group.status !== "active") continue;
			if (!(await channels.exists(group.channelId))) {
				await this.channelDeleted(group.channelId);
				continue;
			}
			this.retitle(group);
			const home = layout.find((c) => c.channelIds.includes(group.channelId));
			if (home && categoryKind(home.name) === "Groups") continue;
			if (await channels.placeIn(group.channelId, "Groups"))
				logger.info({ group: group.name }, "group channel moved to Groups");
		}
		this.#ctx.changed();
		void this.#drawMissingAvatars();
	}

	async #drawMissingAvatars(): Promise<void> {
		const { store, studio, logger } = this.#ctx.options;
		if (studio.canDraw === false) return this.#generateMissingAvatars();
		for (const agent of store.agents()) {
			if (agent.status !== "active" || agent.avatarHash) continue;
			try {
				const hash = await studio.draw(agent.avatarPrompt);
				await store.updateAgent(agent.name, { avatarHash: hash });
				logger.info({ agent: agent.name }, "avatar drawn");
			} catch (error) {
				logger.warn({ agent: agent.name, err: error }, "avatar not drawn");
			}
		}
	}

	/**
	 * Without an image provider, gives each active agent that has no picture the one made from
	 * its display name, and says so once instead of once per agent on every boot.
	 */
	async #generateMissingAvatars(): Promise<void> {
		const { store, studio, logger } = this.#ctx.options;
		if (!studio.fallback) return;
		let generated = 0;
		for (const agent of store.agents()) {
			if (agent.status !== "active" || agent.avatarHash) continue;
			try {
				const avatarHash = await studio.fallback(agent.displayName, agent.name);
				await store.updateAgent(agent.name, { avatarHash });
				generated++;
			} catch (error) {
				logger.warn({ agent: agent.name, err: error }, "avatar not generated");
			}
		}
		if (generated > 0)
			logger.info(
				{ generated },
				"no image provider is configured; agents without a picture got one generated from their display name",
			);
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
	channelDeleted(channelId: string): Promise<void> {
		return this.#archive(channelId);
	}

	/**
	 * Archives an agent or group like a deleted channel, then keeps its channel under Archive,
	 * where no one owns it and so nothing answers. Runs at once, not in the target's queue: the
	 * caller may be a member of the group it archives, and the round stops at its next turn.
	 */
	async archive(caller: AgentTurnScope, name: string): Promise<string> {
		const { store, entryChannelId, channels, logger } = this.#ctx.options;
		const agent = store.agent(name);
		const group = agent ? undefined : store.group(name);
		const target = agent ?? group;
		if (!target)
			throw new AgentError(
				`There is no agent or group "${name}"; see agent_list.`,
			);
		if (target.status !== "active")
			throw new AgentError(`"${name}" is already archived.`);
		if (agent && agent.channelId === entryChannelId)
			throw new AgentError("The coordinator cannot be archived.");
		if (agent && name === caller.name)
			throw new AgentError("You cannot archive yourself; ask another agent.");
		const channelId = target.channelId;
		if (!channelId) throw new AgentError(`${name} has no channel.`);
		await this.#archive(channelId);
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

	async #archive(channelId: string): Promise<void> {
		const { store, schedules, logger } = this.#ctx.options;
		const runtime = this.#ctx.options.runtime();
		const rooms = this.#rooms();
		const agent = store.agentByChannel(channelId);
		if (agent) {
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
			return;
		}
		const group = store.groupByChannel(channelId);
		if (!group) return;
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

	/** Every conversation of an agent's seat in a group: the Discord channel's, then each room's. */
	#seats(
		group: AgentGroup,
		agent: string,
		rooms: readonly string[],
	): ChannelKey[] {
		return [
			groupSessionKey(group, agent),
			...rooms.map((surface) =>
				groupSessionKey(group, agent, groupRoomKey(surface, group.name)),
			),
		];
	}

	/** Writes a group's members and host into its channel topic, without waiting on Discord. */
	retitle(group: AgentGroup): void {
		const { channels, store, logger } = this.#ctx.options;
		channels
			.setTopic(group.channelId, groupTopic(group, store))
			.catch((error: unknown) =>
				logger.warn(
					{ group: group.name, err: error },
					"group topic not updated",
				),
			);
	}
}
