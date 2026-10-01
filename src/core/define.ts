import type { Static, TObject } from "typebox";
import { PluginError } from "./errors.ts";
import type { HoldRule } from "./holds.ts";
import { type RoundtablePlugin, refuseRemovedFields } from "./plugin.ts";
import type { AgentTurnScope, ChannelKey, SessionTool } from "./sessions.ts";
import { toolError, toolText } from "./shared/tool-result.ts";
import { type Speaker, TIERS, type Tier } from "./speakers.ts";

/** Tool names are lowercase words joined by underscores, like every tool the core ships. */
const TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/** Plugin names are lowercase words joined by dashes. */
const PLUGIN_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** Tools the agents and the shell already have; a plugin's tool may not take their names. */
const RESERVED_TOOLS = ["bash", "read", "edit", "write"];

/** What a tool knows about the turn that calls it. */
export interface ToolTurn {
	/** Who the turn is for; undefined for a turn nobody spoke in. */
	speaker: Speaker | undefined;
	/** The channel the turn runs in. */
	channel: ChannelKey;
	/** The agent whose turn it is. */
	agent: AgentTurnScope | undefined;
	signal: AbortSignal | undefined;
}

/**
 * Thrown by a tool's `run` for a call the model should correct: the message becomes the tool's
 * error result, which the model reads. Any other error fails the call.
 */
export class ToolRefusal extends Error {
	override name = "ToolRefusal";
}

export interface ToolSpec<Schema extends TObject> {
	/** Lowercase words joined by underscores; unique across every plugin. */
	name: string;
	/** What the model reads to decide when to call the tool. */
	description: string;
	/** The arguments, as a Typebox object; `run` receives them typed. */
	parameters: Schema;
	/** The lowest tier of speaker whose turns may call the tool; the operator's settings may change it. */
	minTier: Tier;
	/** Whether agents carry the tool in their turns; default true. */
	agent?: boolean;
	/** A short description of what the call would do when it must wait for approval; undefined lets it run. */
	hold?: (args: Static<Schema>) => string | undefined;
	run(args: Static<Schema>, turn: ToolTurn): Promise<string> | string;
}

/** A tool a plugin adds, as `defineTool` builds it. */
export interface ToolContribution {
	readonly name: string;
	readonly minTier: Tier;
	readonly agent: boolean;
	/** The extension that registers the tool in a session. */
	readonly session: SessionTool;
	/** The hold rule for the tool's `hold`, when it has one. */
	readonly hold?: HoldRule;
}

/**
 * Defines one tool: its name, what the model reads about it, its arguments, the tier that may
 * use it, and what it does. A missing or unknown tier, or a name that is not a tool name, is
 * refused here with the tool's name, before anything starts.
 */
export function defineTool<Schema extends TObject>(
	spec: ToolSpec<Schema>,
): ToolContribution {
	const { name } = spec;
	if (typeof name !== "string" || !TOOL_NAME.test(name))
		throw new PluginError(
			`tool ${JSON.stringify(name)}: the name must be lowercase words joined by underscores, such as note_add. Rename the tool.`,
		);
	if (RESERVED_TOOLS.includes(name))
		throw new PluginError(
			`tool ${name}: the agents already have a tool of this name. Rename the tool.`,
		);
	if (!TIERS.includes(spec.minTier))
		throw new PluginError(
			`tool ${name}: minTier must be one of ${TIERS.join(", ")}; got ${JSON.stringify(spec.minTier)}. Set the lowest tier that may use it.`,
		);
	if (typeof spec.description !== "string" || !spec.description.trim())
		throw new PluginError(
			`tool ${name}: the description is empty. Tell the model when to call the tool.`,
		);
	if (typeof spec.run !== "function")
		throw new PluginError(
			`tool ${name}: run is missing. Give the function the tool runs.`,
		);
	const session: SessionTool = {
		name: `tool:${name}`,
		phase: "tools",
		snapshot: () => ({
			revision: 0,
			requiredTools: [name],
			factory: (context) => (pi) => {
				pi.registerTool({
					name,
					label: name,
					description: spec.description,
					parameters: spec.parameters,
					execute: async (_toolCallId, params, signal) => {
						try {
							return toolText(
								await spec.run(params as Static<Schema>, {
									speaker: context.speaker(),
									channel: context.turnChannel,
									agent: context.agent,
									signal,
								}),
							);
						} catch (error) {
							if (error instanceof ToolRefusal) return toolError(error.message);
							throw error;
						}
					},
				});
			},
		}),
	};
	const hold = spec.hold;
	return {
		name,
		minTier: spec.minTier,
		agent: spec.agent ?? true,
		session,
		...(hold
			? {
					hold: {
						name: `tool:${name}`,
						describe: (tool, input) =>
							tool === name ? hold(input as Static<Schema>) : undefined,
					},
				}
			: {}),
	};
}

/**
 * Defines a plugin. It returns the plugin it was given, typed, after checking its name, so a
 * mistake shows where the plugin is written.
 */
export function definePlugin(plugin: RoundtablePlugin): RoundtablePlugin {
	if (typeof plugin.name !== "string" || !PLUGIN_NAME.test(plugin.name))
		throw new PluginError(
			`plugin ${JSON.stringify(plugin.name)}: the name must be lowercase words joined by dashes, such as my-notes. Rename the plugin.`,
		);
	if (typeof plugin.setup !== "function")
		throw new PluginError(
			`plugin ${plugin.name}: setup is missing. Give the function that returns what the plugin adds.`,
		);
	refuseRemovedFields(plugin);
	return plugin;
}
