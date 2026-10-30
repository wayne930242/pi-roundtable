import { readCharacter } from "../../characters/index.ts";
import { scopeToGuild } from "../db/guild-scope.ts";
import type { Migration } from "../db/migrations.ts";
import type { ThinkingLevel } from "../models.ts";
import { promptHistoryMigration } from "../modules/prompts/prompt-history.ts";
import { outboxMigration } from "./agent-outbox.ts";
import type { Agent, AgentGroup, AgentStatus } from "./agent-rules.ts";

export interface AgentRow {
	name: string;
	display_name: string;
	prompt: string;
	avatar_prompt: string;
	avatar_hash: string | null;
	/** jsonb: the stored spec, an object, or null before the team dressed the agent. */
	character: unknown | null;
	channel_id: string | null;
	model: string | null;
	thinking: ThinkingLevel | null;
	status: AgentStatus;
}

export interface GroupRow {
	name: string;
	display_name: string;
	channel_id: string | null;
	members: string;
	host: string;
	status: AgentStatus;
}

export const toAgent = (row: AgentRow): Agent => {
	const character = readCharacter(row.character);
	return {
		name: row.name,
		displayName: row.display_name,
		prompt: row.prompt,
		avatarPrompt: row.avatar_prompt,
		...(character ? { character } : {}),
		...(row.avatar_hash ? { avatarHash: row.avatar_hash } : {}),
		...(row.channel_id ? { channelId: row.channel_id } : {}),
		...(row.model ? { model: row.model } : {}),
		...(row.thinking ? { thinking: row.thinking } : {}),
		status: row.status,
	};
};

export const toGroup = (row: GroupRow): AgentGroup => ({
	name: row.name,
	displayName: row.display_name,
	...(row.channel_id ? { channelId: row.channel_id } : {}),
	members: row.members.split(",").filter(Boolean),
	host: row.host,
	status: row.status,
});

/** The store's tables; the host runs this before any store attaches. */
export const agentsMigration: Migration = {
	name: "agents",
	up: async (sql) => {
		await sql`
			CREATE TABLE IF NOT EXISTS agents (
				name text PRIMARY KEY,
				display_name text NOT NULL,
				prompt text NOT NULL,
				avatar_prompt text NOT NULL,
				avatar_hash text,
				channel_id text UNIQUE,
				status text NOT NULL DEFAULT 'active',
				created_at timestamptz NOT NULL DEFAULT now(),
				updated_at timestamptz NOT NULL DEFAULT now()
			)`;
		await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS model text`;
		await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS thinking text`;
		await sql`
			CREATE TABLE IF NOT EXISTS agent_groups (
				name text PRIMARY KEY,
				display_name text NOT NULL,
				channel_id text NOT NULL UNIQUE,
				-- Comma-separated agent names, which never contain a comma.
				members text NOT NULL,
				host text NOT NULL,
				status text NOT NULL DEFAULT 'active',
				created_at timestamptz NOT NULL DEFAULT now()
			)`;
		await sql`
			CREATE TABLE IF NOT EXISTS agent_group_messages (
				id bigserial PRIMARY KEY,
				group_name text NOT NULL,
				author text NOT NULL,
				author_name text NOT NULL,
				text text NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now()
			)`;
		await sql`CREATE INDEX IF NOT EXISTS agent_group_messages_group ON agent_group_messages (group_name, id)`;
		await sql`
			CREATE TABLE IF NOT EXISTS agent_group_cursors (
				group_name text NOT NULL,
				agent_name text NOT NULL,
				last_id bigint NOT NULL,
				PRIMARY KEY (group_name, agent_name)
			)`;
	},
};

/**
 * The migrations of the store's tables for the guild the process serves, or the local team
 * without Discord: the tables, then each row's guild, with existing rows given `guildId`, then
 * the group channel made optional.
 */
export function agentMigrations(guildId: string): Migration[] {
	return [
		agentsMigration,
		{
			name: "agents-guild",
			up: (sql) =>
				scopeToGuild(sql, guildId, [
					{ table: "agents", key: ["name"] },
					{ table: "agent_groups", key: ["name"] },
					{ table: "agent_group_messages", key: ["id"] },
					{ table: "agent_group_cursors", key: ["group_name", "agent_name"] },
				]),
		},
		// A team without Discord has groups that live in rooms only, with no channel.
		{
			name: "agent-groups-channel-optional",
			up: async (sql) => {
				await sql`ALTER TABLE agent_groups ALTER COLUMN channel_id DROP NOT NULL`;
			},
		},
		// The composed look, dressed in code at the team's start; rows keep their drawn picture until then.
		{
			name: "agents-character",
			up: async (sql) => {
				await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS character jsonb`;
			},
		},
		// The change history of the agents' prompts; the prompts plugin creates the same table for its documents.
		promptHistoryMigration("agent-prompt-history"),
		// Agent messages the host refused while it stopped, replayed at the next start.
		outboxMigration(),
	];
}
