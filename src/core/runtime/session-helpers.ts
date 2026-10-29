import {
	createBashToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ImageDrawer } from "../contract/providers.ts";
import { generateImageExtension } from "../shared/generate-image-tool.ts";
import type { WorkspaceRoots } from "../shared/workspace-files.ts";
import type { CoreExtensions } from "./runtime-types.ts";

/** `generate_image` for a session of a host with an image provider; nothing without one. */
export function imageTools(
	images: ImageDrawer | undefined,
	roots: WorkspaceRoots,
): Pick<CoreExtensions, "generateImage"> {
	return images ? { generateImage: generateImageExtension(images, roots) } : {};
}

/** Pi's bash tool with TMPDIR set to `scratchDir`, so tools that read TMPDIR and GNU `mktemp` write there (BSD `mktemp` needs `-p "$TMPDIR"`). */
export function scratchBash(cwd: string, scratchDir: string): ToolDefinition {
	// SAFETY: Pi's bash definition is a ToolDefinition typed by its own parameter schema, which the session takes as any custom tool.
	return createBashToolDefinition(cwd, {
		spawnHook: (context) => ({
			...context,
			env: { ...context.env, TMPDIR: scratchDir },
		}),
	}) as unknown as ToolDefinition;
}
