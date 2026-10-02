import { AgentError } from "pi-roundtable/kit";

/** Structured diagnostics never carry provider responses, stderr or credentials. */
export class CodingWorkerFailure extends AgentError {
	constructor(
		readonly category: "stopped" | "exit" | "missing-report",
		readonly exitCode?: number,
	) {
		let message = "The coding worker was stopped.";
		if (category === "exit")
			message = `The coding worker exited (code ${exitCode}); check its model, login and package configuration.`;
		if (category === "missing-report")
			message = "The coding worker returned no report.";
		super(message);
	}
}
