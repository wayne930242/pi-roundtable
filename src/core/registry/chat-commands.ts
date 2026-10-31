import type { ChatCommand } from "../contract/chat-command.ts";
import { PluginError } from "../errors.ts";

const CHAT_COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
/** The commands the web app answers itself, so a declared command cannot take their names. */
const APP_COMMANDS = ["clear", "new", "skill"];

/** Records a plugin's chat command under its name, or throws PluginError for a name that is not allowed or taken. */
export function claimChatCommand(
	names: Map<string, string>,
	plugin: string,
	command: ChatCommand,
): void {
	const { name, description } = command;
	if (typeof name !== "string" || !CHAT_COMMAND_NAME.test(name))
		throw new PluginError(
			`plugin ${plugin}: a chat command needs a name of lowercase letters, digits, dashes and underscores that starts with a letter, such as "stats", and got ${JSON.stringify(name)}.`,
		);
	if (APP_COMMANDS.includes(name))
		throw new PluginError(
			`plugin ${plugin}: the chat command "${name}" is one the app has itself (${APP_COMMANDS.join(", ")}). Pick another name.`,
		);
	if (typeof description !== "string" || description.trim() === "")
		throw new PluginError(
			`plugin ${plugin}: the chat command "${name}" needs a description, one line for the menu.`,
		);
	const other = names.get(name);
	if (other !== undefined)
		throw new PluginError(
			`plugin ${plugin}: chat command "${name}" is already declared by plugin ${other}. Keep one declaration per name.`,
		);
	names.set(name, plugin);
}
