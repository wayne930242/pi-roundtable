import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
	PermissionFlagsBits,
	StringSelectMenuBuilder,
} from "discord.js";
import {
	CHANNEL_OPERATIONS,
	type ChannelOperation,
	fetchManagedChannel,
	type ManagedChannel,
	OPERATION_PERMISSIONS,
	OwnerFacingError,
	operationLabel,
	ownerPanel,
	plain,
} from "pi-roundtable/discord";
import type { ChannelGrant } from "./channel-grants.ts";
import type { RemoteMcpMessages } from "./messages.ts";

/** What every button and menu of the grant flow starts with. */
export const GRANT_PREFIX = "rtmcp:grant:";

export const MCP_IDS = {
	select: `${GRANT_PREFIX}select:`,
	confirm: `${GRANT_PREFIX}confirm:`,
	rotate: `${GRANT_PREFIX}rotate:`,
	cancel: `${GRANT_PREFIX}cancel:`,
} as const;

export interface Pending {
	userId: string;
	channelId: string;
	bundleName: string;
	bundleId?: string;
	displayName?: string;
	description?: string;
	operations: ChannelOperation[];
	rotate: boolean;
	expiresAt: number;
}

export const PENDING_MS = 5 * 60_000;
export const opLabels = (ops: ChannelOperation[]) =>
	ops.map(operationLabel).join(", ");

export function authorizePanel(
	id: string,
	pending: Pending,
	source: "existing" | "defaults" | "chosen",
	text: RemoteMcpMessages,
) {
	const labels = opLabels(pending.operations);
	const intro = pending.operations.length
		? {
				existing: text.keepExisting,
				defaults: text.keepDefaults,
				chosen: text.chosen,
			}[source](labels)
		: text.chooseFirst;
	return ownerPanel({
		title: text.authorizeTitle(plain(pending.bundleName)),
		sections: [intro],
		rows: [
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
				new StringSelectMenuBuilder()
					.setCustomId(`${MCP_IDS.select}${id}`)
					.setPlaceholder(text.selectPlaceholder)
					.setMinValues(1)
					.setMaxValues(CHANNEL_OPERATIONS.length)
					.addOptions(
						CHANNEL_OPERATIONS.map((op) => ({
							label: operationLabel(op),
							value: op,
							default: pending.operations.includes(op),
						})),
					),
			),
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${MCP_IDS.confirm}${id}`)
					.setLabel(text.confirmButton)
					.setStyle(ButtonStyle.Primary)
					.setDisabled(pending.operations.length === 0),
				new ButtonBuilder()
					.setCustomId(`${MCP_IDS.cancel}${id}`)
					.setLabel(text.cancelButton)
					.setStyle(ButtonStyle.Secondary),
			),
		],
		footer: text.authorizeFooter,
	});
}

/** Asks to confirm replacing a bundle's MCP URL. */
export function rotatePanel(
	bundleName: string,
	id: string,
	text: RemoteMcpMessages,
) {
	return ownerPanel({
		title: text.rotateTitle,
		sections: [text.rotateAsk(plain(bundleName))],
		rows: [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${MCP_IDS.rotate}${id}`)
					.setLabel(text.rotateButton)
					.setStyle(ButtonStyle.Danger),
				new ButtonBuilder()
					.setCustomId(`${MCP_IDS.cancel}${id}`)
					.setLabel(text.cancelButton)
					.setStyle(ButtonStyle.Secondary),
			),
		],
		footer: text.rotateFooter,
	});
}

/** One grant as a line block: agent name, where it is, purpose, and operations. */
export async function describeGrant(
	client: Client,
	grant: ChannelGrant,
	text: RemoteMcpMessages,
): Promise<string> {
	let where = `${plain(grant.guildName)} › #${plain(grant.channelName)}`;
	try {
		const channel = await fetchManagedChannel(client, grant.channelId);
		where = `${plain(channel.guild.name)} › <#${channel.id}>`;
	} catch {
		where += text.invisibleChannel;
	}
	return [
		`- **${plain(grant.displayName)}**  ${where}`,
		text.purposeLine(plain(grant.description) || text.notSet),
		text.allowedLine(opLabels(grant.operations), grant.channelId),
	].join("\n");
}

/**
 * The channel, after checking the owner may manage it and both the owner and the bot hold
 * the Discord permissions behind each requested operation.
 */
export async function managedChannel(
	client: Client,
	channelId: string,
	userId: string,
	operations: ChannelOperation[],
	text: RemoteMcpMessages,
): Promise<ManagedChannel> {
	let channel: ManagedChannel;
	try {
		channel = await fetchManagedChannel(client, channelId);
	} catch {
		throw new OwnerFacingError(text.onlyTextChannels);
	}
	const member = await channel.guild.members.fetch({
		user: userId,
		force: true,
	});
	if (!channel.permissionsFor(member).has(PermissionFlagsBits.ManageChannels))
		throw new OwnerFacingError(text.needManageChannels);
	const bot = await channel.guild.members.fetchMe({ force: true });
	for (const op of operations) {
		const needed = OPERATION_PERMISSIONS[op];
		if (!channel.permissionsFor(member).has(needed))
			throw new OwnerFacingError(text.youLackPermission(operationLabel(op)));
		if (!channel.permissionsFor(bot).has(needed))
			throw new OwnerFacingError(text.botLacksPermission(operationLabel(op)));
	}
	return channel;
}
