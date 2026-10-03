import { AgentError, scrubDiagnostic } from "pi-roundtable/kit";

/** Worker diagnostics reach the owner scrubbed of credentials and bounded; stderr and raw responses never do. */
export class CodingWorkerFailure extends AgentError {
	constructor(
		readonly category: "stopped" | "exit" | "missing-report",
		readonly exitCode?: number,
		detail?: string,
	) {
		const reason = detail ? scrubDiagnostic(detail) : "";
		let message = "the worker was stopped";
		if (category === "exit")
			message =
				reason ||
				`The coding worker exited (code ${exitCode}); check its model, login and package configuration.`;
		if (category === "missing-report")
			message = "The coding worker returned no report.";
		super(message);
	}
}
