import { mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DiscordAgentTeam } from "../agents/agent-team.ts";
import { FakeChannels } from "../agents/agent-team-fixture.ts";
import { discordKey } from "../agents/team-keys.ts";
import type { RoundtableConfig } from "../config/config.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { openPool } from "../db/migrations.ts";
import { defineRoundtable } from "../define-roundtable.ts";
import { CommandCollection } from "../discord/command-collection.ts";
import { commandGuard } from "../discord/owner-command.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey, TurnResult } from "../domain/conversation.ts";
import type { TurnRequest } from "../domain/ports.ts";
import { JudgeError } from "../errors.ts";
import { Roundtable } from "../host.ts";
import { silentLogger } from "../log.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin.ts";
import { AGENTS, MEMORY, RUNTIME } from "../services.ts";
import type { Speaker } from "../speakers.ts";
import { testDatabaseUrl } from "./database.ts";
import { SELECTED } from "./prompt-capture-tools.ts";
import { standInDiscord } from "./test-host.ts";

/** One tool as the model is told about it. */
export interface CapturedTool {
	name: string;
	description: string;
	parameters: unknown;
}

/** What the model received at the first request of a turn: the prompt and the tools. */
/** A turn the runtime refused before asking the model, by its error's message. */
export interface CapturedRefusal {
	refused: string;
}

export interface CapturedPrompt {
	/** Each system message's text and named sections, in order. */
	system: { content: unknown; sections?: Record<string, string | null> }[];
	/** Every tool the turn offers, sorted by name. */
	tools: CapturedTool[];
}

/** The owner of the capture hosts; ids scan-public lets through, kept apart from other tests' rows. */
export const CAPTURE_OWNER = {
	id: "966666600000000001",
	name: "Ada",
	pronouns: "she",
} as const;
/** The guild of the Discord capture host, so its agents are its own. */
export const CAPTURE_GUILD = "966666600000000002";
/** A member who speaks in a persona conversation. */
export const CAPTURE_MEMBER: Speaker = {
	id: "966666600000000003",
	name: "Kai",
	tier: "member",
	principalId: "966666600000000003",
};
/** A web user as M1's webchat names them. */
export const CAPTURE_WEB_MEMBER: Speaker = {
	id: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user-7",
	name: "Noa",
	tier: "member",
	principalId: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user-7",
};

/** Channels with ids of their own, which no other test's rows hold. */
class CaptureChannels extends FakeChannels {
	#next = 1;
	override async createChannel(
		name: string,
		topic: string,
		category: Parameters<FakeChannels["createChannel"]>[2],
	) {
		this.created.push(name);
		const id = `96666661000000000${this.#next++}`;
		this.topics.set(id, topic);
		this.put(id, category);
		return id;
	}
}

/** Removes the agents and groups an earlier capture left in its guild, so each run starts empty. */
async function clearCaptureGuild(): Promise<void> {
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

/** A faux model whose every answer is "OK." and that records the first request of each turn. */
async function fauxModel(dir: string) {
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("faux", {
		api: core.api,
		apiKey: "test",
		baseUrl: "http://faux.invalid",
		streamSimple: core.streamSimple,
		models: [
			{
				id: "faux-1",
				name: "Faux",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
		],
	});
	/** Runs the action and returns the first request the model saw during it. */
	const capture = async (
		action: () => Promise<unknown>,
	): Promise<TranscriptContext> => {
		let seen: TranscriptContext | undefined;
		const step = (context: TranscriptContext) => {
			seen ??= context;
			return fauxAssistantMessage("OK.");
		};
		core.setResponses([step, step, step, step]);
		await action();
		if (!seen) throw new Error("the turn sent the model nothing");
		return seen;
	};
	return { modelRuntime, capture };
}

const refuse = async (): Promise<never> => {
	throw new JudgeError("the prompt capture has no judge");
};
/** A judge that cannot answer, so effort falls back and a group round picks its host. */
const silentJudge: RoundtablePlugin = {
	name: "capture-judge",
	providers: {
		judge: { askYesNo: refuse, askChoice: refuse, askScore: refuse },
	},
	setup: () => ({}),
};

/** A surface whose conversations run persona turns through `context.turns`; hands over its context. */
const personas = (
	seen: (context: PluginContext) => void,
): RoundtablePlugin => ({
	name: "capture-personas",
	setup: (context) => {
		seen(context);
		const surface: ChatSurface = {
			surface: "fake",
			start: async () => undefined,
			sendReply: async () => undefined,
		};
		return {
			// As the self-compact plugin of a project `roundtable init` creates.
			piPackages: ["pi-self-compact"],
			agentSelection: () => ({ tools: SELECTED, groups: [] }),
			surfaces: [surface],
			personas: [
				{ kind: "study", prompt: () => "You are a tutor." },
				{ kind: "chat", prompt: () => "You answer on the web." },
			],
		};
	},
});

/** The checkout this module runs from, whose paths the prompt names for Pi's docs and the built-in skills. */
const CHECKOUT = resolve(import.meta.dir, "../../..");

/**
 * Every date and time the prompt states, the host's temporary paths, the checkout, and the shell's user, made stable.
 * Each of `dirs` is a unique temporary directory, replaced wherever it appears; each of `roots` is a shared parent
 * such as `tmpdir()`, replaced only where it starts a longer path, because on Linux it is `/tmp`, which the prompt's
 * prose names too.
 */
export function normalize<T>(
	value: T,
	dirs: readonly string[],
	roots: readonly string[] = [],
): T {
	let text = JSON.stringify(value);
	for (const dir of dirs) text = text.split(dir).join("<tmp>");
	for (const root of roots) text = text.split(`${root}/`).join("<tmp>/");
	text = text.split(CHECKOUT).join("<checkout>");
	text = text.split(userInfo().username).join("<user>");
	text = text
		.replace(
			/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g,
			"<datetime>",
		)
		.replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
		.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "<time>")
		.replace(
			/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g,
			"<weekday>",
		);
	// SAFETY: the text is JSON.stringify's output of a T with only string contents replaced, so it parses back to a T.
	return JSON.parse(text) as T;
}

/** The prompt and tools of a request, without timestamps. */
function captured(context: TranscriptContext): CapturedPrompt {
	const system: CapturedPrompt["system"] = [];
	const tools = new Map<string, CapturedTool>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		system.push({
			content: message.content,
			...(message.sections ? { sections: message.sections } : {}),
		});
		for (const tool of message.toolsAdded ?? [])
			tools.set(tool.name, {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			});
		for (const removed of message.toolsRemoved ?? [])
			tools.delete(removed.name);
	}
	return {
		system,
		tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
	};
}

interface CaptureHost {
	context: PluginContext;
	capture(action: () => Promise<unknown>): Promise<CapturedPrompt>;
	dirs: string[];
	stop(): Promise<void>;
}

/** Boots `defineRoundtable` on the faux model, with or without the stand-in Discord. */
/** How the capture hosts write their owner: the 0.8 `owner`, or the same person in `access`. */
export type CaptureForm = "owner" | "access";

async function captureHost(
	withDiscord: boolean,
	form: CaptureForm,
): Promise<CaptureHost> {
	const dataDir = mkdtempSync(join(tmpdir(), "roundtable-prompt-capture-"));
	const { modelRuntime, capture } = await fauxModel(dataDir);
	let probed: PluginContext | undefined;
	const base: RoundtableConfig = {
		...(form === "owner"
			? { owner: CAPTURE_OWNER }
			: {
					access: {
						owners: [
							{
								name: CAPTURE_OWNER.name,
								pronouns: CAPTURE_OWNER.pronouns,
								principal: CAPTURE_OWNER.id,
								identities: [`discord:${CAPTURE_OWNER.id}`],
							},
						],
					},
				}),
		database: { url: testDatabaseUrl },
		dataDir,
		workDir: dataDir,
		model: "faux/faux-1",
		thinking: "off",
		...(withDiscord
			? {
					discord: {
						token: "token",
						guild: CAPTURE_GUILD,
						entryChannel: "966666600000000004",
					},
					http: {
						publicUrl: "https://bot.example.com",
						socketPath: join(dataDir, "public.sock"),
					},
					agents: [
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
					],
				}
			: {}),
	};
	if (withDiscord) await clearCaptureGuild();
	const channels = new CaptureChannels();
	const discord = withDiscord
		? [
				standInDiscord(
					new CommandCollection(),
					commandGuard({
						ownerId: CAPTURE_OWNER.id,
						root: "roundtable",
						logger: silentLogger(),
					}),
					{ agentChannels: () => channels },
				),
			]
		: [];
	const defined = await defineRoundtable(
		{
			...base,
			plugins: [
				...discord,
				silentJudge,
				personas((context) => {
					probed = context;
				}),
			],
		},
		{ logger: silentLogger(), modelRuntime },
	);
	const roundtable = new Roundtable(defined.options, defined.plugins);
	await roundtable.run();
	if (!probed) throw new Error("the probe was not set up");
	const context = probed;
	const dirs = [dataDir];
	return {
		context,
		dirs,
		capture: async (action) => captured(await capture(action)),
		stop: async () => {
			await roundtable.shutdown("test");
		},
	};
}

/** Waits until the team has made the seeded agent's channel. */
async function agentChannel(
	team: DiscordAgentTeam,
	name: string,
): Promise<ChannelKey> {
	for (let tries = 0; tries < 200; tries++) {
		try {
			return team.channelOf(name);
		} catch {
			await Bun.sleep(25);
		}
	}
	throw new Error(`the team never made ${name}'s channel`);
}

const ok = (result: TurnResult) => {
	if (!result.ok) throw new Error(`the turn failed: ${JSON.stringify(result)}`);
};

/** The owner as a speaker of the capture hosts. */
export const CAPTURE_OWNER_SPEAKER: Speaker = {
	id: CAPTURE_OWNER.id,
	name: CAPTURE_OWNER.name,
	tier: "owner",
	principalId: CAPTURE_OWNER.id,
};

/** Puts one fact in each person's memory, so a prompt shows whose memory it carries. */
async function remember(context: PluginContext): Promise<void> {
	const memory = context.services.get(MEMORY);
	for (const [id, fact] of [
		[CAPTURE_OWNER.id, "Ada drinks oolong tea"],
		[CAPTURE_MEMBER.id, "Kai studies for the finals"],
		[CAPTURE_WEB_MEMBER.id, "Noa plans a trip"],
	] as const) {
		const store = memory.forSpeaker(id);
		for (const old of await store.list()) await store.removeById(old.id);
		await store.add(fact, "core");
	}
}

/** The prompt and tools of every session the M2 work must keep, normalized, by scenario, with the owner written in `form`. */
export async function capturePrompts(
	form: CaptureForm = "owner",
): Promise<Record<string, CapturedPrompt | CapturedRefusal>> {
	const out: Record<string, CapturedPrompt | CapturedRefusal> = {};
	const discord = await captureHost(true, form);
	try {
		const { context } = discord;
		await remember(context);
		// SAFETY: the Discord host's team is the agent server's DiscordAgentTeam; its port lacks channelOf.
		const team = context.services.get(AGENTS)
			.team as unknown as DiscordAgentTeam;
		const home = await agentChannel(team, "librarian");
		out["a agent session"] = await discord.capture(() =>
			context.queue.run(home, () =>
				team
					.answerOwner(
						home,
						CAPTURE_OWNER_SPEAKER,
						"Hello.",
						"Hello.",
						NO_ATTACHMENTS,
					)
					.then(ok),
			),
		);
		await team.createGroup({
			name: "council",
			displayName: "Council",
			members: ["librarian", "archivist"],
			host: "librarian",
		});
		const group = discordKey(
			context.services.get(AGENTS).directory.group("council")?.channelId ?? "",
		);
		out["b group seat"] = await discord.capture(() =>
			context.queue.run(group, () =>
				team.answerGroup(
					group,
					CAPTURE_OWNER_SPEAKER,
					"@Librarian hello.",
					"@Librarian hello.",
					NO_ATTACHMENTS,
					undefined,
				),
			),
		);
		const persona = (channel: ChannelKey, speaker: Speaker) =>
			discord.capture(() =>
				context.turns
					.run({ channel, kind: "study", text: "Hello.", speaker })
					.then(ok),
			);
		out["c owner persona conversation"] = await persona(
			"fake:study-owner",
			CAPTURE_OWNER_SPEAKER,
		);
		out["d member persona conversation"] = await persona(
			"fake:study-member",
			CAPTURE_MEMBER,
		);
		const runtime = context.services.get(RUNTIME);
		// SAFETY: it lacks only `speaker`, as 0.8's callers sent it; 0.9 refuses it, and keeps that.
		const unspoken = await runtime.runTurn({
			channel: "fake:owner-direct",
			selection: { id: "owner", ...context.sessions().agentSelection() },
			text: "Hello.",
		} as unknown as TurnRequest);
		out["e owner turn without a speaker"] = {
			refused: unspoken.ok ? "it ran" : unspoken.error.message,
		};
	} finally {
		await discord.stop();
	}
	const headless = await captureHost(false, form);
	try {
		const { context } = headless;
		await remember(context);
		const web = (channel: ChannelKey, speaker: Speaker) =>
			headless.capture(() =>
				context.turns
					.run({
						channel,
						kind: "chat",
						text: "Hello.",
						speaker,
						conversation: { visibility: "private" },
					})
					.then(ok),
			);
		out["f headless private conversation of the owner"] = await web(
			`fake:web-owner-${crypto.randomUUID()}`,
			CAPTURE_OWNER_SPEAKER,
		);
		out["g headless private conversation of a web member"] = await web(
			`fake:web-member-${crypto.randomUUID()}`,
			CAPTURE_WEB_MEMBER,
		);
	} finally {
		await headless.stop();
	}
	return normalize(out, [...discord.dirs, ...headless.dirs], [tmpdir()]);
}
