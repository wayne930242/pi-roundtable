import { type BunFacts, checkBun } from "./checks/bun.ts";
import { checkConfiguration, checkPlugins } from "./checks/configuration.ts";
import { checkDatabase, type DatabasePort } from "./checks/database.ts";
import {
	checkChannel,
	checkGuild,
	checkIntents,
	checkToken,
	Discord,
} from "./checks/discord.ts";
import { checkEnvironment } from "./checks/environment.ts";
import { checkModelLogin } from "./checks/model.ts";
import { checkPublicUrl } from "./checks/public-url.ts";
import type { Http } from "./http.ts";
import { type Ports, Project } from "./project.ts";
import { type Check, failed, type Outcome, runChecks } from "./report.ts";

export interface DoctorInputs {
	cwd: string;
	env: Record<string, string | undefined>;
	bun: BunFacts;
	ports: Ports;
	database: DatabasePort;
	http: Http;
	/** Also ask the public address to answer, which is only true while the bot runs. */
	reachable: boolean;
}

export interface DoctorReport {
	ok: boolean;
	outcomes: Outcome[];
}

/** Every check, in the order they are shown; `offline` ones need no network and are the ones `start` runs. */
export function buildChecks(
	inputs: DoctorInputs,
	project = new Project(inputs.cwd, inputs.ports),
): Check[] {
	const { cwd, env, bun, ports, database, http, reachable } = inputs;
	const discord = new Discord(project, http);
	return [
		{ name: "Bun", offline: true, run: async () => checkBun(bun) },
		{
			name: "environment",
			offline: true,
			run: async () => checkEnvironment(cwd, env),
		},
		{
			name: "configuration",
			offline: true,
			run: () => checkConfiguration(project),
		},
		{ name: "plugins", offline: true, run: () => checkPlugins(project) },
		{
			name: "PostgreSQL",
			offline: false,
			run: () => checkDatabase(project, database),
		},
		{ name: "Discord token", offline: false, run: () => checkToken(discord) },
		{
			name: "Discord guild",
			offline: false,
			run: () => checkGuild(project, discord),
		},
		{
			name: "Discord intents",
			offline: false,
			run: () => checkIntents(discord),
		},
		{
			name: "Discord channel",
			offline: false,
			run: () => checkChannel(project, discord),
		},
		{
			name: "model login",
			offline: true,
			run: () => checkModelLogin(project, ports),
		},
		{
			name: "public URL",
			offline: true,
			run: () => checkPublicUrl(project, http, reachable),
		},
	];
}

/** Runs every check and reports each; it changes nothing it looked at. */
export async function doctor(inputs: DoctorInputs): Promise<DoctorReport> {
	const outcomes = await runChecks(buildChecks(inputs));
	return { ok: failed(outcomes).length === 0, outcomes };
}
