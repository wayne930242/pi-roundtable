import { ConfigError } from "../domain/errors.ts";
import { bool, optional, shape, text } from "./schema.ts";

/** The Discord settings, at the top level or in a Discord adapter. */
export const discordShape = shape({
	token: text,
	guild: text,
	entryChannel: text,
	rootCommand: optional(text),
	admin: optional(bool),
	refusalHint: optional(text),
});

/** The adapters `adapters` takes, by the name their factory gives them. */
const ADAPTERS = ["discord"] as const;

/**
 * The configuration with its adapters in the places the host reads them: a Discord adapter's
 * settings as the top-level `discord`. Throws a ConfigError naming the adapter by its place.
 */
// pi-lens-ignore: no-unknown-returns — the configuration as written is untyped until the schema checks it
export function liftAdapters(input: unknown): unknown {
	if (typeof input !== "object" || input === null || !("adapters" in input))
		return input;
	const { adapters, ...rest } = input as Record<string, unknown>;
	if (adapters === undefined) return rest;
	if (!Array.isArray(adapters))
		throw new ConfigError(
			`config adapters: expected a list of adapters, such as [discord({ ... })] with discord from pi-roundtable/discord, got ${JSON.stringify(adapters)}. Fix the value in roundtable.config.ts.`,
		);
	const lifted: Record<string, unknown> = { ...rest };
	adapters.forEach((entry: unknown, index) => {
		const at = `adapters[${index}]`;
		const name =
			typeof entry === "object" && entry !== null
				? (entry as { adapter?: unknown }).adapter
				: undefined;
		if (typeof name !== "string")
			throw new ConfigError(
				`config ${at}: expected an adapter, an object its factory makes such as discord({ ... }) from pi-roundtable/discord, got ${JSON.stringify(entry)}. Fix the value in roundtable.config.ts.`,
			);
		if (!(ADAPTERS as readonly string[]).includes(name))
			throw new ConfigError(
				`config ${at}: unknown adapter ${JSON.stringify(name)}. The adapters are ${ADAPTERS.join(", ")}; a chat network that comes as a plugin, such as pi-roundtable-webchat's webChat(), belongs in plugins.`,
			);
		if (lifted.discord !== undefined)
			throw new ConfigError(
				`config ${at}: Discord is configured twice, at the top level or by another adapter. Keep one.`,
			);
		const { adapter: _adapter, ...settings } = entry as Record<string, unknown>;
		lifted.discord = shape({ discord: discordShape }).check(
			settings,
			at,
		).discord;
	});
	return lifted;
}
