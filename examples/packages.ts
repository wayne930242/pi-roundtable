import { definePlugin } from "pi-roundtable";

/**
 * Pi packages are npm packages whose Pi extensions every session loads; install each one in your
 * project first. Loading a package registers its tools, and a turn uses only the tools it
 * selects, so the plugin selects them too. `roundtable add package <name>` writes this for you.
 */
const WEB_TOOLS = ["web_search", "fetch_content", "get_search_content"];

export const webSearch = definePlugin({
	name: "web-search",
	setup: () => ({
		piPackages: ["pi-web-access"],
		agentSelection: () => ({ tools: WEB_TOOLS, groups: [] }),
		requiredTools: WEB_TOOLS,
	}),
});
