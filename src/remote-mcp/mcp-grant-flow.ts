import { randomUUID } from "node:crypto";
import type {
	AutocompleteInteraction,
	ButtonInteraction,
	ChatInputCommandInteraction,
	StringSelectMenuInteraction,
} from "discord.js";
import {
	ephemeralPanel,
	isChannelOperation,
	OwnerFacingError,
	ownerPanel,
	plain,
	replyWithPanels,
} from "pi-roundtable/discord";
import {
	type ChannelGrantStore,
	newChannelEndpoint,
} from "./channel-grants.ts";
import {
	authorizePanel,
	describeGrant,
	GRANT_PREFIX,
	managedChannel,
	opLabels,
	PENDING_MS,
	type Pending,
	rotatePanel,
} from "./mcp-grant-panels.ts";
import type { RemoteMcpMessages } from "./messages.ts";

type ButtonOrMenu = ButtonInteraction | StringSelectMenuInteraction;

/**
 * `/<root> mcp …`: which channels an outside agent may use through a bundle's MCP URL, and
 * with which operations. A grant can never exceed what both the owner and the bot may do.
 */
export class McpGrantFlow {
	readonly #grants: ChannelGrantStore;
	readonly #publicUrl: string;
	readonly #root: string;
	readonly #text: RemoteMcpMessages;
	readonly #pending = new Map<string, Pending>();

	constructor(
		grants: ChannelGrantStore,
		publicUrl: string,
		root: string,
		text: RemoteMcpMessages,
	) {
		this.#grants = grants;
		this.#publicUrl = publicUrl;
		this.#root = root;
		this.#text = text;
	}

	async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
		const typed = interaction.options.getFocused().trim().slice(0, 80);
		const query = typed.toLocaleLowerCase();
		const bundles = await this.#grants.bundles();
		const choices = bundles
			.filter((b) => b.name.toLocaleLowerCase().includes(query))
			.map((b) => ({ name: b.name, value: b.name }));
		// Only authorize creates bundles; the other subcommands need an existing one.
		const creating =
			interaction.options.getSubcommand() === "authorize" &&
			typed !== "" &&
			!bundles.some((b) => b.name === typed);
		await interaction.respond(
			[
				...(creating
					? [{ name: this.#text.newBundleChoice(typed), value: typed }]
					: []),
				...choices,
			].slice(0, 25),
		);
	}

	/** The interaction is deferred and ephemeral. */
	async command(interaction: ChatInputCommandInteraction): Promise<void> {
		const text = this.#text;
		const sub = interaction.options.getSubcommand(true);
		if (sub === "grants") return this.#showGrants(interaction);
		if (!interaction.inGuild()) throw new OwnerFacingError(text.useInServer);
		const bundleName = interaction.options.getString("bundle", true).trim();
		if (sub === "authorize")
			return this.#beginAuthorize(interaction, bundleName);
		const bundle = await this.#grants.bundleByName(bundleName);
		if (!bundle)
			throw new OwnerFacingError(text.noBundle(plain(bundleName), this.#root));
		if (sub === "token") {
			const id = this.#hold(interaction, {
				bundleName: bundle.name,
				bundleId: bundle.id,
				operations: [],
				rotate: true,
			});
			await interaction.editReply(rotatePanel(bundle.name, id, text));
			return;
		}
		const channelId =
			interaction.options.getString("channel_id")?.trim() ??
			interaction.channelId;
		if (!/^\d{1,20}$/.test(channelId))
			throw new OwnerFacingError(text.channelIdRule);
		if (sub === "describe")
			return this.#describe(interaction, bundle, channelId);
		const removed = await this.#grants.revoke(bundle.id, channelId);
		for (const [id, value] of this.#pending)
			if (value.channelId === channelId) this.#pending.delete(id);
		await interaction.editReply(
			ownerPanel({
				title: text.revokedTitle,
				sections: [
					removed
						? text.revoked(plain(bundle.name))
						: text.revokeNotInBundle(plain(bundle.name)),
				],
			}),
		);
	}

	/** Buttons and the operations menu of a pending grant or rotation. */
	async component(interaction: ButtonOrMenu): Promise<void> {
		const text = this.#text;
		const [action, id = ""] = interaction.customId
			.slice(GRANT_PREFIX.length)
			.split(":");
		const pending = this.#pending.get(id);
		if (
			!pending ||
			pending.userId !== interaction.user.id ||
			pending.channelId !== interaction.channelId ||
			pending.expiresAt <= Date.now()
		) {
			await interaction.reply(
				ephemeralPanel({
					title: text.expiredTitle,
					sections: [text.expiredBody],
				}),
			);
			return;
		}
		await interaction.deferUpdate();
		if (action === "cancel") {
			this.#pending.delete(id);
			await interaction.editReply(
				ownerPanel({
					title: text.cancelledTitle,
					sections: [text.cancelledBody],
				}),
			);
			return;
		}
		if (action === "select" && interaction.isStringSelectMenu()) {
			pending.operations = interaction.values.filter(isChannelOperation);
			await interaction.editReply(authorizePanel(id, pending, "chosen", text));
			return;
		}
		// Consumed before any await, so a double click cannot act twice.
		this.#pending.delete(id);
		if (action === "rotate" && pending.rotate && pending.bundleId) {
			await this.#rotate(interaction, pending, pending.bundleId);
			return;
		}
		if (action === "confirm" && !pending.rotate && pending.operations.length)
			await this.#confirm(interaction, pending);
	}

	async #describe(
		interaction: ChatInputCommandInteraction,
		bundle: { id: string; name: string },
		channelId: string,
	): Promise<void> {
		const text = this.#text;
		const displayName = interaction.options.getString("name")?.trim();
		const description = interaction.options.getString("description")?.trim();
		if (displayName === undefined && description === undefined)
			throw new OwnerFacingError(text.nameOrDescription);
		const changed = await this.#grants.describe(bundle.id, channelId, {
			...(displayName === undefined ? {} : { displayName }),
			...(description === undefined ? {} : { description }),
		});
		await interaction.editReply(
			ownerPanel({
				title: text.describeTitle,
				sections: [
					changed ? text.described : text.notInBundle(plain(bundle.name)),
				],
			}),
		);
	}

	async #rotate(
		interaction: ButtonOrMenu,
		pending: Pending,
		bundleId: string,
	): Promise<void> {
		const text = this.#text;
		const endpoint = newChannelEndpoint(this.#publicUrl);
		await this.#grants.rotateToken(bundleId, endpoint.tokenHash);
		await interaction.editReply(
			ownerPanel({
				title: text.rotatedTitle,
				sections: [
					text.rotated(plain(pending.bundleName)),
					text.urlSection(endpoint.url),
				],
				footer: text.urlFooter,
			}),
		);
	}

	async #beginAuthorize(
		interaction: ChatInputCommandInteraction,
		bundleName: string,
	): Promise<void> {
		const text = this.#text;
		if (!bundleName || bundleName.length > 80)
			throw new OwnerFacingError(text.bundleNameRule);
		await managedChannel(
			interaction.client,
			interaction.channelId,
			interaction.user.id,
			[],
			text,
		);
		const bundle = await this.#grants.bundleByName(bundleName);
		const existing = bundle
			? await this.#grants.grant(bundle.id, interaction.channelId)
			: undefined;
		for (const [key, value] of this.#pending)
			if (value.channelId === interaction.channelId) this.#pending.delete(key);
		const pending: Omit<Pending, "userId" | "channelId" | "expiresAt"> = {
			bundleName,
			operations: [
				...(existing?.operations ?? bundle?.defaultOperations ?? []),
			],
			rotate: false,
		};
		const displayName = interaction.options.getString("name")?.trim();
		const description = interaction.options.getString("description")?.trim();
		if (displayName) pending.displayName = displayName;
		if (description) pending.description = description;
		const id = this.#hold(interaction, pending);
		const held = this.#pending.get(id);
		if (held)
			await interaction.editReply(
				authorizePanel(id, held, existing ? "existing" : "defaults", text),
			);
	}

	async #confirm(interaction: ButtonOrMenu, pending: Pending): Promise<void> {
		const text = this.#text;
		const channel = await managedChannel(
			interaction.client,
			pending.channelId,
			pending.userId,
			pending.operations,
			text,
		);
		const endpoint = newChannelEndpoint(this.#publicUrl);
		const { bundle, created } = await this.#grants.ensureBundle(
			pending.bundleName,
			endpoint.tokenHash,
			pending.operations,
		);
		const existing = await this.#grants.grant(bundle.id, channel.id);
		await this.#grants.save({
			bundleId: bundle.id,
			channelId: channel.id,
			guildId: channel.guildId,
			operations: pending.operations,
			displayName: pending.displayName ?? existing?.displayName ?? channel.name,
			description: pending.description ?? existing?.description ?? "",
			guildName: channel.guild.name,
			channelName: channel.name,
			authorizedBy: pending.userId,
			authorizedAt: new Date(),
		});
		await interaction.editReply(
			ownerPanel({
				title: text.grantedTitle,
				sections: [
					text.granted(
						plain(channel.name),
						plain(bundle.name),
						opLabels(pending.operations, text),
					),
					created ? text.urlSection(endpoint.url) : text.existingUrl,
				],
				footer: created ? text.urlFooter : text.urlLostFooter(this.#root),
			}),
		);
	}

	async #showGrants(interaction: ChatInputCommandInteraction): Promise<void> {
		const text = this.#text;
		const [grants, bundles] = await Promise.all([
			this.#grants.grants(),
			this.#grants.bundles(),
		]);
		const sections: string[] = [];
		for (const bundle of bundles) {
			const own = grants.filter((g) => g.bundleId === bundle.id);
			const lines = await Promise.all(
				own.map((g) => describeGrant(interaction.client, g, text)),
			);
			sections.push(
				`**${plain(bundle.name)}**\n${own.length ? lines.join("\n") : text.noChannels}`,
			);
		}
		if (sections.length === 0) sections.push(text.noGrants);
		if (interaction.inGuild()) {
			const audit = await this.#grants.recentAudit(interaction.channelId);
			if (audit.length)
				sections.push(
					`${text.recentAudit}\n${audit
						.map(
							(a) =>
								`<t:${Math.floor(a.createdAt.getTime() / 1000)}:f> \`${a.tool}\` ${text.auditStatus(a.status)}`,
						)
						.join("\n")}`,
				);
		}
		await replyWithPanels(interaction, {
			title: text.grantsTitle,
			sections,
			footer: text.grantsFooter(this.#root),
		});
	}

	#hold(
		interaction: ChatInputCommandInteraction,
		pending: Omit<Pending, "userId" | "channelId" | "expiresAt">,
	): string {
		for (const [key, value] of this.#pending)
			if (value.expiresAt <= Date.now()) this.#pending.delete(key);
		const id = randomUUID();
		this.#pending.set(id, {
			...pending,
			userId: interaction.user.id,
			channelId: interaction.channelId,
			expiresAt: Date.now() + PENDING_MS,
		});
		return id;
	}
}
