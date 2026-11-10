import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CharacterInput } from "../../characters/index.ts";
import type { ToolArgument } from "../contract/places.ts";
import { AgentError } from "../domain/errors.ts";
import { THINKING_LEVELS } from "../domain/models.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { assistantName } from "../i18n/index.ts";
import { type OwnerIdentity, ownerWords } from "../identity/owner-identity.ts";
import {
	optionalString,
	requiredString,
	stringList,
	type TextToolDef,
	textToolsExtension,
} from "../runtime/text-tools.ts";
import { MAX_GROUP_MEMBERS, MIN_GROUP_MEMBERS } from "./agent-store.ts";
import {
	CLASS,
	COLOR,
	DISPLAY,
	lookOf,
	NAME,
	PARTS,
	PROMPT,
} from "./agent-tool-schema.ts";
import type { HelperFields, PresetAction } from "./helper-preset-ops.ts";
import { helperToolDefs } from "./helper-tools.ts";
import { placedAfter, ROOM_GROUP, roomToolDefs } from "./room-tools.ts";
import type { RoomOps } from "./team-rooms.ts";

/** The tool that hands a request to another agent; a group seat has none. */
export const MESSAGE_AGENT_TOOL = "message_agent";

/** The tool that changes an agent's look; every host offers it. */
export const AVATAR_TOOL = "agent_avatar";

/** The tools that make and end temp knights and keep their presets; `helpers: false` leaves them out. */
export const HELPER_TOOLS = [
	"helper_create",
	"helper_end",
	"helper_preset_set",
	"helper_preset_list",
	"helper_preset_delete",
] as const;

export const AGENT_TOOLS = [
	"agent_list",
	"agent_get",
	"agent_update",
	"agent_create",
	...HELPER_TOOLS,
	AVATAR_TOOL,
	MESSAGE_AGENT_TOOL,
	"group_create",
	"group_update",
	"archive",
	"room_arrange",
] as const;

/**
 * The tools a temp knight's turns do not get: making knights, temp knights or groups, archiving,
 * arranging rooms, and scheduling, which would leave work behind with no one to end it. Tools a
 * plugin adds, such as a surface's arranging of its places, say so with `withheldFromHelpers`.
 */
export const WITHHELD_FROM_HELPERS: readonly string[] = [
	"agent_create",
	...HELPER_TOOLS,
	"group_create",
	"group_update",
	"archive",
	"room_arrange",
	"schedule_create",
];

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
			/** The values of the arguments the surfaces' place providers add to the tool, by name. */
			hints?: Readonly<Record<string, string>>;
			skills?: string[];
			/** Turn long-running mode on for its conversations; an owner's turn only. */
			longRunning?: boolean;
		},
	): Promise<string>;
	/** Makes a temp knight of the caller for one task; the answer returns to the caller's conversation. */
	helperCreate(
		caller: AgentTurnScope,
		input: HelperFields & { name?: string; task: string },
	): Promise<string>;
	/** Saves, lists, or deletes the caller's own temp-knight presets. */
	helperPreset(caller: AgentTurnScope, action: PresetAction): Promise<string>;
	/** Archives the caller's own temp knights: the named ones, or every one that is finished. */
	helperEnd(
		caller: AgentTurnScope,
		names: readonly string[] | "finished",
	): Promise<string>;
	/** Changes an agent's look; a field left out stays as it is. */
	avatar(name: string, look: CharacterInput): Promise<string>;
	/** Queues the message and returns at once. */
	/**
	 * Hands a request to another agent, in its conversation on the sender's surface, or in the
	 * `conversation` named: "discord", "web" (or a room surface's name), or one of its conversation keys.
	 */
	message(
		caller: AgentTurnScope,
		to: string,
		text: string,
		conversation?: string,
	): string;
	/**
	 * Readies the place a message is about to reach: a temp knight made in the web app gets its
	 * Discord thread when the caller may message it and names "discord". Never rejects.
	 */
	reach?(
		caller: AgentTurnScope,
		to: string,
		conversation?: string,
	): Promise<void>;
	createGroup(input: {
		name: string;
		displayName: string;
		members: string[];
		host?: string;
		/** The values of the arguments the surfaces' place providers add to the tool, by name. */
		hints?: Readonly<Record<string, string>>;
	}): Promise<string>;
	updateGroup(
		name: string,
		change: { displayName?: string; members?: string[]; host?: string },
	): Promise<string>;
	archive(caller: AgentTurnScope, name: string): Promise<string>;
}

const MEMBERS = Type.Array(Type.String(), {
	minItems: MIN_GROUP_MEMBERS,
	maxItems: MAX_GROUP_MEMBERS,
	description: "Agent names in speaking-tie order.",
});

type AgentToolDef = TextToolDef<(typeof AGENT_TOOLS)[number]>;

/** What the agent tools offer, by what the host can do. */
export interface AgentToolOptions {
	/** Whether the skills addon is on; without it agent_create takes no skills. */
	skills: boolean;
	/** The app's room groups; without them `group` and room_arrange are refused. */
	rooms?: RoomOps;
	/**
	 * The arguments the surfaces' place providers add to the creation tools (`createArguments`),
	 * merged in after the tool's own and left out where no provider adds any.
	 */
	arguments?: {
		agent?: Readonly<Record<string, ToolArgument>>;
		group?: Readonly<Record<string, ToolArgument>>;
	};
}

/** The values the model gave the provider-added arguments, by name; those it left out are absent. */
function hintsOf(
	input: Record<string, unknown>,
	added: Readonly<Record<string, ToolArgument>> | undefined,
): { hints?: Readonly<Record<string, string>> } {
	const hints = Object.fromEntries(
		Object.keys(added ?? {}).flatMap((name) => {
			const value = optionalString(input, name);
			return value ? [[name, value] as const] : [];
		}),
	);
	return Object.keys(hints).length > 0 ? { hints } : {};
}

function toolDefs(
	ops: AgentOps,
	scope: AgentTurnScope,
	owner: OwnerIdentity,
	{ skills: skillsOn, rooms, arguments: added }: AgentToolOptions,
): AgentToolDef[] {
	const o = ownerWords(owner);
	const defs: AgentToolDef[] = [
		{
			name: "agent_list",
			label: "List agents",
			description:
				"List every agent and group: name, display name, channel, and status; then the Agents and Groups categories in server order with their channels; then the web app's room groups in order with their rooms, and its pinned rooms.",
			parameters: Type.Object({}),
			run: async () => {
				const list = await ops.list();
				const groups = await rooms?.listText();
				return groups ? `${list}\n\n${groups}` : list;
			},
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
				...added?.agent,
				group: Type.Optional(ROOM_GROUP),
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
				const skills = stringList(i, "skills");
				const look = lookOf(i);
				const longRunning = i.long_running === true;
				const name = requiredString(i, "name");
				return placedAfter(rooms, name, optionalString(i, "group"), () =>
					ops.create(scope, {
						name,
						displayName: requiredString(i, "display_name"),
						prompt: requiredString(i, "prompt"),
						...(Object.keys(look).length > 0 ? { character: look } : {}),
						task: requiredString(i, "task"),
						...hintsOf(i, added?.agent),
						...(skills && skills.length > 0 ? { skills } : {}),
						...(longRunning ? { longRunning } : {}),
					}),
				);
			},
		},
		...helperToolDefs(ops, scope, skillsOn),
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
				...added?.group,
				group: Type.Optional(ROOM_GROUP),
			}),
			run: (i) => {
				const host = optionalString(i, "host");
				const name = requiredString(i, "name");
				return placedAfter(rooms, name, optionalString(i, "group"), () =>
					ops.createGroup({
						name,
						displayName: requiredString(i, "display_name"),
						members: stringList(i, "members") ?? [],
						...(host ? { host } : {}),
						...hintsOf(i, added?.group),
					}),
				);
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
		...roomToolDefs(rooms, o.name),
	];
	// In a group, members hand off by mentioning each other where everyone can see it.
	if (!scope.group)
		defs.push({
			name: MESSAGE_AGENT_TOOL,
			label: "Message agent",
			description:
				'Send a self-contained request to another agent. It returns at once; the agent works in its own conversation and its answer comes back to you as a new turn, in the conversation you are writing from. An agent has one conversation on each surface (Discord, the web app); by default the request lands in its conversation on the surface you are writing from (its room from a web room, its Discord channel from Discord), so nothing crosses surfaces unless you name it. Give conversation to choose another: "discord", "web", or one of the conversation keys agent_get lists for it. The request shows in its conversation, and the request and the answer show as small cards in yours.',
			parameters: Type.Object({
				to: NAME,
				text: Type.String({ minLength: 1, maxLength: 4000 }),
				conversation: Type.Optional(
					Type.String({
						description:
							'Which of the agent\'s conversations to deliver into: "discord", "web" (or the name of another surface that hosts rooms), or a key from agent_get. Leave it out to reach its conversation on the surface you are writing from.',
					}),
				),
			}),
			run: async (i) => {
				const to = requiredString(i, "to");
				const conversation = optionalString(i, "conversation");
				await ops.reach?.(scope, to, conversation);
				return ops.message(scope, to, requiredString(i, "text"), conversation);
			},
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
