import type { Project } from "../project.ts";
import { fail, ok, type Result, skipped } from "../report.ts";

/**
 * What the agents' turns may use of the machine: the shell and file tools ("full"), or none
 * ("chat-only", `agentServer: { tools: "chat-only" }`). Fails for a chat-only host with a plugin
 * whose tools reach the host, which the host would refuse to start with.
 */
export async function checkAgentTools(project: Project): Promise<Result> {
	const assembled = await project.assembled();
	if (!assembled.ok) return skipped("the configuration is not valid yet");
	const { config, defined } = assembled.value;
	if (!config.agentServer) return skipped("the agent server is off");
	if (config.agentTools === "full")
		return ok("full (the agents carry the shell and file tools)");
	const reaching = defined.plugins.find((plugin) => plugin.hostAccess === true);
	if (reaching)
		return fail(
			`plugin ${reaching.name} declares hostAccess: its tools reach the host's machine, and the configuration says agentServer: { tools: "chat-only" }.`,
			`Remove the plugin ${reaching.name}, or remove tools: "chat-only" from agentServer.`,
		);
	return ok("chat-only (no shell, file or workspace tools)");
}
