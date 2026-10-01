import { PluginError } from "../errors.ts";
import { type ComposedCommands, composeCommands } from "./compose-commands.ts";
import type {
	CommandRegistrar,
	CommandRoot,
	InteractionContribution,
} from "./interaction-module.ts";

/**
 * The commands the plugins add while they set up, composed once under the root command. Adding
 * after the composition is refused, because Discord registers the commands as it connects and a
 * late one would never reach it.
 */
export class CommandCollection {
	readonly #contributions: InteractionContribution[] = [];
	#closed = false;

	/** What plugins reach as `DISCORD.commands`. */
	readonly registrar: CommandRegistrar = {
		add: (contribution) => {
			if (this.#closed)
				throw new PluginError(
					"commands can be added only while plugins set up: the Discord plugin composed them in its preflight, before any service started. Call commands.add from setup.",
				);
			if (
				typeof contribution?.module?.commands !== "function" ||
				typeof contribution.module.handle !== "function"
			)
				throw new PluginError(
					"commands.add takes { module, rootOptions? }, where the module has commands() and handle(interaction).",
				);
			this.#contributions.push(contribution);
		},
	};

	/** Every contribution added so far, in the order added. */
	added(): readonly InteractionContribution[] {
		return this.#contributions;
	}

	/** Composes every added contribution, in the order added; closes the collection to later additions. */
	compose(root: CommandRoot): ComposedCommands {
		this.#closed = true;
		return composeCommands(root, this.#contributions);
	}
}
