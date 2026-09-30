import type { DefinedRoundtable } from "../core/define-roundtable.ts";
import { buildChecks, type DoctorInputs } from "./doctor.ts";
import { Project } from "./project.ts";
import { failed, type Outcome, runChecks } from "./report.ts";

export interface StartInputs extends Omit<DoctorInputs, "reachable"> {
	/** Runs the bot; by default the host with its signal handlers. Tests pass a fake. */
	launch(defined: DefinedRoundtable): Promise<void>;
}

export interface StartReport {
	/** Whether the bot was launched. */
	started: boolean;
	outcomes: Outcome[];
}

/**
 * Runs the checks that need no network, then starts the bot. A failing check stops it before
 * anything reaches Discord, with the message `doctor` prints for it; what needs the network
 * (PostgreSQL, Discord) fails the boot itself, before Discord connects, when it is wrong.
 */
export async function start(inputs: StartInputs): Promise<StartReport> {
	const project = new Project(inputs.cwd, inputs.ports);
	const offline = buildChecks({ ...inputs, reachable: false }, project).filter(
		(check) => check.offline,
	);
	const outcomes = await runChecks(offline);
	if (failed(outcomes).length > 0) return { started: false, outcomes };
	const assembled = await project.assembled();
	if (!assembled.ok) return { started: false, outcomes };
	await inputs.launch(assembled.value.defined);
	return { started: true, outcomes };
}
