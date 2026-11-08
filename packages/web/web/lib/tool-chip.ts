/** One tool call of a running turn, as the progress strip shows it. */
export interface ToolChip {
	id: string;
	tool: string;
	preview?: string;
	status: "running" | "ok" | "failed" | "refused";
	refused?: "declined" | "expired" | "pending" | "held" | "withdrawn";
}
