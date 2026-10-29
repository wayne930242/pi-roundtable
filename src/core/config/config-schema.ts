import type { InterimTextMode } from "../domain/interim.ts";
import { isLocale, type Locale } from "../i18n/index.ts";
import { type EffortPolicy, THINKING_LEVELS } from "../models.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import type { Tier } from "../speakers.ts";
import { accessShape } from "./access.ts";
import { discordShape } from "./adapters.ts";
import { attachmentsShape } from "./attachments.ts";
import type { Pronouns } from "./config.ts";
import { conversationsShape } from "./conversations.ts";
import { limitsShape } from "./limits.ts";
import { profilesShape } from "./profiles.ts";
import {
	bool,
	characterInput,
	type Field,
	guarded,
	integer,
	list,
	number,
	oneOf,
	optional,
	record,
	shape,
	skinTones,
	text,
} from "./schema.ts";
import { skillsField } from "./skills-config.ts";

/** The shape `roundtable.config.ts` is checked against: every key, its type and its bounds. */
const tierMembers = shape({
	users: optional(list(text)),
	roles: optional(list(text)),
	everyone: optional(bool),
});

const agentServerDescribe =
	'false, to leave the agent server out, or { tools: "chat-only" } to take the shell and file tools from its agents (leave the key out to keep both)';
const chatOnlyShape = shape({ tools: oneOf("chat-only" as const) });
const agentServerField: Field<false | { tools: "chat-only" }> = {
	describe: agentServerDescribe,
	check: (value, path) => {
		if (value === false) return false;
		if (typeof value === "object" && value !== null && !Array.isArray(value))
			return chatOnlyShape.check(value, path);
		return guarded(agentServerDescribe, (_): _ is never => false).check(
			value,
			path,
		);
	},
};

const isPolicy = (value: unknown): value is EffortPolicy =>
	typeof value === "function";
const isPlugin = (value: unknown): value is RoundtablePlugin =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { name?: unknown }).name === "string" &&
	typeof (value as { setup?: unknown }).setup === "function";

export const configSchema = shape({
	name: optional(text),
	owner: optional(
		shape({
			id: text,
			name: text,
			pronouns: optional(oneOf<Pronouns>("he", "she", "they")),
		}),
	),
	discord: optional(discordShape),
	agentServer: optional(agentServerField),
	database: shape({ url: text }),
	dataDir: text,
	attachments: attachmentsShape,
	conversations: conversationsShape,
	agentDir: optional(text),
	model: text,
	thinking: optional(oneOf(...THINKING_LEVELS)),
	judge: optional(
		shape({ model: optional(text), threshold: optional(number(0, 1)) }),
	),
	effortPolicy: optional(
		guarded("a function from a turn to its effort rule", isPolicy),
	),
	delegation: optional(
		shape({
			model: optional(text),
			thinking: optional(oneOf(...THINKING_LEVELS)),
		}),
	),
	locale: optional(
		guarded("a locale, en or zh-TW", (value): value is Locale =>
			isLocale(value),
		),
	),
	timeZone: optional(text),
	speakers: optional(
		shape({ admins: optional(tierMembers), members: optional(tierMembers) }),
	),
	access: optional(accessShape),
	profiles: optional(profilesShape),
	background: optional(
		shape({
			perPrincipal: optional(
				shape({
					schedules: optional(integer(1, 10_000)),
					delegations: optional(integer(1, 1_000)),
				}),
			),
		}),
	),
	toolTiers: optional(record(oneOf<Tier>("owner", "admin", "member"))),
	prompts: optional(shape({ shared: text, guest: optional(text) })),
	agents: optional(
		list(
			shape({
				name: text,
				displayName: text,
				prompt: text,
				character: optional(characterInput),
				avatarPrompt: optional(text),
				channelId: optional(text),
			}),
		),
	),
	coordinator: optional(text),
	characters: optional(
		shape({ skins: optional(skinTones), refreshAvatars: optional(bool) }),
	),
	http: optional(
		shape({
			publicUrl: optional(text),
			port: optional(integer(1, 65535)),
			hostname: optional(text),
			socketPath: optional(text),
			socketMode: optional(integer(0, 0o777)),
		}),
	),
	avatar: optional(text),
	workDir: optional(text),
	scratchDir: optional(text),
	skills: optional(skillsField),
	memory: optional(bool),
	ops: optional(shape({ agent: optional(text), conversation: optional(text) })),
	drainSeconds: optional(integer(1, 3_600)),
	...limitsShape,
	interimText: optional(oneOf<InterimTextMode>("on", "off")),
	interimPrimaryChars: optional(integer(1, 100_000)),
	plugins: optional(
		list(
			guarded("a plugin, an object with a name and a setup function", isPlugin),
		),
	),
});
