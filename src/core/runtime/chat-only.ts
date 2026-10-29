import { ConfigError } from "../domain/errors.ts";
import { SHELL_TOOLS } from "../modules/host-shell/shell-policy.ts";
import type { RoundtablePlugin } from "../plugin.ts";

const CHAT_ONLY = 'agentServer: { tools: "chat-only" }';

/** The shell and file tools among these names. */
export function shellToolsIn(names: Iterable<string>): string[] {
	const shell: readonly string[] = SHELL_TOOLS;
	return [...new Set(names)].filter((name) => shell.includes(name));
}

/**
 * Refuses names that carry the machine's shell and file tools: the one place a chat-only host
 * checks, where a selection turns into active tools. `where` says whose selection it is.
 */
export function refuseShellTools(names: Iterable<string>, where: string): void {
	const found = shellToolsIn(names);
	if (found.length > 0)
		throw new ConfigError(
			`${where} names ${found.join(", ")}, which ${CHAT_ONLY} withholds from every turn. Take the tool out of the selection, or remove tools: "chat-only" from agentServer to give the agents the shell.`,
		);
}

/** Refuses, at start, a plugin whose tools reach the host: an agent of a chat-only host must not. */
export function refuseHostAccess(plugins: readonly RoundtablePlugin[]): void {
	const reaching = plugins.find((plugin) => plugin.hostAccess === true);
	if (reaching)
		throw new ConfigError(
			`plugin ${reaching.name} declares hostAccess: its tools reach the host's machine, and the configuration says ${CHAT_ONLY}. Remove the plugin, or remove tools: "chat-only" from agentServer.`,
		);
}
