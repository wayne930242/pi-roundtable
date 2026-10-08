import {
	type AutocompleteInteraction,
	type ChatInputCommandInteraction,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	type ModalSubmitInteraction,
	type SlashCommandStringOption,
	type SlashCommandSubcommandGroupBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import {
	type CommandGuard,
	groupOption,
	type InteractionContribution,
	OwnerFacingError,
	ownerCommandModule,
	ownerPanel,
	plain,
	replyWithPanels,
} from "pi-roundtable/discord";
import {
	type Connector,
	ConnectorError,
	type ConnectorRegistry,
} from "./connector-registry.ts";
import type { UpstreamAuth } from "./contextforge.ts";
import type { ConnectorMessages } from "./messages.ts";

export const CONNECTOR_MODAL_ID = "rtmcp:connector:add";

const FIELD = {
	name: "name",
	url: "url",
	description: "description",
	header: "header",
	token: "token",
} as const;

const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;
const TOOL_PREVIEW = 12;

function connectorGroup(text: ConnectorMessages) {
	const connector = (o: SlashCommandStringOption) =>
		o
			.setName("name")
			.setDescription(text.nameOption)
			.setRequired(true)
			.setAutocomplete(true);
	return (group: SlashCommandSubcommandGroupBuilder) =>
		group
			.setName("connector")
			.setDescription(text.groupDescription)
			.addSubcommand((sub) =>
				sub.setName("add").setDescription(text.addDescription),
			)
			.addSubcommand((sub) =>
				sub.setName("list").setDescription(text.listDescription),
			)
			.addSubcommand((sub) =>
				sub
					.setName("describe")
					.setDescription(text.describeDescription)
					.addStringOption(connector)
					.addStringOption((o) =>
						o
							.setName("description")
							.setDescription(text.newPurposeOption)
							.setRequired(true)
							.setMaxLength(1000),
					),
			)
			.addSubcommand((sub) =>
				sub
					.setName("remove")
					.setDescription(text.removeDescription)
					.addStringOption(connector),
			);
}

/** The private form `/<root> connector add` opens; Discord never shows its values to anyone else. */
export function connectorModal(text: ConnectorMessages): ModalBuilder {
	const input = (
		id: string,
		label: string,
		description: string,
		style: TextInputStyle,
		options: { required: boolean; max: number; placeholder?: string },
	) => {
		const field = new TextInputBuilder()
			.setCustomId(id)
			.setStyle(style)
			.setRequired(options.required)
			.setMaxLength(options.max);
		if (options.placeholder) field.setPlaceholder(options.placeholder);
		return new LabelBuilder()
			.setLabel(label)
			.setDescription(description)
			.setTextInputComponent(field);
	};
	return new ModalBuilder()
		.setCustomId(CONNECTOR_MODAL_ID)
		.setTitle(text.modalTitle)
		.addLabelComponents(
			input(FIELD.name, text.nameLabel, text.nameHelp, TextInputStyle.Short, {
				required: true,
				max: 12,
				placeholder: "notion",
			}),
			input(FIELD.url, text.urlLabel, text.urlHelp, TextInputStyle.Short, {
				required: true,
				max: 500,
				placeholder: "https://mcp.example.com/mcp",
			}),
			input(
				FIELD.description,
				text.purposeLabel,
				text.purposeHelp,
				TextInputStyle.Paragraph,
				{ required: true, max: 1000 },
			),
			input(
				FIELD.header,
				text.headerLabel,
				text.headerHelp,
				TextInputStyle.Short,
				{ required: false, max: 100, placeholder: "X-API-Key" },
			),
			input(
				FIELD.token,
				text.tokenLabel,
				text.tokenHelp,
				TextInputStyle.Short,
				{ required: false, max: 4000 },
			),
		);
}

function authFrom(
	header: string,
	token: string,
	text: ConnectorMessages,
): UpstreamAuth {
	if (!token) {
		if (header) throw new OwnerFacingError(text.headerNeedsToken);
		return { type: "none" };
	}
	if (!header) return { type: "bearer", token };
	if (!HEADER_NAME.test(header)) throw new OwnerFacingError(text.headerRule);
	return { type: "header", name: header, value: token };
}

/** Scheme and host only: some servers take their credential in the path, query, or user part. */
export function displayUrl(url: string, unreadable: string): string {
	const parsed = URL.parse(url);
	if (!parsed) return unreadable;
	const hidden =
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash ||
		parsed.username ||
		parsed.password;
	return `${parsed.origin}${hidden ? "/…" : ""}`;
}

function section(connector: Connector, text: ConnectorMessages): string {
	const tools = connector.server?.tools ?? [];
	const listed = tools
		.slice(0, TOOL_PREVIEW)
		.map((t) => `\`${t}\``)
		.join(" ");
	return [
		`**${connector.name}**${text.labelSeparator}${plain(displayUrl(connector.url, text.urlUnreadable))}`,
		plain(connector.description),
		connector.server
			? text.toolCount(
					tools.length,
					listed,
					Math.max(0, tools.length - TOOL_PREVIEW),
				)
			: text.toolsUnreadable,
	].join("\n");
}

/** `/<root> connector`: the owner's token-based MCP connectors. */
export class ConnectorCommands {
	readonly #registry: ConnectorRegistry;
	readonly #root: string;
	readonly #text: ConnectorMessages;

	constructor(
		registry: ConnectorRegistry,
		root: string,
		text: ConnectorMessages,
	) {
		this.#registry = registry;
		this.#root = root;
		this.#text = text;
	}

	async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
		const query = interaction.options.getFocused().trim().toLowerCase();
		await interaction.respond(
			this.#registry
				.list()
				.filter((c) => c.name.includes(query))
				.slice(0, 25)
				.map((c) => ({ name: c.name, value: c.name })),
		);
	}

	/** Every subcommand but `add`, whose form opens before the reply is deferred. */
	async command(interaction: ChatInputCommandInteraction): Promise<void> {
		const sub = interaction.options.getSubcommand(true);
		if (sub === "list") return this.#list(interaction);
		const name = interaction.options.getString("name", true);
		const text = this.#text;
		if (sub === "describe") {
			const connector = await this.#owned(() =>
				this.#registry.describe(
					name,
					interaction.options.getString("description", true),
				),
			);
			await interaction.editReply(
				ownerPanel({
					title: text.purposeUpdatedTitle,
					sections: [section(connector, text)],
					footer: text.purposeUpdatedFooter,
				}),
			);
			return;
		}
		await this.#owned(() => this.#registry.remove(name));
		await interaction.editReply(
			ownerPanel({
				title: text.removedTitle,
				sections: [text.removed(plain(name))],
			}),
		);
	}

	async submit(interaction: ModalSubmitInteraction): Promise<void> {
		const text = this.#text;
		const value = (id: string) =>
			interaction.fields.getTextInputValue(id).trim();
		const { connector, skipped } = await this.#owned(() =>
			this.#registry.add({
				name: value(FIELD.name),
				url: value(FIELD.url),
				description: value(FIELD.description),
				auth: authFrom(value(FIELD.header), value(FIELD.token), text),
			}),
		);
		await interaction.editReply(
			ownerPanel({
				title: text.addedTitle,
				sections: [
					section(connector, text),
					...(skipped.length
						? [text.skippedTools(skipped.map((t) => `\`${t}\``).join(" "))]
						: []),
				],
				footer: text.addedFooter,
			}),
		);
	}

	async #list(interaction: ChatInputCommandInteraction): Promise<void> {
		const text = this.#text;
		const connectors = this.#registry.list();
		await replyWithPanels(interaction, {
			title: text.listTitle,
			sections: connectors.length
				? connectors.map((c) => section(c, text))
				: [text.listEmpty(this.#root)],
			footer: text.listFooter(this.#root),
		});
	}

	async #owned<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (error instanceof ConnectorError)
				throw new OwnerFacingError(error.message);
			throw error;
		}
	}
}

/** `/<root> connector …` and the form `add` opens. */
export function connectorCommands(
	guard: CommandGuard,
	registry: ConnectorRegistry,
	text: ConnectorMessages,
): InteractionContribution {
	const commands = new ConnectorCommands(registry, guard.root, text);
	return {
		module: ownerCommandModule(guard, {
			owns: (group) => group === "connector",
			autocomplete: (interaction) => commands.autocomplete(interaction),
			// The form must be the interaction's first answer, before any deferral.
			open: async (interaction) => {
				if (interaction.options.getSubcommand() !== "add") return false;
				await interaction.showModal(connectorModal(text));
				return true;
			},
			command: (interaction) => commands.command(interaction),
			component: async (interaction) => {
				if (
					!interaction.isModalSubmit() ||
					interaction.customId !== CONNECTOR_MODAL_ID
				)
					return false;
				if (!(await guard.allows(interaction))) return true;
				await interaction.deferReply({ flags: MessageFlags.Ephemeral });
				await guard.run(interaction, () => commands.submit(interaction));
				return true;
			},
		}),
		rootOptions: [groupOption(connectorGroup(text))],
	};
}
