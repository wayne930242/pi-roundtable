import type { InterimTextMode } from "../domain/interim.ts";
import { isLocale, type Locale } from "../i18n/index.ts";
import { type EffortPolicy, THINKING_LEVELS } from "../models.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import type { Tier } from "../speakers.ts";
import { accessShape } from "./access.ts";
import { discordShape } from "./adapters.ts";
import { attachmentsShape } from "./attachments.ts";
import type { Pronouns } from "./config.ts";
import { limitsShape } from "./limits.ts";
import {
	bool,
	characterInput,
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
	agentServer: optional(
		guarded(
			"false, to leave the agent server out (leave the key out to keep it)",
			(value): value is false => value === false,
		),
	),
	database: shape({ url: text }),
	dataDir: text,
	attachments: attachmentsShape,
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
	characters: optional(shape({ skins: optional(skinTones) })),
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
