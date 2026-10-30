import type { CharacterInput } from "../../characters/index.ts";
import { helpersOf } from "../config/helpers.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import type { Speaker } from "../speakers.ts";
import { toolTiers } from "../tool-tiers.ts";
import { isHelper } from "./agent-rules.ts";
import type { Agent } from "./agent-store.ts";
import { keysOf } from "./team-keys.ts";
import type { TeamContext } from "./team-options.ts";

/** The team's way of making an agent, which `createHelper` uses to make a temp knight. */
export type MakeAgent = (
	who: {
		speaker: Speaker;
		by: string;
		creator: Agent;
		parent: Agent;
		/** The conversation the temp knight is made from; only it and the owners may message the temp knight. */
		origin?: string;
	},
	fields: {
		name: string;
		displayName: string;
		prompt: string;
		character?: CharacterInput;
		skills?: string[];
	},
	settings: { model?: string | undefined; thinking?: string | undefined },
) => Promise<{ agent: Agent; text: string }>;

/**
 * The agent tool: a knight makes a temp knight for one task. It is a real agent with its own
 * prompt, picture and place (a thread of the parent's channel on Discord, a room on the web),
 * that runs the parent's model unless told otherwise. The task goes to it as a message from the
 * caller, so the answer comes back to the caller's conversation as a new turn. At a cap the
 * caller's oldest finished temp knight is archived to make room; with none finished, it refuses.
 */
export async function createHelper(
	ctx: TeamContext,
	make: MakeAgent,
	caller: AgentTurnScope,
	input: {
		name?: string;
		displayName: string;
		prompt: string;
		task: string;
		character?: CharacterInput;
		skills?: string[];
		model?: string;
		thinking?: string;
	},
): Promise<string> {
	const { store, logger } = ctx.options;
	const limits = helpersOf(ctx.options.helpers);
	if (!limits)
		throw new AgentError("Temp knights are switched off on this host.");
	const speaker = ctx.turns.speakerOf(caller);
	if (!speaker)
		throw new AgentError(
			"helper_create can only be used during an agent turn.",
		);
	const parent = store.activeAgent(caller.name);
	if (isHelper(parent))
		throw new AgentError(
			`You are a temp knight of "${parent.parent}" and cannot make temp knights; ask it to.`,
		);
	const { task, name: given, model, thinking, ...rest } = input;
	// A temp knight never gets more than its parent unless the speaker could grant it by hand.
	const tiers = ctx.options.toolTiers ?? toolTiers();
	if (!tiers.allows(speaker.tier, "agent_update") && (model || thinking))
		throw new AgentError(
			"A temp knight runs your model and thinking level; choosing others needs a higher tier.",
		);
	if (rest.skills?.length && !tiers.allows(speaker.tier, "agent_skills")) {
		const own = new Set(ctx.options.skills?.carriedNames(parent.name) ?? []);
		const extra = rest.skills.filter((skill) => !own.has(skill));
		if (extra.length > 0)
			throw new AgentError(
				`A temp knight can carry only skills you carry; not allowed: ${extra.join(", ")}.`,
			);
	}
	const name = given ?? nextName(ctx, parent.name);
	// Everything that can be refused is checked before anything is made or archived.
	store.checkNewName(name);
	const said = await makeRoom(ctx, parent, limits);
	const made = await make(
		{
			speaker,
			by: caller.name,
			creator: parent,
			parent,
			origin: ctx.turns.turnChannel(caller),
		},
		{ ...rest, name },
		{ model, thinking },
	);
	const helper = made.agent;
	try {
		await inheritLongRunning(ctx, caller, speaker, helper);
		ctx.turns.message(caller, helper.name, task);
	} catch (error) {
		// The long-running mode or the task could not be handed over (a chain at its cap): the temp
		// knight is not left idle, and its thread is closed.
		await ctx.archiveHelpers([helper.name]);
		throw error;
	}
	logger.info(
		{ agent: helper.name, parent: parent.name },
		"temp knight created",
	);
	return `Created "${helper.displayName}" (${helper.name}); it is working on the task and will answer here.${said}`;
}

/** The next `<parent>-<n>` no agent or group holds, with the parent cut to leave room for the number. */
function nextName(ctx: TeamContext, parent: string): string {
	const { store } = ctx.options;
	const base = parent.slice(0, 26);
	for (let n = 1; n < 100_000; n += 1) {
		const name = `${base}-${n}`;
		if (!store.agent(name) && !store.group(name)) return name;
	}
	throw new AgentError(`No free name for a temp knight of "${parent}".`);
}

/**
 * Holds the caps: when the parent or the host is full, archives the parent's oldest finished temp
 * knight and says so; with none finished, refuses and says what to wait for.
 */
async function makeRoom(
	ctx: TeamContext,
	parent: Agent,
	limits: { perParent: number; perHost: number },
): Promise<string> {
	const { store } = ctx.options;
	const mine = store.helpersOf(parent.name, "active");
	const onHost = store
		.agents()
		.filter((agent) => isHelper(agent) && agent.status === "active").length;
	const full =
		mine.length >= limits.perParent
			? `${mine.length} temp knights of yours are still working`
			: onHost >= limits.perHost
				? `The host's ${onHost} temp knights are all in use`
				: undefined;
	if (!full) return "";
	const oldest = mine
		.filter((agent) => agent.finishedAt !== undefined)
		.sort(
			(a, b) =>
				(a.finishedAt as Date).getTime() - (b.finishedAt as Date).getTime(),
		)[0];
	if (!oldest)
		throw new AgentError(
			`${full}, and none is finished; end one with helper_end or wait for one to finish.`,
		);
	await ctx.archiveHelpers([oldest.name]);
	return ` To make room, "${oldest.displayName}" (${oldest.name}), your oldest finished temp knight, was archived.`;
}

/**
 * Turns long-running on for the temp knight's conversations when the conversation that asked for
 * it has it on, so it works as long as its parent may. This adds no permission: an owner turned
 * it on there. Only a turn of an owner can carry that over, as for any change of modes.
 */
async function inheritLongRunning(
	ctx: TeamContext,
	caller: AgentTurnScope,
	speaker: Speaker,
	helper: Agent,
): Promise<void> {
	const { store, surfaces } = ctx.options;
	const modes = ctx.options.modes?.();
	if (!modes?.peek(ctx.turns.turnChannel(caller)).longRunning) return;
	if (speaker.tier !== "owner" || speaker.principalId === SYSTEM_PRINCIPAL)
		return;
	for (const key of keysOf(store, helper.name, surfaces?.roomSurfaces() ?? []))
		await modes.set(key, { longRunning: true }, speaker);
}
