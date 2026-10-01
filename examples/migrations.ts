import { definePlugin, defineTool } from "pi-roundtable";
import { Type } from "typebox";

/**
 * Migrations create the plugin's tables before any setup runs. Each one runs once and is recorded
 * in a ledger. Table names are shared with every other plugin: prefix them.
 */
export const visitCounter = definePlugin({
	name: "visit-counter",
	migrations: [
		{
			name: "visit-counter-1-create",
			up: async (sql) => {
				await sql`CREATE TABLE IF NOT EXISTS visit_counter (
					channel text PRIMARY KEY,
					visits integer NOT NULL DEFAULT 0
				)`;
			},
		},
	],
	setup: (context) => {
		// The host's one connection pool, already migrated.
		const sql = context.database();
		return {
			tools: [
				defineTool({
					name: "visit_count",
					description: "Count a visit to a place and say which visit it is.",
					parameters: Type.Object({ place: Type.String() }),
					minTier: "member",
					run: async ({ place }) => {
						const [row] = await sql`
							INSERT INTO visit_counter (channel, visits) VALUES (${place}, 1)
							ON CONFLICT (channel) DO UPDATE SET visits = visit_counter.visits + 1
							RETURNING visits`;
						return `Visit ${row?.visits} to ${place}.`;
					},
				}),
			],
		};
	},
});
