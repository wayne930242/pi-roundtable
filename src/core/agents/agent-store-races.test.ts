import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { TEST_GUILD } from "../testing/database.ts";
import type { AgentRow } from "./agent-schema.ts";
import { PgAgentStore } from "./agent-store.ts";

/**
 * Just enough of PostgreSQL for seeding and creating agents, in memory. A SELECT takes its
 * snapshot when it starts and answers `selectMs` later; an agent INSERT runs `insertMs` later.
 */
function fakeDatabase() {
	const agents = new Map<string, AgentRow>();
	const latency = { selectMs: 0, insertMs: 0 };
	const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?").replace(/\s+/g, " ").trim();
		if (text.startsWith("SELECT * FROM agents")) {
			const snapshot = [...agents.values()];
			await Bun.sleep(latency.selectMs);
			return snapshot;
		}
		if (text.startsWith("SELECT * FROM agent_groups")) return [];
		if (text.startsWith("INSERT INTO agents")) {
			await Bun.sleep(latency.insertMs);
			const v = values as (string | null)[];
			const name = v[1] ?? "";
			if (agents.has(name)) return [];
			const row: AgentRow = {
				name,
				display_name: v[2] ?? "",
				prompt: v[3] ?? "",
				avatar_prompt: v[4] ?? "",
				avatar_hash: null,
				character: null,
				channel_id: v[5] ?? null,
				model: null,
				thinking: null,
				status: "active",
			};
			agents.set(name, row);
			return [row];
		}
		throw new Error(`the fake does not know: ${text}`);
	};
	return { sql: run as unknown as SQL, latency };
}

const agent = (name: string) => ({
	name,
	displayName: name,
	prompt: `You are ${name}.`,
	avatarPrompt: "",
	channelId: `channel-${name}`,
});

test("an agent created while seeding stays in the directory", async () => {
	const db = fakeDatabase();
	const store = await PgAgentStore.attach(db.sql, TEST_GUILD);
	// The seeding's reload, if any, reads the agents before the creation commits.
	db.latency.selectMs = 40;
	db.latency.insertMs = 10;
	const seeded = store.seed([agent("seeded")]);
	await Bun.sleep(12);
	const created = store.createAgent(agent("made"));
	await Promise.all([seeded, created]);
	db.latency.selectMs = 0;
	expect(store.agent("made")).toBeDefined();
	expect(store.agent("seeded")).toBeDefined();
	const fresh = await PgAgentStore.attach(db.sql, TEST_GUILD);
	expect(fresh.agents()).toEqual(store.agents());
});
