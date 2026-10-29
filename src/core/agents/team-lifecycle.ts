import {
	type CharacterSpec,
	resolveCharacter,
	suggestCharacter,
} from "../../characters/index.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { messages } from "../i18n/index.ts";
import type { AgentChannels } from "./agent-ports.ts";
import { overBase } from "./agent-rules.ts";
import type { Agent, AgentGroup } from "./agent-store.ts";
import { refreshAvatars } from "./avatar-refresh.ts";
import {
	agentOfChannel,
	coordinatorOf,
	discordIdOf,
	groupLogName,
	groupOfChannel,
	groupSessionKey,
	homeScope,
	keysOf,
	roomScope,
	seatsOf,
} from "./team-keys.ts";
import { categoryKind, groupTopic } from "./team-layout.ts";
import type { TeamContext } from "./team-options.ts";

/** The team's startup, fresh starts, and archiving of agents and groups. */
export class TeamLifecycle {
	readonly #ctx: TeamContext;
	readonly #stopped = new AbortController();

	constructor(ctx: TeamContext) {
		this.#ctx = ctx;
	}

	/** Ends the background avatar refresh: nothing is rendered, written or logged after it. */
	stop(): void {
		this.#stopped.abort();
	}

	// ── Startup ────────────────────────────────────────────────────────────

	/**
	 * Inserts the seed agents, gives every active agent a channel, archives agents and groups
	 * whose channels were deleted while the assistant was down, and dresses agents without a
	 * character in the background, then, with `refreshAvatars`, renders every agent's picture
	 * again. Without Discord channels the agents live in rooms, which need no setup, so
	 * none is made or checked.
	 */
	async start(): Promise<void> {
		const { store, channels, seeds, logger } = this.#ctx.options;
		const added = await store.seed(seeds());
		if (added.length > 0) logger.info({ added }, "seed agents added");
		if (channels) await this.#startChannels(channels);
		this.#ctx.changed();
		void this.#dressMissing().then(async (dressed) => {
			if (this.#stopped.signal.aborted) return;
			if (dressed) this.#ctx.changed();
			if (!this.#ctx.options.refreshAvatars) return;
			// Never throws: a failure is counted per agent, and the start has already finished.
			const { store, studio, logger } = this.#ctx.options;
			const result = await refreshAvatars({
				agents: () => store.agents(),
				render: (character) => studio.render(character),
				setAvatar: (name, character, avatarHash) =>
					store.setAvatarIfLook(name, character, avatarHash),
				signal: this.#stopped.signal,
				logger,
			}).catch((error: unknown) => {
				logger.warn({ err: error }, "avatars not refreshed");
				return undefined;
			});
			if (result && !this.#stopped.signal.aborted && result.rendered > 0)
				this.#ctx.changed();
		});
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
	async #dressMissing(): Promise<boolean> {
		const { store, studio, seeds, logger } = this.#ctx.options;
		const seeded = new Map(seeds().map((seed) => [seed.name, seed]));
		const worn: CharacterSpec[] = store
			.agents()
			.flatMap((agent) =>
				agent.status === "active" && agent.character ? [agent.character] : [],
			);
		let dressed = false;
		for (const agent of store.agents()) {
			if (
				agent.status !== "active" ||
				agent.character ||
				store.hasStoredCharacter(agent.name)
			)
				continue;
			try {
				const suggested = suggestCharacter(agent, worn);
				const wanted = seeded.get(agent.name)?.character;
				const character = wanted
					? resolveCharacter(overBase(wanted, suggested), suggested)
					: suggested;
				const avatarHash = await studio.render(character);
				if (!(await store.dressIfUndressed(agent.name, character, avatarHash)))
					continue;
				dressed = true;
				worn.push(character);
				logger.info(
					{ agent: agent.name, class: character.class },
					"agent dressed",
				);
			} catch (error) {
				logger.warn({ agent: agent.name, err: error }, "agent not dressed");
			}
		}
		return dressed;
	}

	/** Starts an agent's or every group member's conversation over; call inside the channel's queue. */
	async startFresh(channel: ChannelKey): Promise<void> {
		const { store, surfaces } = this.#ctx.options;
		const runtime = this.#ctx.options.runtime();
		// A Discord channel and each room are conversations of their own: a room starts over alone.
		const agent = agentOfChannel(store, surfaces, channel);
		if (agent?.status === "active") {
			await runtime.startFresh(
				discordIdOf(channel) === undefined
					? roomScope(agent, channel).session
					: homeScope(agent).session,
			);
			this.#ctx.changed();
			return;
		}
		const group = groupOfChannel(store, surfaces, channel);
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
	 * a member of the group it archives, and the round stops at its next turn. An owner's call from
	 * outside any turn has no `caller`, so no agent is protected from archiving itself.
	 */
	async archive(
		caller: AgentTurnScope | undefined,
		name: string,
	): Promise<string> {
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
		if (agent && name === caller?.name)
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

	/**
	 * Returns an archived agent or group to the active ones: its channel leaves Archive for its
	 * category (a new channel replaces one deleted meanwhile), and it answers again from its next
	 * message. An agent does not rejoin the groups it left; a group needs all its members active.
	 */
	async restore(name: string): Promise<string> {
		const { store, channels, logger } = this.#ctx.options;
		const agent = store.agent(name);
		const group = agent ? undefined : store.group(name);
		const target = agent ?? group;
		if (!target)
			throw new AgentError(
				`There is no agent or group "${name}"; see agent_list.`,
			);
		if (target.status === "active")
			throw new AgentError(`"${name}" is not archived.`);
		if (group) store.checkRestorableGroup(name);
		// The store checks again when it restores. A member archived, or a second restore of the
		// same name, between the two checks leaves the channel moved or made with no owner; it
		// then waits under its category until the next restore claims it or an owner deletes it.
		let { channelId } = target;
		if (channels) {
			const category = agent ? "Agents" : "Groups";
			if (channelId && (await channels.exists(channelId)))
				await channels.placeIn(channelId, category);
			else if (agent || channelId)
				channelId = await channels.createChannel(
					name,
					agent ? agent.displayName : groupTopic(target as AgentGroup, store),
					category,
				);
		}
		if (agent) await store.restoreAgent(name, channelId);
		else {
			const restored = await store.restoreGroup(name, channelId);
			this.retitle(restored);
		}
		logger.info({ name, kind: agent ? "agent" : "group" }, "restored");
		this.#ctx.changed();
		return `Restored "${target.displayName}"; it answers again.${agent ? " It is in no group until it is added to one." : ""}`;
	}

	/**
	 * Deletes an archived agent or group for good, its name free again. Its carried skills are
	 * detached, and the runtime forgets its conversations (an agent's own, its seats in every
	 * group, a group's members' seats), so nothing is left for a later agent or group of that name;
	 * a Discord channel it had stays under Archive with its history, since Discord is never asked
	 * to delete one. An active agent or group is refused: archive it first, and so is an
	 * agent the host's seeds name, since the next start would seed it again.
	 */
	async remove(name: string, cleanup?: () => Promise<void>): Promise<string> {
		const { store, skills, seeds, logger } = this.#ctx.options;
		const agent = store.agent(name);
		const group = agent ? undefined : store.group(name);
		const target = agent ?? group;
		if (!target)
			throw new AgentError(
				`There is no agent or group "${name}"; see agent_list.`,
			);
		// Every start seeds the configured agents that are missing, so a deleted one would return.
		if (agent && seeds().some((seed) => seed.name === name))
			throw new AgentError(messages().agentSeededNotDeleted);
		if (target.status === "active")
			throw new AgentError(
				`"${name}" is active; archive it before deleting it.`,
			);
		await cleanup?.();
		// What a name keeps in the runtime would be picked up by the next agent or group made under it.
		const runtime = this.#ctx.options.runtime();
		const rooms = this.#rooms();
		const seats = group
			? group.members.flatMap((member) => seatsOf(group, member, rooms))
			: store.groups().flatMap((other) => seatsOf(other, name, rooms));
		const kept = [...keysOf(store, name, rooms), ...seats];
		for (const key of kept) await runtime.deleteConversation(key);
		if (agent) {
			await store.deleteAgent(name);
			const carried = skills?.carriedNames(name) ?? [];
			if (skills && carried.length > 0) await skills.attach(name, [], carried);
		} else await store.deleteGroup(name);
		logger.info({ name, kind: agent ? "agent" : "group" }, "deleted");
		this.#ctx.changed();
		return `Deleted "${target.displayName}"; the name "${name}" is free again.`;
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
			for (const seat of seatsOf(group, agent.name, rooms))
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
			for (const seat of seatsOf(group, member, rooms))
				await runtime.startFresh(seat);
		logger.info({ group: group.name }, "group archived");
		this.#ctx.changed();
	}

	/** The surfaces that host rooms; none for a team without a surface port. */
	#rooms(): readonly string[] {
		return this.#ctx.options.surfaces?.roomSurfaces() ?? [];
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
