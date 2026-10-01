import {
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
	SlashCommandBuilder,
} from "discord.js";
import { PluginError } from "../errors.ts";
import type {
	CommandRoot,
	InteractionContribution,
	InteractionModule,
} from "./interaction-module.ts";

/** Every command to register with Discord, and the modules that answer them in order. */
export interface ComposedCommands {
	commands: RESTPostAPIChatInputApplicationCommandsJSONBody[];
	modules: InteractionModule[];
}

/**
 * Composes the root command from every contribution's subcommands, in contribution order, after
 * the modules' own commands. Refuses a module that registers the root itself, and any command or
 * subcommand name used twice.
 */
export function composeCommands(
	root: CommandRoot,
	contributions: readonly InteractionContribution[],
): ComposedCommands {
	const commands = contributions.flatMap(({ module }) => module.commands());
	const names = new Set<string>();
	for (const command of commands) {
		if (command.name === root.name)
			throw new PluginError(
				`/${root.name} is composed from subcommands; a module may not register it`,
			);
		if (names.has(command.name))
			throw new PluginError(`/${command.name} is registered twice`);
		names.add(command.name);
	}
	const options = contributions.flatMap((c) => c.rootOptions ?? []);
	const subcommands = new Set<string>();
	for (const option of options) {
		if (subcommands.has(option.name))
			throw new PluginError(`/${root.name} ${option.name} is added twice`);
		subcommands.add(option.name);
	}
	if (options.length > 0)
		commands.push({
			...new SlashCommandBuilder()
				.setName(root.name)
				.setDescription(root.description)
				.setContexts(...root.contexts)
				.toJSON(),
			options: [...options],
		});
	return { commands, modules: contributions.map((c) => c.module) };
}
