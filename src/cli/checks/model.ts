import { parseModelRef } from "../../core/models.ts";
import type { Ports, Project } from "../project.ts";
import { fail, ok, type Result, skipped } from "../report.ts";

/** A login exists for the provider of the configured model: an API key variable or a stored login. */
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
	const dir = await project.text("agentDir");
	const dataDir = await project.text("dataDir");
	const agentDir = dir ?? (dataDir ? `${dataDir}/pi` : undefined);
	if (!agentDir) return skipped("dataDir has no value");
	const source = await ports.login(agentDir, ref.provider);
	if (source) return ok(`${ref.provider} login from ${source}`);
	return fail(
		`no login for ${ref.provider}, the provider of ${model}.`,
		`Set the provider's API key in .env (ANTHROPIC_API_KEY for anthropic, OPENAI_API_KEY for openai), or sign in with Pi so ${agentDir}/auth.json holds it.`,
	);
}
