import type { Interaction } from "discord.js";

/** What a command handler replied with, to read back in a test. */
export interface Replies {
	edits: unknown[];
	/** The text of every component of the last reply, joined. */
	text(): string;
	/** The custom id of every button and menu of the last reply. */
	customIds(): string[];
}

/** The owner id of `testHost`'s default configuration. */
const TEST_HOST_OWNER = "100000000000000001";

interface Options {
	/** The user who acts; the owner of `testHost`'s default configuration by default. */
	user?: string;
	/** The subcommand group and subcommand. */
	group: string;
	sub: string;
	strings?: Record<string, string | undefined>;
	/** The values of a modal's text fields, by field id. */
	fields?: Record<string, string>;
	/** The custom id of the modal being submitted. */
	modal?: string;
	/** The custom id of the button being pressed. */
	button?: string;
	/** Whether the command is used in a server channel; default false, a direct message. */
	guild?: boolean;
}

/** Collects the text displays of a Components V2 payload, once its builders are serialized. */
function textOf(payload: unknown): string {
	const found: string[] = [];
	const walk = (node: unknown): void => {
		if (typeof node !== "object" || node === null) return;
		const record = node as Record<string, unknown>;
		if (typeof record.content === "string") found.push(record.content);
		if (Array.isArray(record.components)) record.components.forEach(walk);
	};
	walk(JSON.parse(JSON.stringify(payload ?? null)));
	return found.join("\n");
}

/** Collects the custom ids of the buttons and menus of a serialized payload. */
function idsOf(payload: unknown): string[] {
	const found: string[] = [];
	const walk = (node: unknown): void => {
		if (typeof node !== "object" || node === null) return;
		const record = node as Record<string, unknown>;
		if (typeof record.custom_id === "string") found.push(record.custom_id);
		if (Array.isArray(record.components)) record.components.forEach(walk);
	};
	walk(JSON.parse(JSON.stringify(payload ?? null)));
	return found;
}

/**
 * The part of a Discord interaction the owner-command module and the plugins' handlers use: a
 * slash command, or a modal submit when `modal` is given. Cast to `Interaction` for `handle`.
 */
export function fakeInteraction(options: Options): {
	interaction: Interaction;
	replies: Replies;
} {
	const edits: unknown[] = [];
	const modal = options.modal !== undefined;
	const button = options.button !== undefined;
	const interaction = {
		user: { id: options.user ?? TEST_HOST_OWNER },
		commandName: "roundtable",
		customId: options.modal ?? options.button,
		deferred: false,
		replied: false,
		isAutocomplete: () => false,
		isChatInputCommand: () => !(modal || button),
		isModalSubmit: () => modal,
		isButton: () => button,
		isStringSelectMenu: () => false,
		isRepliable: () => true,
		inGuild: () => options.guild === true,
		channelId: "111",
		options: {
			getSubcommandGroup: () => options.group,
			getSubcommand: () => options.sub,
			getString: (name: string) => options.strings?.[name] ?? null,
		},
		fields: {
			getTextInputValue: (id: string) => options.fields?.[id] ?? "",
		},
		deferReply: async () => {
			interaction.deferred = true;
		},
		deferUpdate: async () => {
			interaction.deferred = true;
		},
		reply: async (payload: unknown) => {
			edits.push(payload);
		},
		editReply: async (payload: unknown) => {
			edits.push(payload);
		},
	};
	return {
		interaction: interaction as unknown as Interaction,
		replies: {
			edits,
			text: () => textOf(edits.at(-1)),
			customIds: () => idsOf(edits.at(-1)),
		},
	};
}
