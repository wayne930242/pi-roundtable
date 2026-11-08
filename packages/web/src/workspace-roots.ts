import { checkRoots, type WorkspaceRoot } from "./app/workspace-files.ts";
import type { ResolvedOptions } from "./options.ts";

/** The directories the workspace pane shows: the agents' own, then the host's `workspace.roots`. */
export function workspaceRootsOf(
	settings: ResolvedOptions,
	agents: { workDir: string; scratchDir?: string } | undefined,
): WorkspaceRoot[] {
	const roots: WorkspaceRoot[] = [];
	if (agents && settings.workspace.agents)
		roots.push({
			id: "agents",
			label: "Knights' workspace",
			dir: agents.workDir,
			writable: true,
		});
	if (agents?.scratchDir && settings.workspace.scratch)
		roots.push({
			id: "scratch",
			label: "Scratch",
			dir: agents.scratchDir,
			writable: true,
		});
	return [...roots, ...settings.workspace.roots];
}

/**
 * Roots the default pane list may show. A directory of the agents that holds the host's data would
 * stop the host from starting after an upgrade that only added a pane, so such a root is left out,
 * with the reason; the roots a host names itself are kept, and `checkRoots` fails on them.
 */
export function showableRoots(
	roots: readonly WorkspaceRoot[],
	guarded: readonly string[],
): { roots: WorkspaceRoot[]; left: { id: string; reason: string }[] } {
	const kept: WorkspaceRoot[] = [];
	const left: { id: string; reason: string }[] = [];
	for (const root of roots) {
		if (root.id !== "agents" && root.id !== "scratch") {
			kept.push(root);
			continue;
		}
		try {
			checkRoots([root], guarded);
			kept.push(root);
		} catch (error) {
			left.push({
				id: root.id,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { roots: kept, left };
}
