import type { CharacterInput, CharacterSpec } from "pi-roundtable/characters";
import type { ApiError } from "./api-common-types.ts";

/** An agent's profile as its page edits it. */
export interface AgentProfileView {
	name: string;
	displayName: string;
	prompt: string;
	/** Its own model; absent when it follows the assistant's. */
	model?: string;
	/** Its own thinking level; absent when it follows the assistant's. */
	thinking?: string;
	/** What its next turn runs on. */
	effective: { model: string; thinking: string };
	avatar: string;
	character: CharacterSpec;
	room: string;
	/** A temp knight's profile: the room and name of the knight that made it, and the preset it was made from. */
	helper?: { parent: string; parentName: string; preset?: string };
}

export interface ModelsView {
	models: string[];
}

/** What changes an agent: the same fields `AgentTeam.update` takes. */
export interface AgentPatch {
	displayName?: string;
	prompt?: string;
	model?: string;
	thinking?: string;
}

/** One change of a prompt, as `GET api/agents/<name>/prompt-history` and `GET api/prompts/<id>/history` list them, newest first. */
export interface PromptVersionView {
	id: number;
	/** `set` put new text in force; `revert` took a document back to its file version. */
	action: "set" | "revert";
	/** The text in force after the change; for a revert, the file version it went back to. */
	text: string;
	/** The text the change replaced. */
	previous: string;
	/** Who made it. */
	by: string;
	/** ISO time. */
	at: string;
}

export interface PromptHistoryView {
	versions: PromptVersionView[];
}

/** A prompt document in the list of `GET api/prompts`: the owner-editable texts the host registered. */
export interface PromptSummary {
	id: string;
	label: string;
	description?: string;
	/** The owner's text is in force and is not the file version. */
	differs: boolean;
	/** Who set it and when (ISO), while an override is in force. */
	override?: { by: string; at: string };
	/** Why the file version cannot be read; the document cannot be changed until it can, and the others are unaffected. */
	broken?: string;
}

export interface PromptsView {
	documents: PromptSummary[];
}

/** `GET api/prompts/<id>`: the document with its text in force and its file version. */
export interface PromptView extends PromptSummary {
	/** The text in force. */
	text: string;
	/** The file version, which `revert` returns to. */
	fileText: string;
	/** The most characters a save may have. */
	maxChars: number;
}

/** The body of `PUT api/prompts/<id>`: the new text, and the text it was edited from. */
export interface PromptSave {
	text: string;
	base: string;
}

/** The body of `POST api/prompts/<id>/revert`: the text in force that the owner saw when they asked. */
export interface PromptRevert {
	base: string;
}

/** A 409: the document is not as the writer saw it. */
export interface PromptConflict extends ApiError {
	conflict: "changed";
	current: PromptView;
}

/**
 * The body of `POST api/agents`, which makes an agent: the fields of the `agent_create` tool, with
 * its model and thinking level. `name` is permanent (lowercase letters, digits and dashes, 1 to 32).
 * `task` is its opening task; without it the agent only exists. The 201 answer is its profile.
 */
export interface AgentCreate {
	name: string;
	displayName: string;
	prompt: string;
	model?: string;
	thinking?: string;
	task?: string;
	/** Fields of its look; any left out come from the look its role suggests. */
	character?: CharacterInput;
	/** Skills it carries, as the Skills pane names them. */
	skills?: string[];
}

/** A group as the app edits it. */
export interface GroupProfileView {
	name: string;
	displayName: string;
	/** Its members, by agent name, in speaking-tie order. */
	members: string[];
	/** The member who answers when nobody else fits. */
	host: string;
	room: string;
}

/** The body of `POST api/groups`; the host is the first member unless given. The 201 answer is the group. */
export interface GroupCreate {
	name: string;
	displayName: string;
	members: string[];
	host?: string;
}

/** The body of `PATCH api/groups/<name>`; `members` is the whole new list. */
export interface GroupPatch {
	displayName?: string;
	members?: string[];
	host?: string;
}

/** An archived agent or group, kept with its history until it is restored or deleted. */
export interface ArchivedEntry {
	kind: "agent" | "group";
	name: string;
	displayName: string;
	/** An agent's picture, a path under the mount. */
	avatar?: string;
	character?: CharacterSpec;
	/** A group's members that are still on the team. */
	members?: string[];
	/** A temp knight's parent, by name; the archive page groups it under that knight. */
	parent?: string;
	/** ISO time of the last message in its room, when it has one; the archive page shows it and filters by it. */
	lastActive?: string;
}

/** `GET api/archive`. */
export interface ArchiveView {
	entries: ArchivedEntry[];
}

/** The body of `PUT api/agents/<name>/character`: at most 4 KiB. */
export interface CharacterRequest {
	character: CharacterInput;
}

/** The 400 of `PUT api/agents/<name>/character`: `field` is the path of the offending field. */
export interface CharacterRefusal extends ApiError {
	field: string;
}

/** A file waiting for the message that uses it. */
export interface UploadView {
	id: string;
	name: string;
	type: string;
	size: number;
}
