import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Pins each run's active tools to the turn's selection. Inline factories load after path
 * extensions, so this handler runs last and undoes additions such as pi-web-access
 * re-adding web_enable or claude-bridge's AskClaude.
 */
export function activeToolsExtension(
	currentTools: () => readonly string[],
): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", () => {
			pi.setActiveTools([...currentTools()]);
		});
	};
}
