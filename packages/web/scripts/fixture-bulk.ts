// Rows for the pages that handle many at once: stored workspace conversations for the overview, and
// archived knights for the hidden and archived page. The fixture app calls these when
// FIXTURE_WORKSPACES or FIXTURE_ARCHIVED is set.

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

const DAY = 86_400_000;

/** `count` workspace conversations in the host's session directory, from just now to about 60 days idle. */
export function seedWorkspaces(dataDir: string, count: number): void {
	for (let i = 0; i < count; i += 1) {
		const dir = join(
			dataDir,
			"sessions",
			`discord_9000000000000${String(i).padStart(5, "0")}`,
		);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "2026-01-01T00-00-00-000Z_fixture.jsonl");
		writeFileSync(file, "x".repeat(40_000 + i * 9_000));
		const idle = new Date(Date.now() - i * 2.6 * DAY - 3_600_000);
		utimesSync(file, idle, idle);
	}
}

/** `count` knights made through the app's API, each given a last message 1 to 90 days old, then archived. */
export async function seedArchive(
	origin: string,
	database: string,
	count: number,
): Promise<void> {
	if (count <= 0) return;
	const sql = new SQL(database);
	const api = async (path: string, init: RequestInit = {}) => {
		const response = await fetch(`${origin}/console/api/${path}`, {
			...init,
			headers: { origin, "content-type": "application/json" },
		});
		if (!response.ok) throw new Error(`${path}: ${response.status}`);
	};
	const ages = [1, 3, 9, 12, 20, 45, 60, 90];
	for (let i = 0; i < count; i += 1) {
		const number = String(i + 1).padStart(2, "0");
		const name = `old${number}`;
		await api("agents", {
			method: "POST",
			body: JSON.stringify({
				name,
				displayName: `Old ${number}`,
				prompt: `You are ${name}.`,
			}),
		});
		await sql.unsafe(
			`INSERT INTO web_room_messages (room, kind, agent, author_name, text, created_at)
			 VALUES ('app:agent.${name}', 'agent', '${name}', 'Old', 'An old talk.', now() - interval '${ages[i % ages.length]} days')`,
		);
		await api(`agents/${name}/archive`, { method: "POST" });
	}
	await sql.close();
}
