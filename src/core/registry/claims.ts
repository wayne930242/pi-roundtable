import type { BackgroundTarget } from "../contract/channels.ts";
import { PluginError } from "../kernel/errors.ts";
import type { Persona } from "../plugin-api/plugin.ts";
import type { DirectChannelProvider } from "../presence/direct-channels.ts";

/** Which plugin registered each name of one kind, so a clash names both. */
export class Names {
	readonly #owners = new Map<string, string>();

	constructor(private readonly kind: string) {}

	claim(plugin: string, name: string): void {
		const other = this.#owners.get(name);
		if (other !== undefined)
			throw new PluginError(
				`plugin ${plugin}: ${this.kind} ${name} is already registered by plugin ${other}. Rename one of the two.`,
			);
		this.#owners.set(name, plugin);
	}
}

/** The kind of a conversation the agent server runs itself, which no plugin's persona may take. */
const RESERVED_KIND = "agent";

/**
 * Refuses a persona without a kind, for the reserved agent kind, or for a kind another plugin's
 * persona already has, so a conversation's prompt is never a matter of plugin order.
 */
export function claimPersona(
	kinds: Map<string, string>,
	plugin: string,
	persona: Persona,
): void {
	const { kind } = persona;
	if (typeof kind !== "string" || kind === "")
		throw new PluginError(
			`plugin ${plugin}: a persona needs a kind, a non-empty string such as "study", and got ${JSON.stringify(kind)}.`,
		);
	if (kind === RESERVED_KIND)
		throw new PluginError(
			`plugin ${plugin}: the persona kind "${RESERVED_KIND}" is reserved for the agent server's agents. Give the persona the kind of your own conversations.`,
		);
	if (typeof persona.prompt !== "function")
		throw new PluginError(
			`plugin ${plugin}: the persona of kind "${kind}" needs a prompt() that returns its text.`,
		);
	if (
		persona.memory !== undefined &&
		persona.memory !== "speaker" &&
		persona.memory !== "none"
	)
		throw new PluginError(
			`plugin ${plugin}: the persona of kind "${kind}" has memory ${JSON.stringify(persona.memory)}; expected "speaker" or "none".`,
		);
	const other = kinds.get(kind);
	if (other !== undefined)
		throw new PluginError(
			`plugin ${plugin}: persona kind "${kind}" is already registered by plugin ${other}. Keep one persona per kind.`,
		);
	kinds.set(kind, plugin);
}

/**
 * Refuses a direct channel without a name, a label, or `reaches`, or whose name another plugin's
 * already has, so the providers a person is reached through never depend on a typo.
 */
export function claimDirectChannel(
	names: Names,
	plugin: string,
	provider: DirectChannelProvider,
): void {
	const { name } = provider;
	if (typeof name !== "string" || name === "")
		throw new PluginError(
			`plugin ${plugin}: a direct channel needs a name, a non-empty string such as "discord", and got ${JSON.stringify(name)}.`,
		);
	if (typeof provider.label !== "string" || provider.label === "")
		throw new PluginError(
			`plugin ${plugin}: the direct channel "${name}" needs a label, such as "a direct message on Discord", which the notify tool names it by.`,
		);
	if (typeof provider.reaches !== "function")
		throw new PluginError(
			`plugin ${plugin}: the direct channel "${name}" needs reaches(principalId), which finds a person's own conversation there.`,
		);
	names.claim(plugin, name);
}

/**
 * Refuses a background target without a name or a label, or whose name another plugin's target
 * already has, so a stored schedule's target never depends on plugin order.
 */
export function claimTarget(
	names: Map<string, string>,
	plugin: string,
	target: BackgroundTarget,
): void {
	const { name } = target;
	if (typeof name !== "string" || name === "")
		throw new PluginError(
			`plugin ${plugin}: a background target needs a name, a non-empty string such as "support", and got ${JSON.stringify(name)}.`,
		);
	if (typeof target.label !== "function")
		throw new PluginError(
			`plugin ${plugin}: the background target "${name}" needs a label(locale) that returns its name for lists.`,
		);
	const other = names.get(name);
	if (other !== undefined)
		throw new PluginError(
			`plugin ${plugin}: background target "${name}" is already registered by plugin ${other}. Keep one target per name.`,
		);
	names.set(name, plugin);
}

/** The surface's own words for what a prefix must be, checked before its service is named. */
export function checkSurfacePrefix(plugin: string, prefix: unknown): void {
	if (typeof prefix !== "string" || prefix === "" || /[:\s]/.test(prefix))
		throw new PluginError(
			`plugin ${plugin}: a surface is named by the prefix of its channel keys, a non-empty word without a colon or space, such as discord; got ${JSON.stringify(prefix)}.`,
		);
}
