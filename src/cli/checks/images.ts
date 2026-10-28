import { fillsImages } from "../../core/registry/providers.ts";
import type { Project } from "../project.ts";
import { ok, type Result } from "../report.ts";

/** The guide ships in the package, so the path is readable offline. */
const GUIDE =
	"node_modules/pi-roundtable/docs/plugins.md#providers-replace-a-part-the-core-runs-on";

/** Whether a plugin fills the `images` slot. Not having one is a choice, not a failure: agents are composed characters, which the agent server no longer draws with an image provider. */
export async function checkImageProvider(project: Project): Promise<Result> {
	const assembled = await project.assembled();
	if (!assembled.ok)
		return { status: "skipped", reason: "the configuration is not valid yet" };
	return fillsImages(assembled.value.defined.plugins)
		? ok(
				"a plugin fills the images slot, used for agents' generate_image; the agent server no longer draws their avatars with it",
			)
		: ok(
				`none; agents are composed characters, and the agent server no longer draws with the images slot. To let agents make pictures with generate_image, fill the slot, as the plugin guide shows: ${GUIDE}`,
			);
}
