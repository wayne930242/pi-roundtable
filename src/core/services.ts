import type { AgentStore } from "./agents/agent-store.ts";
import type { AgentTeam } from "./agents/agent-team.ts";
import type { AvatarStudio } from "./agents/avatar-studio.ts";
import type { DiscordSurface } from "./discord/discord-surface.ts";
import type { DispatchThreads } from "./discord/dispatch-threads.ts";
import type { OwnerCards } from "./discord/owner-cards.ts";
import type { OwnerGuard } from "./discord/owner-command.ts";
import { PluginError } from "./errors.ts";
import type { ConfirmationJudge } from "./judging/confirmation-judge.ts";
import type { BackgroundTurns } from "./modules/background/background-turns.ts";
import type { Delegator } from "./modules/delegation/delegator.ts";
import type { OwnerMemoryStore } from "./modules/memory/owner-memory-store.ts";
import type { ScheduleStore } from "./modules/schedules/schedule-store.ts";
import type { SkillRegistry } from "./modules/skills/skill-registry.ts";
import type { SkillStore } from "./modules/skills/skill-store.ts";
import type { PendingConfirmationStore } from "./runtime/pending-confirmation-store.ts";
import type { PiAgentRuntime } from "./runtime/pi-agent-runtime.ts";

/** The stores every process has, attached to the host's one pool. */
export interface CoreStores {
	/** The owner's memory. */
	memory: OwnerMemoryStore;
	schedules: ScheduleStore;
	/** Held actions, kept across a restart. */
	confirmations: PendingConfirmationStore;
	/** The agent server's agents and groups. */
	agents: AgentStore;
	skills: SkillStore;
}

/** The Discord connection and what stands on it. */
export interface CoreDiscord {
	surface: DiscordSurface;
	/** The owner's cards, which also answer the interactions of held actions. */
	cards: OwnerCards;
	guard: OwnerGuard;
	studio: AvatarStudio;
	/** The threads that carry background reports. */
	threads: DispatchThreads;
}

/** What the agent server builds. */
export interface CoreAgents {
	team: AgentTeam;
	runtime: PiAgentRuntime;
	skills: SkillRegistry;
	/** Decides whether the owner's reply approves a held action. */
	confirmations: ConfirmationJudge;
}

/** What the built-in plugins build for the plugins registered after them. */
export interface CoreServices {
	stores: CoreStores;
	discord: CoreDiscord;
	/** Turns nobody wrote: a due schedule's, a delegated task's report, a logged error's. */
	background: BackgroundTurns;
	delegator: Delegator;
	/** The agent server: its team, the runtime that runs every turn, and the skill registry. */
	agents: CoreAgents;
}

/** Reads the core's services; reading one before its built-in plugin has set up throws a PluginError. */
export type CoreAccess = {
	readonly [K in keyof CoreServices]: CoreServices[K];
};

/** Holds what the built-in plugins provide, for the plugins set up after them. */
export class CoreRegistry implements CoreAccess {
	readonly #values = new Map<keyof CoreServices, unknown>();

	/** Stores a service; a built-in plugin calls this once in its setup. */
	provide<K extends keyof CoreServices>(key: K, value: CoreServices[K]): void {
		if (this.#values.has(key))
			throw new PluginError(
				`core service ${key} is provided twice. Register only one plugin that provides it.`,
			);
		this.#values.set(key, value);
	}

	#need<K extends keyof CoreServices>(key: K): CoreServices[K] {
		if (!this.#values.has(key))
			throw new PluginError(
				`core service ${key} is not provided yet. Register the built-in plugin that provides it before the plugin that reads it.`,
			);
		return this.#values.get(key) as CoreServices[K];
	}

	get stores(): CoreStores {
		return this.#need("stores");
	}

	get discord(): CoreDiscord {
		return this.#need("discord");
	}

	get background(): BackgroundTurns {
		return this.#need("background");
	}

	get delegator(): Delegator {
		return this.#need("delegator");
	}

	get agents(): CoreAgents {
		return this.#need("agents");
	}
}
