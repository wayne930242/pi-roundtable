import {
	type ActionRowBuilder,
	type ButtonBuilder,
	type ChatInputCommandInteraction,
	ContainerBuilder,
	MessageFlags,
	SeparatorBuilder,
	SeparatorSpacingSize,
	type StringSelectMenuBuilder,
	TextDisplayBuilder,
} from "discord.js";
import { messages } from "../i18n/index.ts";

export interface PanelContent {
	title: string;
	/** Markdown sections, each its own text block. */
	sections: string[];
	/** One quiet line under the content, such as what to do next. */
	footer?: string;
	rows?: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}

/** A message the owner should read as is; anything else becomes a generic failure. */
export class OwnerFacingError extends Error {}

/** Discord allows 4,000 characters of text per Components V2 message; keep a margin. */
const PANEL_TEXT_LIMIT = 3_600;

/**
 * The single look of every root-command answer: a Components V2 container with no accent color
 * (Discord draws accents as a bar on one side), a heading, sections, controls, and a footer.
 */
export function ownerPanel(content: PanelContent) {
	const container = new ContainerBuilder().addTextDisplayComponents(
		new TextDisplayBuilder().setContent(`### ${content.title}`),
	);
	for (const section of content.sections)
		container.addTextDisplayComponents(
			new TextDisplayBuilder().setContent(section),
		);
	if (content.rows?.length)
		container
			.addSeparatorComponents(
				new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
			)
			.addActionRowComponents(...content.rows);
	if (content.footer)
		container.addTextDisplayComponents(
			new TextDisplayBuilder().setContent(`-# ${content.footer}`),
		);
	return {
		components: [container],
		flags: MessageFlags.IsComponentsV2 as const,
		allowedMentions: { parse: [] },
	};
}

/** A panel only the person who used the command sees. */
export function ephemeralPanel(content: PanelContent) {
	return {
		...ownerPanel(content),
		flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
	};
}

/** Answers a deferred command with the panel, its overflow pages as ephemeral follow-ups. */
export async function replyWithPanels(
	interaction: ChatInputCommandInteraction,
	content: PanelContent,
): Promise<void> {
	const [first, ...rest] = ownerPanels(content);
	if (first) await interaction.editReply(ownerPanel(first));
	for (const page of rest) await interaction.followUp(ephemeralPanel(page));
}

/** Splits long sections into panels that each fit Discord's text limit. */
export function ownerPanels(content: PanelContent): PanelContent[] {
	const pages: PanelContent[] = [];
	let sections: string[] = [];
	let size = content.title.length;
	for (const section of content.sections) {
		if (sections.length > 0 && size + section.length > PANEL_TEXT_LIMIT) {
			pages.push({ title: content.title, sections });
			sections = [];
			size = content.title.length;
		}
		sections.push(section.slice(0, PANEL_TEXT_LIMIT));
		size += section.length;
	}
	pages.push({ ...content, sections });
	return pages.map((page, i) =>
		pages.length > 1
			? {
					...page,
					title: messages().panelPage(page.title, i + 1, pages.length),
				}
			: page,
	);
}

/** Text a user typed, made safe to put inside Discord markdown. */
export const plain = (value: string): string =>
	value.replace(/[\n\r`*_~<>|#@]/g, " ").trim();
