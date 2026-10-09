import { parseModelRef } from "../../core/models.ts";
import {
	BRIDGE_MEMORY_FIX,
	bridgeMemoryProblem,
	configuredCrowd,
	onClaudeBridge,
} from "../../core/runtime/bridge-guard.ts";
import type { Ports, Project } from "../project.ts";
import { fail, ok, type Result, skipped, warn } from "../report.ts";

/**
 * A login exists for the provider of the configured model: an API key variable or a stored login;
 * with a non-failing warning for bridge's shared private-memory replay risk.
 */
export async function checkModelLogin(
	project: Project,
	ports: Pick<Ports, "login">,
): Promise<Result> {
	const model = await project.text("model");
	if (!model) return skipped("model has no value");
	const ref = parseModelRef(model);
	if (!ref)
		return fail(
			`the model ${JSON.stringify(model)} is not written <provider>/<id>.`,
			"Write it like anthropic/claude-sonnet-5-5 in MODEL in .env.",
		);
	// Admission warns of risk; each shared turn checks actual private history.
	let risk: Result | undefined;
	const assembled = await project.assembled();
	if (assembled.ok) {
		const { config } = assembled.value;
		const crowd = configuredCrowd(config.access, config.plugins);
		if (config.memory && crowd && onClaudeBridge(ref))
			risk = warn(bridgeMemoryProblem(model, crowd), BRIDGE_MEMORY_FIX);
	}
	const dir = await project.text("agentDir");
	const dataDir = await project.text("dataDir");
	const agentDir = dir ?? (dataDir ? `${dataDir}/pi` : undefined);
	if (!agentDir) return skipped("dataDir has no value");
	const source = await ports.login(agentDir, ref.provider);
	if (source) return risk ?? ok(`${ref.provider} login from ${source}`);
	return fail(
		`no login for ${ref.provider}, the provider of ${model}.`,
		`Set the provider's API key in .env (ANTHROPIC_API_KEY for anthropic, OPENAI_API_KEY for openai), or sign in with Pi so ${agentDir}/auth.json holds it.`,
	);
}
