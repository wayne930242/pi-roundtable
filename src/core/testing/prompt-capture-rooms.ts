import type { DiscordAgentTeam } from "../agents/agent-team.ts";
import { groupRoomKey } from "../agents/team-keys.ts";
import { openPool } from "../db/migrations.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { AGENTS } from "../services.ts";
import type { Speaker } from "../speakers.ts";
import { testDatabaseUrl } from "./database.ts";
import type { CapturedPrompt, CaptureHost } from "./prompt-capture.ts";
import { CAPTURE_GUILD } from "./prompt-capture-scene.ts";

/** The agents the capture hosts seed. */
export const CAPTURE_ROOM_AGENTS = [
	{
		name: "librarian",
		displayName: "Librarian",
		prompt: "You keep the reading list.",
		avatarPrompt: "A calm librarian",
	},
	{
		name: "archivist",
		displayName: "Archivist",
		prompt: "You file the notes.",
		avatarPrompt: "A tidy archivist",
	},
];

/** A stand-in for the web app: a surface `app` that hosts agent rooms and sends nowhere. */
export const appRooms: RoundtablePlugin = {
	name: "app",
	setup: () => ({
		surfaces: [
			{
				surface: "app",
				label: "the web app",
				agentRooms: true,
				start: async () => undefined,
				sendReply: async () => undefined,
			},
		],
	}),
};

/** Removes the agents and groups an earlier capture left in its guild, so each run starts empty. */
export async function clearCaptureGuild(): Promise<void> {
	const sql = openPool(testDatabaseUrl);
	try {
		const [row] = await sql`SELECT to_regclass('agents') IS NOT NULL AS made`;
		if (!row?.made) return;
		for (const table of [
			"agent_group_cursors",
			"agent_group_messages",
			"agent_groups",
			"agents",
		])
			await sql`DELETE FROM ${sql(table)} WHERE guild_id = ${CAPTURE_GUILD}`;
	} finally {
		await sql.close();
	}
}

/** Removes the capture's group from the local guild of a host without Discord, which other suites share. */
export async function clearLocalGroup(): Promise<void> {
	const sql = openPool(testDatabaseUrl);
	try {
		const [row] =
			await sql`SELECT to_regclass('agent_groups') IS NOT NULL AS made`;
		if (!row?.made) return;
		for (const table of ["agent_group_cursors", "agent_group_messages"])
			await sql`DELETE FROM ${sql(table)} WHERE guild_id = 'local' AND (group_name = 'council' OR group_name LIKE 'council@%')`;
		await sql`DELETE FROM agent_groups WHERE guild_id = 'local' AND name = 'council'`;
	} finally {
		await sql.close();
	}
}

/** The first request of a seat in a group round that runs in a web room of `app`. */
export async function captureWebGroupSeat(
	host: CaptureHost,
	owner: Speaker,
): Promise<CapturedPrompt> {
	const { context } = host;
	const { directory } = context.services.get(AGENTS);
	// SAFETY: the host's team is the agent server's DiscordAgentTeam; its port lacks answerGroup.
	const team = context.services.get(AGENTS).team as unknown as DiscordAgentTeam;
	// The seeds are made after the host starts.
	for (let tries = 0; tries < 200; tries++) {
		if (directory.agent("archivist")?.status === "active") break;
		await Bun.sleep(25);
	}
	await team.createGroup({
		name: "council",
		displayName: "Council",
		members: ["librarian", "archivist"],
		host: "librarian",
	});
	const room = groupRoomKey("app", "council");
	return host.capture(() =>
		context.queue.run(room, () =>
			team.answerGroup(
				room,
				owner,
				"@Librarian hello.",
				"@Librarian hello.",
				NO_ATTACHMENTS,
				undefined,
			),
		),
	);
}
