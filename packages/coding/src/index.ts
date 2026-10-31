export type {
	CodingAutonomy,
	CodingDeskOptions,
	CodingJob,
	CodingLimits,
	CodingModes,
	CodingProgress,
	CodingResult,
	CodingSpeaker,
	CodingStart,
	CodingStarter,
	CodingThreadText,
	CodingWorker,
	HeldCallAnswer,
} from "./coding-desk.ts";
export { CodingDesk, codingReport, integrationText } from "./coding-desk.ts";
export type {
	CodingOptions,
	CodingPresentation,
	CodingRun,
	CodingService,
	CodingToolText,
	RepoToolName,
} from "./coding-plugin.ts";
export { CODING, coding } from "./coding-plugin.ts";
export type { PiCodingWorkerOptions } from "./pi-coding-worker.ts";
export { PiCodingWorker } from "./pi-coding-worker.ts";
export type {
	ChangeReport,
	CloneCommand,
	Integration,
	RepoState,
	RepoSummary,
	WorkerTree,
} from "./repo-shelf.ts";
export {
	ghClone,
	RepoShelf,
	reportPost,
	WORKTREES_DIR,
} from "./repo-shelf.ts";
export { REPO_TOOLS } from "./repo-tools.ts";
export { CodingWorkerFailure } from "./worker-failure.ts";
