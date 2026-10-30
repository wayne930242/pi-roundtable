import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CATALOG,
	type CharacterInput,
	CLASS_IDS,
	type PaletteName,
} from "../../characters/index.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { assistantName, messages } from "../i18n/index.ts";
import { type OwnerIdentity, ownerWords } from "../identity.ts";
import { THINKING_LEVELS } from "../models.ts";
import {
	optionalString,
	requiredString,
	stringList,
	type TextToolDef,
	textToolsExtension,
} from "../runtime/text-tools.ts";
import { timeZone } from "../time.ts";
import {
	MAX_GROUP_MEMBERS,
	MAX_PROMPT_CHARS,
	MIN_GROUP_MEMBERS,
} from "./agent-store.ts";

const PALETTE_NAMES = Object.keys(CATALOG.palettes) as PaletteName[];

/** The tool that hands a request to another agent; a group seat has none. */
export const MESSAGE_AGENT_TOOL = "message_agent";

/** The tool that changes an agent's look; every host offers it. */
export const AVATAR_TOOL = "agent_avatar";

export const AGENT_TOOLS = [
	"agent_list",
	"agent_get",
	"agent_update",
	"agent_create",
	AVATAR_TOOL,
	MESSAGE_AGENT_TOOL,
	"group_create",
	"group_update",
	"archive",
	"channel_arrange",
	"channel_read",
] as const;

/**
 * @deprecated Agents are composed characters and no longer drawn; use `AgentTeam.dress`.
 * Removed in 1.0.
 */
export type AvatarMode = "redraw" | "new_prompt" | "edit";

/** What the agent tools do; the agent team implements it. Each returns text for the model. */
export interface AgentOps {
	list(): Promise<string>;
	get(name: string): string;
	update(
		name: string,
		change: {
			displayName?: string;
			prompt?: string;
			model?: string;
			thinking?: string;
		},
		/** Who changes it: the agent whose turn asks, for the prompt history. */
		by?: string,
	): Promise<string>;
	create(
		caller: AgentTurnScope,
		input: {
			name: string;
			displayName: string;
			prompt: string;
			/** Fields of its look; any left out come from the look its role suggests. */
			character?: CharacterInput;
			task: string;
			category?: string;
			skills?: string[];
			/** Turn long-running mode on for its conversations; an owner's turn only. */
			longRunning?: boolean;
		},
	): Promise<string>;
	/** Changes an agent's look; a field left out stays as it is. */
	avatar(name: string, look: CharacterInput): Promise<string>;
	/** Queues the message and returns at once. */
	/**
	 * Hands a request to another agent, in the conversation it used most recently, or in the
	 * `conversation` named: "discord", "web" (or a room surface's name), or one of its conversation keys.
	 */
	message(
		caller: AgentTurnScope,
		to: string,
		text: string,
		conversation?: string,
	): string;
	createGroup(input: {
		name: string;
		displayName: string;
		members: string[];
		host?: string;
		category?: string;
	}): Promise<string>;
	updateGroup(
		name: string,
		change: { displayName?: string; members?: string[]; host?: string },
	): Promise<string>;
	archive(caller: AgentTurnScope, name: string): Promise<string>;
	arrange(entries: { category: string; names: string[] }[]): Promise<string>;
	read(
		channel: string,
		around: string | undefined,
		limit: number | undefined,
	): Promise<string>;
}

const NAME = Type.String({
	description:
		"An agent's name (lowercase, from agent_list), not its display name.",
});
const DISPLAY = Type.String({
	minLength: 1,
	maxLength: 32,
	description: "The name shown on its messages; any language.",
});
const PROMPT = Type.String({
	minLength: 1,
	maxLength: MAX_PROMPT_CHARS,
	description:
		"The agent's role prompt, in English: its job, sources, boundaries, and how it reports. Short and stated positively.",
});
const enumOf = (ids: readonly string[], description?: string) =>
	Type.String({ enum: [...ids], ...(description ? { description } : {}) });
const CLASS = enumOf(
	CLASS_IDS,
	`The agent's character class, which sets its outfit, hat, and prop. ${CLASS_IDS.map((id) => `${id}: ${CATALOG.classes[id].jobs}`).join("; ")}.`,
);
const COLOR = enumOf(
	PALETTE_NAMES,
	"The agent's color palette. Pick one unlike the other agents' (agent_get shows each look).",
);
const PARTS = Type.Object(
	{
		outfit: Type.Optional(enumOf(CATALOG.outfits)),
		hat: Type.Optional(enumOf(CATALOG.hats)),
		prop: Type.Optional(enumOf(CATALOG.props)),
		hair: Type.Optional(enumOf(CATALOG.hair)),
		beard: Type.Optional(enumOf([...CATALOG.beards, "none"])),
		accessory: Type.Optional(enumOf([...CATALOG.accessories, "none"])),
		build: Type.Optional(enumOf(["slim", "regular", "stout"])),
		skin: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
		hair_color: Type.Optional(
			Type.String({
				pattern: "^#[0-9a-fA-F]{6}$",
				description: "A hex color such as #3b2a1a.",
			}),
		),
	},
	{ description: "Single parts to change; any left out stay as they are." },
);
const category = (kind: "Agents" | "Groups") =>
	Type.String({
		description: `The category its channel opens under: ${kind} (the default) or ${kind}-<suffix>, such as ${kind}-work; made when missing. Keep to the categories agent_list shows unless a new one fits better.`,
	});
const MEMBERS = Type.Array(Type.String(), {
	minItems: MIN_GROUP_MEMBERS,
	maxItems: MAX_GROUP_MEMBERS,
	description: "Agent names in speaking-tie order.",
});

const PART_FIELDS = {
	outfit: "outfit",
	hat: "hat",
	prop: "prop",
	hair: "hair",
	beard: "beard",
	accessory: "accessory",
	build: "build",
	skin: "skin",
	hair_color: "hairColor",
} as const;

/** The look a tool call names: class, color as palette, and parts; nothing it leaves out. */
function lookOf(input: Record<string, unknown>): CharacterInput {
	const look: Record<string, unknown> = {};
	const klass = optionalString(input, "class");
	const color = optionalString(input, "color");
	if (klass) look.class = klass;
	if (color) look.palette = color;
	const parts = input.parts;
	if (parts !== null && typeof parts === "object")
		for (const [key, field] of Object.entries(PART_FIELDS)) {
			const value = (parts as Record<string, unknown>)[key];
			if (value !== undefined) look[field] = value;
		}
	return look as CharacterInput;
}

type AgentToolDef = TextToolDef<(typeof AGENT_TOOLS)[number]>;

/** What the agent tools offer, by what the host can do. */
export interface AgentToolOptions {
	/** Whether the skills addon is on; without it agent_create takes no skills. */
	skills: boolean;
}

function toolDefs(
	ops: AgentOps,
	scope: AgentTurnScope,
	owner: OwnerIdentity,
	{ skills: skillsOn }: AgentToolOptions,
): AgentToolDef[] {
	const o = ownerWords(owner);
	const defs: AgentToolDef[] = [
		{
			name: "agent_list",
			label: "List agents",
			description:
				"List every agent and group: name, display name, channel, and status; then the Agents and Groups categories in server order with their channels.",
			parameters: Type.Object({}),
			run: () => ops.list(),
		},
		{
			name: "agent_get",
			label: "Read agent",
			description:
				"Read an agent's display name, status, channel, model, thinking level, skills, look, and prompt.",
			parameters: Type.Object({ name: NAME }),
			run: (i) => ops.get(requiredString(i, "name")),
		},
		{
			name: "agent_update",
			label: "Update agent",
			description:
				"Change an agent's display name, prompt, model, or thinking level, yours included. The prompt replaces the old one whole. Changes apply from that agent's next turn; its conversation stays. Read it with agent_get first.",
			parameters: Type.Object({
				name: NAME,
				display_name: Type.Optional(DISPLAY),
				prompt: Type.Optional(PROMPT),
				model: Type.Optional(
					Type.String({
						description: `The model to run on, as <provider>/<model> such as openai-codex/gpt-6-sol; "default" for ${assistantName()}'s. An unusable one is refused with the usable list.`,
					}),
				),
				thinking: Type.Optional(
					Type.Union(
						[...THINKING_LEVELS, "default"].map((level) => Type.Literal(level)),
						{
							description: `"default" for ${assistantName()}'s, which is auto: the judge picks each turn's level from its message. Set a fixed level only when the agent has a reason to.`,
						},
					),
				),
			}),
			run: (i) => {
				const displayName = optionalString(i, "display_name");
				const prompt = optionalString(i, "prompt");
				const model = optionalString(i, "model");
				const thinking = optionalString(i, "thinking");
				return ops.update(
					requiredString(i, "name"),
					{
						...(displayName !== undefined ? { displayName } : {}),
						...(prompt !== undefined ? { prompt } : {}),
						...(model !== undefined ? { model } : {}),
						...(thinking !== undefined ? { thinking } : {}),
					},
					scope.name,
				);
			},
		},
		{
			name: "agent_create",
			label: "Create agent",
			description:
				"Create a new agent with its own channel and a character picture; its look follows its role unless class and color are given. It starts at once on the opening task in its channel, which is stopped after 10 minutes unless long_running is set. Its name is permanent.",
			parameters: Type.Object({
				name: Type.String({
					pattern: "^[a-z0-9-]{1,32}$",
					description:
						"Permanent name: lowercase letters, digits, and dashes; also its channel name.",
				}),
				display_name: DISPLAY,
				prompt: PROMPT,
				class: Type.Optional(CLASS),
				color: Type.Optional(COLOR),
				task: Type.String({
					minLength: 1,
					maxLength: 4000,
					description: "Its opening task, self-contained.",
				}),
				category: Type.Optional(category("Agents")),
				long_running: Type.Optional(
					Type.Boolean({
						description: `Turn on long-running mode for its conversations: its turns, such as the opening task, go on past the usual 10-minute limit by themselves, up to the host's cap (four hours by default). Set it for an agent whose tasks run long, such as research or large changes.`,
					}),
				),
				...(skillsOn
					? {
							skills: Type.Optional(
								Type.Array(Type.String(), {
									description:
										"Skills it carries, from skill_list; pick those its role needs. Change them later with agent_skills.",
								}),
							),
						}
					: {}),
			}),
			run: (i) => {
				const category = optionalString(i, "category");
				const skills = stringList(i, "skills");
				const look = lookOf(i);
				const longRunning = i.long_running === true;
				return ops.create(scope, {
					name: requiredString(i, "name"),
					displayName: requiredString(i, "display_name"),
					prompt: requiredString(i, "prompt"),
					...(Object.keys(look).length > 0 ? { character: look } : {}),
					task: requiredString(i, "task"),
					...(category ? { category } : {}),
					...(skills && skills.length > 0 ? { skills } : {}),
					...(longRunning ? { longRunning } : {}),
				});
			},
		},
		{
			name: AVATAR_TOOL,
			label: "Change look",
			description:
				"Change an agent's look: its class, color, or single parts. What you leave out stays as it is; a new class keeps the agent's colors unless you give a color. The new picture shows from its next message.",
			parameters: Type.Object({
				name: NAME,
				class: Type.Optional(CLASS),
				color: Type.Optional(COLOR),
				parts: Type.Optional(PARTS),
			}),
			run: (i) => {
				const look = lookOf(i);
				if (Object.keys(look).length === 0)
					throw new AgentError("Give a class, a color, or parts to change.");
				return ops.avatar(requiredString(i, "name"), look);
			},
		},
		{
			name: "group_create",
			label: "Create group",
			description: `Create a group chat channel with 2 to 8 agents. The judge picks which members answer each of ${o.name}'s messages there, one after another. The host answers when nobody else fits.`,
			parameters: Type.Object({
				name: Type.String({ pattern: "^[a-z0-9-]{1,32}$" }),
				display_name: DISPLAY,
				members: MEMBERS,
				host: Type.Optional(NAME),
				category: Type.Optional(category("Groups")),
			}),
			run: (i) => {
				const host = optionalString(i, "host");
				const category = optionalString(i, "category");
				return ops.createGroup({
					name: requiredString(i, "name"),
					displayName: requiredString(i, "display_name"),
					members: stringList(i, "members") ?? [],
					...(host ? { host } : {}),
					...(category ? { category } : {}),
				});
			},
		},
		{
			name: "group_update",
			label: "Update group",
			description: "Change a group's display name, members, or host.",
			parameters: Type.Object({
				name: Type.String(),
				display_name: Type.Optional(DISPLAY),
				members: Type.Optional(MEMBERS),
				host: Type.Optional(NAME),
			}),
			run: (i) => {
				const displayName = optionalString(i, "display_name");
				const members = stringList(i, "members");
				const host = optionalString(i, "host");
				return ops.updateGroup(requiredString(i, "name"), {
					...(displayName !== undefined ? { displayName } : {}),
					...(members ? { members } : {}),
					...(host ? { host } : {}),
				});
			},
		},
		{
			name: "archive",
			label: "Archive",
			description: `Archive an agent or a group, only when ${o.name} asks for it. Same as deleting its channel, except the channel is kept with its history under the Archive category, where nobody answers. An agent's schedules are cancelled and it leaves its groups; a group's members are untouched. There is no unarchive tool. The coordinator and yourself cannot be archived.`,
			parameters: Type.Object({
				name: Type.String({
					description: "The agent's or group's name, from agent_list.",
				}),
			}),
			run: (i) => ops.archive(scope, requiredString(i, "name")),
		},
		{
			name: "channel_arrange",
			label: "Arrange channels",
			description: `Sort agent and group channels into categories and order them, when ${o.name} asks. Agents go under Agents or Agents-<suffix>, groups under Groups or Groups-<suffix>; missing categories are made. The listed categories come first in the server in list order, then every other category as it was; in each listed category the listed channels come first in order, then its other channels as they were. Agents and Groups categories left empty are deleted. Any wrong entry refuses the whole call and nothing moves. Read the current layout with agent_list first.`,
			parameters: Type.Object({
				categories: Type.Array(
					Type.Object({
						category: Type.String({
							description:
								"Agents, Groups, or either with -<suffix>, the suffix 1 to 32 characters in any language.",
						}),
						channels: Type.Array(Type.String(), {
							minItems: 1,
							description:
								"Agent or group names (from agent_list), in the order they should appear.",
						}),
					}),
					{ minItems: 1, description: "Categories in server order." },
				),
			}),
			run: (i) => {
				const entries = Array.isArray(i.categories) ? i.categories : [];
				return ops.arrange(
					entries.map((entry: Record<string, unknown>) => ({
						category: requiredString(entry, "category"),
						names: stringList(entry, "channels") ?? [],
					})),
				);
			},
		},
		{
			name: "channel_read",
			label: "Read channel",
			description: `Read messages of a text channel or thread of the agent server, oldest first, each with its id, ${messages().zoneTime(timeZone())}, author, text, and attachment names. Use it for the surroundings of a message ${o.name} forwarded to you: pass the source channel and the message id from the forwarded link. Read-only.`,
			parameters: Type.Object({
				channel: Type.String({
					description: "The channel as <#id> or its id.",
				}),
				around: Type.Optional(
					Type.String({
						pattern: "^\\d+$",
						description:
							"A message id: read the messages around it instead of the latest.",
					}),
				),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, description: "Default 20." }),
				),
			}),
			run: (i) =>
				ops.read(
					requiredString(i, "channel"),
					optionalString(i, "around"),
					typeof i.limit === "number" ? i.limit : undefined,
				),
		},
	];
	// In a group, members hand off by mentioning each other where everyone can see it.
	if (!scope.group)
		defs.push({
			name: MESSAGE_AGENT_TOOL,
			label: "Message agent",
			description:
				'Send a self-contained request to another agent. It returns at once; the agent works in its own conversation and its answer comes back to you as a new turn, in the conversation you are writing from. An agent has one conversation on each surface (Discord, the web app); by default the request lands in the one it used most recently, so work it started in the web app is answered there. Give conversation to choose another: "discord", "web", or one of the conversation keys agent_get lists for it. The exchange shows in its conversation, and a thread in yours.',
			parameters: Type.Object({
				to: NAME,
				text: Type.String({ minLength: 1, maxLength: 4000 }),
				conversation: Type.Optional(
					Type.String({
						description:
							'Which of the agent\'s conversations to deliver into: "discord", "web" (or the name of another surface that hosts rooms), or a key from agent_get. Leave it out to reach the one it used most recently.',
					}),
				),
			}),
			run: (i) =>
				ops.message(
					scope,
					requiredString(i, "to"),
					requiredString(i, "text"),
					optionalString(i, "conversation"),
				),
		});
	return defs;
}

/** Registers the agent tools for one agent session. */
export function agentToolsExtension(
	ops: AgentOps,
	scope: AgentTurnScope,
	owner: OwnerIdentity,
	options: AgentToolOptions,
): ExtensionFactory {
	return textToolsExtension(toolDefs(ops, scope, owner, options), AgentError);
}
