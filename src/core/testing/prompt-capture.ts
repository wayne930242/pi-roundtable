import { mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentServerTeam } from "../agents/agent-team.ts";
import { groupRoomKey } from "../agents/team-keys.ts";
import type { DiscordServices } from "../builtin/discord.ts";
import type { RoundtableConfig } from "../config/config.ts";
import { discordKey } from "../contract/discord-key.ts";
import { openPool } from "../db/migrations.ts";
import { CommandCollection } from "../discord/command-collection.ts";
import { commandGuard } from "../discord/owner-command.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey, TurnResult } from "../domain/conversation.ts";
import type { TurnRequest } from "../domain/ports.ts";
import { defineRoundtable } from "../host/define-roundtable.ts";
import { Roundtable } from "../host/host.ts";
import type { Speaker } from "../identity/speakers.ts";
import { JudgeError } from "../kernel/errors.ts";
import { silentLogger } from "../kernel/log.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin-api/plugin.ts";
import { AGENTS, MEMORY, RUNTIME } from "../plugin-api/services.ts";
import { testDatabaseUrl } from "./database.ts";
import type { FakeChannels } from "./fake-agent-channels.ts";
import { CaptureChannels, fauxModel } from "./prompt-capture-model.ts";
import {
	appRooms,
	CAPTURE_ROOM_AGENTS,
	captureWebGroupSeat,
	clearCaptureGuild,
	clearLocalGroup,
} from "./prompt-capture-rooms.ts";
import {
	addressed,
	CAPTURE_GUILD,
	CAPTURE_MEMBER,
	CAPTURE_OWNER,
	CAPTURE_WEB_MEMBER,
	captureChannelContext,
} from "./prompt-capture-scene.ts";
import { personas } from "./prompt-capture-tools.ts";
import { standInDiscord } from "./test-host.ts";

/** One tool as the model is told about it. */
export interface CapturedTool {
	name: string;
	description: string;
	parameters: unknown;
}

/** A turn the runtime refused before asking the model, by its error's message. */
export interface CapturedRefusal {
	refused: string;
}

/** What the model received at the first request of a turn: the prompt and the tools. */
export interface CapturedPrompt {
	/** Each system message's text and named sections, in order. */
	system: { content: unknown; sections?: Record<string, string | null> }[];
	/** Every tool the turn offers, sorted by name. */
	tools: CapturedTool[];
	/** The turn's own message as the model received it; recorded only where a scenario asks for it. */
	turn?: unknown;
}

export { CAPTURE_GUILD, CAPTURE_MEMBER, CAPTURE_OWNER, CAPTURE_WEB_MEMBER };

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

/** The prompt and tools of a request, without timestamps; with the turn's own message when `turn` is set. */
function captured(context: TranscriptContext, turn = false): CapturedPrompt {
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
	const own = context.messages.findLast((message) => message.role === "user");
	return {
		system,
		tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
		...(turn ? { turn: own?.content } : {}),
	};
}

/** A host booted on the faux model: its plugins' context, and what the model saw during an action. */
export interface CaptureHost {
	context: PluginContext;
	/** What the model saw at the action's first request; with the turn's own message when `turn` is set. */
	capture(
		action: () => Promise<unknown>,
		turn?: boolean,
	): Promise<CapturedPrompt>;
	dirs: string[];
	stop(): Promise<void>;
}

/** How the capture hosts write their owner: the 0.8 `owner`, or the same person in `access`. */
export type CaptureForm = "owner" | "access";

/** The agent guild and entry channel of the capture host with Discord. */
export const CAPTURE_DISCORD = {
	guild: CAPTURE_GUILD,
	entryChannel: "966666600000000004",
};

/** The plugin that provides `DISCORD` on the capture host, over the host's channels and channel context. */
export type CaptureDiscord = (given: {
	channels: FakeChannels;
	channelContext: DiscordServices["channelContext"];
}) => RoundtablePlugin;

/** The stand-in the capture hosts run on unless a test brings a Discord of its own. */
const standIn: CaptureDiscord = ({ channels, channelContext }) =>
	standInDiscord(
		new CommandCollection(),
		commandGuard({
			ownerId: CAPTURE_OWNER.id,
			root: "roundtable",
			logger: silentLogger(),
		}),
		{ agentChannels: () => channels },
		CAPTURE_OWNER.id,
		channelContext,
		CAPTURE_DISCORD.guild,
		CAPTURE_DISCORD.entryChannel,
	);

/** Boots `defineRoundtable` on the faux model, with or without the stand-in Discord. */
export async function captureHost(
	withDiscord: boolean,
	form: CaptureForm,
	/** The host's database; by default the test server's shared one. */
	databaseUrl = testDatabaseUrl,
	/** Seeds two agents on a host without Discord and gives it the web app's room surface. */
	rooms = false,
	/** The plugin that provides `DISCORD` in the stand-in's place. */
	discordOf: CaptureDiscord = standIn,
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
		database: { url: databaseUrl },
		dataDir,
		workDir: dataDir,
		model: "faux/faux-1",
		thinking: "off",
		...(withDiscord
			? {
					discord: { token: "token", ...CAPTURE_DISCORD },
					http: {
						publicUrl: "https://bot.example.com",
						socketPath: join(dataDir, "public.sock"),
					},
					agents: CAPTURE_ROOM_AGENTS,
				}
			: rooms
				? { agents: CAPTURE_ROOM_AGENTS }
				: {}),
	};
	if (withDiscord) await clearCaptureGuild();
	if (rooms) await clearLocalGroup();
	const discord = withDiscord
		? [
				discordOf({
					channels: new CaptureChannels(),
					channelContext: captureChannelContext(),
				}),
			]
		: [];
	const defined = await defineRoundtable(
		{
			...base,
			plugins: [
				...discord,
				silentJudge,
				...(rooms ? [appRooms] : []),
				personas((context) => {
					probed = context;
				}, withDiscord),
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
		capture: async (action, turn) => captured(await capture(action), turn),
		stop: async () => {
			await roundtable.shutdown("test");
		},
	};
}

/** Waits until the team has made the seeded agent's channel. */
async function agentChannel(
	team: AgentServerTeam,
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

/**
 * The scenarios of the host with Discord, (a) to (e) and (h), not yet normalized, with the host's
 * temporary directories; `discordOf` provides `DISCORD` in the stand-in's place.
 */
export async function captureDiscordPrompts(
	form: CaptureForm = "owner",
	discordOf?: CaptureDiscord,
): Promise<{
	out: Record<string, CapturedPrompt | CapturedRefusal>;
	dirs: string[];
}> {
	const out: Record<string, CapturedPrompt | CapturedRefusal> = {};
	const discord = await captureHost(true, form, undefined, false, discordOf);
	try {
		const { context } = discord;
		await remember(context);
		// SAFETY: the Discord host's team is the agent server's AgentServerTeam; its port lacks channelOf.
		const team = context.services.get(AGENTS)
			.team as unknown as AgentServerTeam;
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
		// Each run's conversations are new ones: the registry keeps how a key was first recorded.
		const persona = (
			channel: ChannelKey,
			speaker: Speaker,
			visibility: "private" | "shared",
		) =>
			discord.capture(() =>
				context.turns
					.run({
						channel,
						kind: "study",
						text: "Hello.",
						speaker,
						conversation: { visibility },
					})
					.then(ok),
			);
		// The owner's own conversation is the owner principal's private one, and reads as in 0.8.
		out["c owner persona conversation"] = await persona(
			`fake:study-owner-${crypto.randomUUID()}`,
			CAPTURE_OWNER_SPEAKER,
			"private",
		);
		// A room a member speaks in is shared: since 0.9 its tools name the speaker, not the owner.
		out["d member persona conversation"] = await persona(
			`fake:study-member-${crypto.randomUUID()}`,
			CAPTURE_MEMBER,
			"shared",
		);
		// The owner addresses an agent in its channel after others spoke there: the turn reads them as channel context.
		const archivist = await agentChannel(team, "archivist");
		out["h agent session with channel context"] = await discord.capture(
			() => context.conversations.handle(addressed(archivist)),
			true,
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
	return { out, dirs: discord.dirs };
}

/** The prompt and tools of every session the M2 work must keep, normalized, by scenario, with the owner written in `form`. */
export async function capturePrompts(
	form: CaptureForm = "owner",
): Promise<Record<string, CapturedPrompt | CapturedRefusal>> {
	const discord = await captureDiscordPrompts(form);
	const { out } = discord;
	const web = await captureHost(false, form, undefined, true);
	try {
		out["i web group seat"] = await captureWebGroupSeat(
			web,
			CAPTURE_OWNER_SPEAKER,
		);
	} finally {
		await web.stop();
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
	return normalize(
		out,
		[...discord.dirs, ...web.dirs, ...headless.dirs],
		[tmpdir()],
	);
}
