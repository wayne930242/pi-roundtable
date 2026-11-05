import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatCommand } from "../contract/chat-command.ts";
import { PluginError } from "../kernel/errors.ts";
import { packageDir } from "../shared/package-dir.ts";

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

/** Where a plugin's extensions come from: its Pi packages, and the names of its session tools. */
export interface ChatCommandOrigin {
	packages: readonly string[];
	sessionTools: readonly string[];
}

/** A command a loaded Pi session registers, with the extension that registered it (Pi's `sourceInfo`). */
export interface LoadedCommand {
	/** What a message starts with after the slash. */
	invocationName: string;
	sourceInfo: { path: string; baseDir?: string };
}

/**
 * Tells which declared chat commands are real. A declaration is only a label; a command is listed
 * once a session the host built has loaded it from an extension of the plugin that declared it: a
 * package that plugin lists in `piPackages`, or one of its session tools. A declaration nothing
 * registers, or one that another plugin's extension registers, is never listed.
 */
export class ChatCommandSources {
	readonly #declared = new Map<
		string,
		{ command: ChatCommand; origin: ChatCommandOrigin }
	>();
	/** Each command name a session registered, with the extensions that registered it. */
	readonly #loaded = new Map<string, LoadedCommand["sourceInfo"][]>();
	readonly #dirs = new Map<string, string | undefined>();
	readonly #roots = new Map<string, string | undefined>();

	/** `resolve` finds a package's folder by name; tests give their own. */
	readonly #resolve: (name: string) => string;

	constructor(resolve: (name: string) => string = packageDir) {
		this.#resolve = resolve;
	}

	declare(command: ChatCommand, origin: ChatCommandOrigin): void {
		this.#declared.set(command.name, { command, origin });
	}

	/** Records the commands a built session registered; called for every session, so the list grows as extensions load. */
	loaded(commands: readonly LoadedCommand[]): void {
		for (const { invocationName, sourceInfo } of commands) {
			const seen = this.#loaded.get(invocationName) ?? [];
			if (!seen.some((one) => one.path === sourceInfo.path))
				this.#loaded.set(invocationName, [...seen, sourceInfo]);
		}
	}

	/** The declared commands a loaded extension of the declaring plugin registers, in declaration order. */
	listed(): ChatCommand[] {
		return [...this.#declared.values()].flatMap(({ command, origin }) =>
			(this.#loaded.get(command.name) ?? []).some((source) =>
				this.#owns(origin, source),
			)
				? [command]
				: [],
		);
	}

	#owns(origin: ChatCommandOrigin, source: LoadedCommand["sourceInfo"]) {
		if (origin.sessionTools.some((name) => source.path === `<inline:${name}>`))
			return true;
		return origin.packages.some((name) => {
			const dir = this.#dir(name);
			// The extension's own package is the nearest folder with a package.json, so a package
			// installed inside another's folder (nested node_modules) is not taken for the outer one.
			return dir !== undefined && this.#root(source.path) === dir;
		});
	}

	#root(path: string): string | undefined {
		if (!this.#roots.has(path)) {
			let dir = existsSync(join(path, "package.json")) ? path : dirname(path);
			while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir)
				dir = dirname(dir);
			this.#roots.set(
				path,
				existsSync(join(dir, "package.json")) ? dir : undefined,
			);
		}
		return this.#roots.get(path);
	}

	#dir(name: string): string | undefined {
		if (!this.#dirs.has(name)) {
			try {
				this.#dirs.set(name, this.#resolve(name));
			} catch {
				this.#dirs.set(name, undefined);
			}
		}
		return this.#dirs.get(name);
	}
}
