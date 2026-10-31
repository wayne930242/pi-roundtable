import type { Client } from "discord.js";
import {
	type ChannelOperation,
	fetchManagedChannel,
	isChannelOperation,
	type ManagedChannel,
	OwnerFacingError,
} from "pi-roundtable/discord";
import {
	type ChannelAudit,
	type ChannelBundle,
	type ChannelGrant,
	type ChannelGrantStore,
	newChannelEndpoint,
} from "./channel-grants.ts";
import { managedChannel } from "./mcp-grant-panels.ts";
import type { RemoteMcpMessages } from "./messages.ts";

/** One channel of a bundle, with where it is now and its recent audit entries. */
export interface GrantView {
	channelId: string;
	guildId: string;
	/** The server and channel names Discord gives now, or the last known ones when it cannot be fetched. */
	guildName: string;
	channelName: string;
	/** False when the bot cannot see the channel now. */
	visible: boolean;
	displayName: string;
	description: string;
	operations: ChannelOperation[];
	authorizedAt: Date;
	audit: ChannelAudit[];
}

export interface BundleView {
	name: string;
	defaultOperations: ChannelOperation[];
	grants: GrantView[];
}

/** A channel to add to a bundle, by the person who authorizes it. */
export interface AuthorizeInput {
	bundle: string;
	channelId: string;
	/** The authorizing owner's Discord user ID; they must be able to manage the channel. */
	userId: string;
	operations: readonly string[];
	displayName?: string;
	description?: string;
}

export interface Authorized {
	bundle: string;
	channelName: string;
	operations: ChannelOperation[];
	/** The bundle's new MCP URL, present only when this created the bundle; shown once. */
	url?: string;
}

const CHANNEL_ID = /^\d{1,20}$/;

/**
 * What `/<root> mcp` and the `REMOTE_MCP` service both do to the owner's bundles, with the same
 * checks. A refusal is an `OwnerFacingError` in the configured wording.
 */
export class GrantOperations {
	readonly #grants: ChannelGrantStore;
	readonly #publicUrl: string;
	readonly #root: string;
	readonly #text: RemoteMcpMessages;
	readonly #quote: (name: string) => string;

	/** `quote` readies a name for a refusal's text, such as Discord's markdown escaping. */
	constructor(
		grants: ChannelGrantStore,
		publicUrl: string,
		root: string,
		text: RemoteMcpMessages,
		quote: (name: string) => string = (name) => name,
	) {
		this.#grants = grants;
		this.#publicUrl = publicUrl;
		this.#root = root;
		this.#text = text;
		this.#quote = quote;
	}

	/** The named bundle; refuses one that does not exist. */
	async bundle(name: string): Promise<ChannelBundle> {
		const bundle = await this.#grants.bundleByName(name.trim());
		if (!bundle)
			throw new OwnerFacingError(
				this.#text.noBundle(this.#quote(name.trim()), this.#root),
			);
		return bundle;
	}

	/** Refuses anything but a channel ID. */
	channelId(channelId: string): string {
		const id = channelId.trim();
		if (!CHANNEL_ID.test(id))
			throw new OwnerFacingError(this.#text.channelIdRule);
		return id;
	}

	/** Every bundle with its channels and each channel's recent audit entries. */
	async bundles(client: Client): Promise<BundleView[]> {
		const [bundles, grants] = await Promise.all([
			this.#grants.bundles(),
			this.#grants.grants(),
		]);
		return Promise.all(
			bundles.map(async (bundle) => ({
				name: bundle.name,
				defaultOperations: bundle.defaultOperations,
				grants: await Promise.all(
					grants
						.filter((g) => g.bundleId === bundle.id)
						.map((g) => this.#grantView(client, g)),
				),
			})),
		);
	}

	/** Resolves false when the channel was not in the bundle. */
	async revoke(bundle: ChannelBundle, channelId: string): Promise<boolean> {
		return this.#grants.revoke(bundle.id, channelId);
	}

	/** Changes the name and purpose an agent sees; resolves false when the channel is not in the bundle. */
	async describe(
		bundle: ChannelBundle,
		channelId: string,
		change: { displayName?: string; description?: string },
	): Promise<boolean> {
		const displayName = change.displayName?.trim();
		const description = change.description?.trim();
		if (displayName === undefined && description === undefined)
			throw new OwnerFacingError(this.#text.nameOrDescription);
		return this.#grants.describe(bundle.id, channelId, {
			...(displayName === undefined ? {} : { displayName }),
			...(description === undefined ? {} : { description }),
		});
	}

	/** Replaces the bundle's URL; the new one is returned this once and only its hash is kept. */
	async rotate(bundleId: string): Promise<string> {
		const endpoint = newChannelEndpoint(this.#publicUrl);
		await this.#grants.rotateToken(bundleId, endpoint.tokenHash);
		return endpoint.url;
	}

	/** Refuses a bundle name the flow would not take. */
	bundleName(name: string): string {
		const trimmed = name.trim();
		if (!trimmed || trimmed.length > 80)
			throw new OwnerFacingError(this.#text.bundleNameRule);
		return trimmed;
	}

	/** Refuses an empty choice or an operation that is not one. */
	operations(operations: readonly string[]): ChannelOperation[] {
		const chosen = operations.filter(isChannelOperation);
		if (chosen.length === 0 || chosen.length !== operations.length)
			throw new OwnerFacingError(this.#text.operationsRequired);
		return [...new Set(chosen)];
	}

	/**
	 * Adds the channel to the bundle, creating the bundle when it does not exist, or replaces its
	 * grant there. The channel must be one the user may manage, and the user and the bot must both
	 * hold the permissions behind each operation.
	 */
	async authorize(
		client: Client,
		input: Omit<AuthorizeInput, "operations"> & {
			operations: ChannelOperation[];
		},
	): Promise<Authorized & { channel: ManagedChannel; created: boolean }> {
		const channel = await managedChannel(
			client,
			input.channelId,
			input.userId,
			input.operations,
			this.#text,
		);
		const endpoint = newChannelEndpoint(this.#publicUrl);
		const { bundle, created } = await this.#grants.ensureBundle(
			input.bundle,
			endpoint.tokenHash,
			input.operations,
		);
		const existing = await this.#grants.grant(bundle.id, channel.id);
		await this.#grants.save({
			bundleId: bundle.id,
			channelId: channel.id,
			guildId: channel.guildId,
			operations: input.operations,
			displayName: input.displayName || existing?.displayName || channel.name,
			description: input.description || existing?.description || "",
			guildName: channel.guild.name,
			channelName: channel.name,
			authorizedBy: input.userId,
			authorizedAt: new Date(),
		});
		return {
			bundle: bundle.name,
			channelName: channel.name,
			operations: input.operations,
			channel,
			created,
			...(created ? { url: endpoint.url } : {}),
		};
	}

	async #grantView(client: Client, grant: ChannelGrant): Promise<GrantView> {
		let guildName = grant.guildName;
		let channelName = grant.channelName;
		let visible = true;
		try {
			const channel = await fetchManagedChannel(client, grant.channelId);
			guildName = channel.guild.name;
			channelName = channel.name;
		} catch {
			visible = false;
		}
		return {
			channelId: grant.channelId,
			guildId: grant.guildId,
			guildName,
			channelName,
			visible,
			displayName: grant.displayName,
			description: grant.description,
			operations: grant.operations,
			authorizedAt: grant.authorizedAt,
			audit: await this.#grants.recentAudit(grant.channelId),
		};
	}
}
