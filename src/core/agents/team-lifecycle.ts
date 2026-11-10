import {
	type CharacterSpec,
	resolveCharacter,
	suggestCharacter,
} from "../../characters/index.ts";
import type { PlaceCheck, PlaceProvider } from "../contract/places.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { messages } from "../i18n/index.ts";
import { isHelper, overBase } from "./agent-rules.ts";
import type { Agent, AgentGroup } from "./agent-store.ts";
import { refreshAvatars } from "./avatar-refresh.ts";
import { TeamHelpers } from "./team-helpers.ts";
import { coordinatorOf } from "./team-keys.ts";
import type { TeamContext } from "./team-options.ts";
import { type PlaceWish, TeamPlaceWrites } from "./team-place-writes.ts";
import { groupTopic } from "./team-text.ts";

/** The team's startup, fresh starts, and archiving of agents and groups. */
export class TeamLifecycle {
	readonly #ctx: TeamContext;
	readonly #stopped = new AbortController();
	/** The surfaces whose deleted places the team listens for, so a second start listens once. */
	readonly #listening = new Set<string>();
	/** The writes to the places of agents and groups. */
	readonly #places: TeamPlaceWrites;
	/** The temp knights: their archive, restore and sweep, which archiving a parent calls. */
	readonly helpers: TeamHelpers;

	constructor(ctx: TeamContext) {
		this.#ctx = ctx;
		this.#places = new TeamPlaceWrites(ctx);
		this.helpers = new TeamHelpers(ctx, (agent) => this.#archiveAgent(agent));
	}

	/** Ends the background avatar refresh: nothing is rendered, written or logged after it. */
	stop(): void {
		this.#stopped.abort();
		this.helpers.stop();
	}

	// ── Startup ────────────────────────────────────────────────────────────

	/**
	 * Inserts the seed agents, gives every active agent a place on each stored provider that makes
	 * them, archives agents and groups whose places were deleted while the assistant was down, and
	 * dresses agents without a character in the background, then, with `refreshAvatars`, renders
	 * every agent's picture again. Rooms exist with the name, so none is made or checked.
	 */
	async start(): Promise<void> {
		const { store, seeds, logger } = this.#ctx.options;
		const added = await store.seed(seeds());
		if (added.length > 0) logger.info({ added }, "seed agents added");
		for (const provider of this.#ctx.options.places.stored())
			await this.#startPlaces(provider);
		this.#ctx.changed();
		await this.helpers.reconcile();
		this.helpers.startSweeper();
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

	/**
	 * One stored provider's places at start: an active agent that has none gets one (not a temp
	 * knight, which lives in its rooms until reached), a place the provider finds `gone` archives
	 * its owner as a deletion would, and a `foreign` one (a channel of a server the team left) is
	 * dropped and made again, with nobody archived. An active group's place is checked the same
	 * way, then given its topic again and put where it belongs.
	 */
	async #startPlaces(provider: PlaceProvider): Promise<void> {
		const { store, places } = this.#ctx.options;
		this.#listen(provider);
		for (const agent of store.agents()) {
			if (agent.status !== "active") continue;
			const wish = this.#wish(agent);
			const id = places.idOf(wish, provider.surface);
			if (id === undefined) {
				if (!isHelper(agent)) await this.#make(provider, wish);
				continue;
			}
			const found = await this.#checked(provider, wish, id);
			if (found === "gone") await this.#archiveAgent(agent);
			else if (found === "foreign") {
				await this.#drop(provider, wish);
				if (!isHelper(agent)) await this.#make(provider, wish);
			}
		}
		for (const group of store.groups()) {
			if (group.status !== "active") continue;
			const wish = this.#wish(group);
			const id = places.idOf(wish, provider.surface);
			if (id === undefined) continue;
			const found = await this.#checked(provider, wish, id);
			if (found === "unknown") continue;
			if (found === "gone") {
				await this.#archiveGroup(group);
				continue;
			}
			if (found === "foreign") {
				await this.#drop(provider, wish);
				await this.#make(provider, wish);
				continue;
			}
			this.retitle(group);
			// Without `check` a place is taken as it is, as an agent's is: `ensure` would make a deleted one again.
			if (!provider.ensure || !provider.check) continue;
			const kept = await provider.ensure({ ...wish, existing: id });
			if (kept !== id) await this.#record(provider, wish, kept);
		}
	}

	/**
	 * What the provider says of a stored place; `ok` when it cannot check. A check that fails says
	 * nothing of the place: it is logged and `unknown` returned, so the place is kept as it is and
	 * the start goes on.
	 */
	async #checked(
		provider: PlaceProvider,
		wish: PlaceWish,
		id: string,
	): Promise<PlaceCheck | "unknown"> {
		try {
			return (await provider.check?.(id)) ?? "ok";
		} catch (error) {
			this.#ctx.options.logger.warn(
				{ [wish.kind]: wish.name, surface: provider.surface, err: error },
				"place not checked; kept as it is",
			);
			return "unknown";
		}
	}

	/** Archives the owner of a place the provider reports deleted, once it says so. */
	#listen(provider: PlaceProvider): void {
		const { places, queue, logger } = this.#ctx.options;
		if (!provider.onRemoved || this.#listening.has(provider.surface)) return;
		this.#listening.add(provider.surface);
		provider.onRemoved((id) => {
			if (this.#stopped.signal.aborted) return;
			const key = places.keyOfId(provider.surface, id);
			if (key === undefined || !places.ownerKind(key)) return;
			void queue
				.run(key, () => this.placeRemoved(key))
				.catch((error: unknown) =>
					logger.error({ channel: key, err: error }, "archive failed"),
				);
		});
	}

	/** The owner of a place as a place wish: who it belongs to and the texts it is shown under. */
	#wish(owner: Agent | AgentGroup): PlaceWish {
		const { store } = this.#ctx.options;
		const group = "members" in owner;
		return {
			kind: group ? "group" : "agent",
			name: owner.name,
			displayName: owner.displayName,
			topic: group ? groupTopic(owner, store) : owner.displayName,
		};
	}

	/** Makes the owner's place on a provider that makes them, and records it. */
	async #make(provider: PlaceProvider, wish: PlaceWish): Promise<void> {
		if (!provider.ensure) return;
		const id = await provider.ensure({ ...wish });
		await this.#record(provider, wish, id);
		this.#ctx.options.logger.info(
			{ [wish.kind]: wish.name, surface: provider.surface, place: id },
			`${wish.kind} place created`,
		);
	}

	#record(provider: PlaceProvider, wish: PlaceWish, id: string): Promise<void> {
		return this.#places.record(wish, [{ surface: provider.surface, id }]);
	}

	/** Forgets the owner's place on the provider's surface, which another server's channel is. */
	async #drop(provider: PlaceProvider, wish: PlaceWish): Promise<void> {
		await this.#ctx.options.store.clearPlace(
			wish.kind,
			wish.name,
			provider.surface,
		);
		this.#ctx.options.logger.warn(
			{ [wish.kind]: wish.name, surface: provider.surface },
			`${wish.kind} place is another server's; dropped`,
		);
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
		const { store, places } = this.#ctx.options;
		const runtime = this.#ctx.options.runtime();
		// Each place is a conversation of its own: a room starts over alone.
		const agent = places.agentOf(channel);
		if (agent?.status === "active") {
			await runtime.startFresh(places.scopeOf(agent, channel).session);
			this.#ctx.changed();
			return;
		}
		const group = places.groupOf(channel);
		if (group?.status !== "active") return;
		for (const member of group.members)
			await runtime.startFresh(places.seatKey(group, member, channel));
		await store.catchUp(group, places.logName(group, channel));
	}

	// ── Archive ────────────────────────────────────────────────────────────

	/** A place deleted on its surface archives the agent or group that owned it. */
	async placeRemoved(key: ChannelKey): Promise<void> {
		const { places } = this.#ctx.options;
		const agent = places.agentOf(key);
		if (agent) return this.#archiveAgent(agent);
		const group = places.groupOf(key);
		if (group) await this.#archiveGroup(group);
	}

	/**
	 * Archives an agent or group like a deleted place, then keeps its places where no one owns them
	 * and so nothing answers (a channel under Archive, for one); an agent or group without a
	 * stored place only stops answering in its rooms. Runs at once, not in the target's queue: the caller may be
	 * a member of the group it archives, and the round stops at its next turn. An owner's call from
	 * outside any turn has no `caller`, so no agent is protected from archiving itself.
	 */
	async archive(
		caller: AgentTurnScope | undefined,
		name: string,
	): Promise<string> {
		const { store } = this.#ctx.options;
		const agent = store.agent(name);
		const group = agent ? undefined : store.group(name);
		const target = agent ?? group;
		if (!target)
			throw new AgentError(
				`There is no agent or group "${name}"; see agent_list.`,
			);
		if (target.status !== "active")
			throw new AgentError(`"${name}" is already archived.`);
		if (
			agent &&
			coordinatorOf(store, this.#ctx.options.places, this.#ctx.options)
				?.name === name
		)
			throw new AgentError("The coordinator cannot be archived.");
		if (agent && name === caller?.name)
			throw new AgentError("You cannot archive yourself; ask another agent.");
		// A temp knight's place is a thread of its parent's channel, closed rather than moved.
		if (agent && isHelper(agent)) {
			await this.helpers.archiveOne(agent);
			return `Archived "${target.displayName}"; its history stays readable, and it no longer answers.`;
		}
		if (agent) await this.#archiveAgent(agent);
		else if (group) await this.#archiveGroup(group);
		const kept = await this.#places.keep(this.#wish(target), false);
		return `Archived "${target.displayName}"${kept || "; it no longer answers anywhere."}`;
	}

	/**
	 * Returns an archived agent or group to the active ones: its places leave the archive for where
	 * they belong (a new place replaces one deleted meanwhile), and it answers again from its next
	 * message. An agent does not rejoin the groups it left; a group needs all its members active.
	 */
	async restore(name: string): Promise<string> {
		const { store, logger } = this.#ctx.options;
		const agent = store.agent(name);
		const group = agent ? undefined : store.group(name);
		const target = agent ?? group;
		if (!target)
			throw new AgentError(
				`There is no agent or group "${name}"; see agent_list.`,
			);
		if (target.status === "active")
			throw new AgentError(`"${name}" is not archived.`);
		if (agent && isHelper(agent)) {
			await this.helpers.restoreOne(agent);
			return `Restored "${target.displayName}"; it answers again.`;
		}
		if (group) store.checkRestorableGroup(name);
		// The store checks again when it restores. A member archived, or a second restore of the
		// same name, between the two checks leaves the place moved or made with no owner; it
		// then waits where it is until the next restore claims it or an owner deletes it.
		const wish = this.#wish(target);
		await this.#places.record(wish, await this.#places.bringBack(wish));
		if (agent) await store.restoreAgent(name);
		else this.retitle(await store.restoreGroup(name));
		logger.info({ name, kind: agent ? "agent" : "group" }, "restored");
		this.#ctx.changed();
		return `Restored "${target.displayName}"; it answers again.${agent ? " It is in no group until it is added to one." : ""}`;
	}

	/**
	 * Deletes an archived agent or group for good, its name free again. Its carried skills are
	 * detached, and the runtime forgets its conversations (an agent's own, its seats in every
	 * group, a group's members' seats), so nothing is left for a later agent or group of that name;
	 * a place it had stays kept with its history on its surface, since no provider is asked to
	 * delete one. An active agent or group is refused: archive it first, and so is an
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
		// A parent's archived temp knights go with it; none is left naming a parent that is gone.
		if (agent)
			for (const helper of store.helpersOf(name))
				await this.remove(helper.name);
		// What a name keeps in the runtime would be picked up by the next agent or group made under it.
		const runtime = this.#ctx.options.runtime();
		const { places } = this.#ctx.options;
		const seats = group
			? group.members.flatMap((member) => places.seatsOf(group, member))
			: store.groups().flatMap((other) => places.seatsOf(other, name));
		const kept = [...places.keysOf(name), ...seats];
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
		const { places } = this.#ctx.options;
		// A parent's temp knights are archived first: they have no place of their own once it is gone.
		for (const helper of store.helpersOf(agent.name, "active"))
			await this.helpers.archiveOne(helper);
		const left = await store.archiveAgent(agent.name);
		// Each of the agent's places is a conversation of its own.
		for (const key of places.keysOf(agent.name)) {
			for (const schedule of await schedules.forChannel(key))
				await schedules.remove(schedule.id, key);
			await runtime.startFresh(key);
		}
		for (const group of left) {
			for (const seat of places.seatsOf(group, agent.name))
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
		const { places } = this.#ctx.options;
		await store.archiveGroup(group.name);
		for (const member of group.members)
			for (const seat of places.seatsOf(group, member))
				await runtime.startFresh(seat);
		logger.info({ group: group.name }, "group archived");
		this.#ctx.changed();
	}

	/** Writes a group's members and host into the topic of its places, without waiting on the surface; a group without a place has no topic. */
	retitle(group: AgentGroup): void {
		this.#places.describe(this.#wish(group));
	}
}
