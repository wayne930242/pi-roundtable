import { fillsImages } from "../../core/registry/providers.ts";
import type { Project } from "../project.ts";
import { ok, type Result } from "../report.ts";

/** The guide ships in the package, so the path is readable offline. */
const GUIDE =
	"node_modules/pi-roundtable/docs/plugins.md#providers-replace-a-part-the-core-runs-on";

/** Whether a plugin fills the `images` slot. Not having one is a choice, not a failure: agents get generated avatars. */
export async function checkImageProvider(project: Project): Promise<Result> {
	const assembled = await project.assembled();
	if (!assembled.ok)
		return { status: "skipped", reason: "the configuration is not valid yet" };
	return fillsImages(assembled.value.defined.plugins)
		? ok("a plugin fills the images slot; agents' avatars are drawn")
		: ok(
				`none; agents use avatars generated from their display names. To have them drawn, fill the images slot, as the plugin guide shows: ${GUIDE}`,
			);
}
