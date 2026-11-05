import type { CharacterInput } from "../../characters/index.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { Speaker } from "../identity/speakers.ts";
import { isHelper } from "./agent-rules.ts";
import type { Agent } from "./agent-store.ts";
import { followOrigin } from "./helper-modes.ts";
import {
	checkHelperGrant,
	type HelperFields,
	helperMaker,
	withPreset,
} from "./helper-preset-ops.ts";
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
	input: HelperFields & { name?: string; task: string },
): Promise<string> {
	const { store, logger } = ctx.options;
	const { speaker, parent, limits } = helperMaker(ctx, caller, "helper_create");
	// A preset saved earlier is checked again now, merged with the call.
	const merged = await withPreset(ctx, parent, input);
	const {
		task,
		name: given,
		model,
		thinking,
		preset: _preset,
		...rest
	} = merged;
	const { displayName, prompt } = rest;
	if (!displayName || !prompt)
		throw new AgentError(
			"Give display_name and prompt, or a preset (from helper_preset_list) that has them.",
		);
	checkHelperGrant(ctx, speaker, parent, merged);
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
		{ ...rest, displayName, prompt, name },
		{ model, thinking },
	);
	const helper = made.agent;
	try {
		await followOrigin(ctx, caller, speaker, helper);
		ctx.turns.message(caller, helper.name, task);
	} catch (error) {
		// The modes or the task could not be handed over (a chain at its cap): the temp
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
