import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	formatModelRef,
	type ModelRef,
	type ThinkingLevel,
} from "../models.ts";
import { workerSessions } from "../modules/delegation/worker-session.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { WORKER_SESSIONS } from "../services.ts";

export interface WorkerSessionsPluginOptions {
	/** Shared with the rest of the host, so logins refresh in one place. */
	modelRuntime: ModelRuntime;
	agentDir: string;
	dataDir: string;
	/** The model and thinking level a worker session uses unless its request names its own. */
	delegation: { model: ModelRef; thinking: ThinkingLevel };
}

/** Provides `WORKER_SESSIONS`: worker sessions on the host's model login, with its delegation settings as the defaults. */
export function workerSessionsPlugin(
	options: WorkerSessionsPluginOptions,
): RoundtablePlugin {
	return {
		name: "worker-sessions",
		provides: [WORKER_SESSIONS],
		setup: ({ services }) => {
			services.provide(
				WORKER_SESSIONS,
				workerSessions({
					modelRuntime: options.modelRuntime,
					agentDir: options.agentDir,
					workDir: join(options.dataDir, "workers"),
					delegation: {
						model: formatModelRef(options.delegation.model),
						thinking: options.delegation.thinking,
					},
				}),
			);
			return {};
		},
	};
}
