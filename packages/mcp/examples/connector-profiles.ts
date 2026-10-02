import { definePlugin } from "pi-roundtable";
import { CONNECTORS } from "pi-roundtable-mcp";

/**
 * A plugin registered after `mcpConnectors` reads the owner's connectors from the service and builds
 * whatever it needs from them: here, one line per connector for its own routing prompt. `version`
 * changes on every add, change, and removal, so a cache of anything built from the list is stale
 * when the version it was built at is not the current one.
 */
export function connectorRouting(onLines: (lines: string[]) => void) {
	return definePlugin({
		name: "connector-routing",
		requires: [CONNECTORS],
		setup: ({ services }) => {
			const connectors = services.get(CONNECTORS);
			let builtAt = -1;
			let lines: string[] = [];
			return {
				services: [
					{
						name: "connector-routing",
						start: () => {
							if (builtAt !== connectors.version) {
								lines = connectors
									.profileSources()
									.map((source) => `${source.name}: ${source.description}`);
								builtAt = connectors.version;
							}
							onLines(lines);
						},
					},
				],
			};
		},
	});
}
