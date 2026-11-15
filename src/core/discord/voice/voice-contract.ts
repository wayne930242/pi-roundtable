import { expect, test } from "bun:test";
import type {
	DiscordVoice,
	VoiceJoinFailure,
	VoiceMember,
	VoiceSession,
} from "./voice.ts";

// What `DISCORD.voice` keeps, whoever provides it: the Discord plugin's service over discord.js
// and @discordjs/voice, and `fakeDiscordVoice()`. Each runs these scenarios over its own world.

/** The Discord a scenario drives, behind the voice under test. */
export interface VoiceWorld {
	/** A channel exists. */
	channel(
		channelId: string,
		channel: {
			guildId: string;
			kind?: "voice" | "stage" | "text";
			forbidden?: boolean;
			full?: boolean;
			members?: VoiceMember[];
		},
	): void;
	enter(channelId: string, member: VoiceMember): void;
	exit(channelId: string, userId: string): void;
	/** One frame of someone speaking, as 48 kHz 16-bit mono PCM. */
	audio(channelId: string, userId: string, pcm: Uint8Array): void;
	/** Enough silence passes for every open utterance to end. */
	quiet(): void;
	drop(guildId: string, how: "removed" | "moved" | "connection_lost"): void;
	/** Discord is not connected. */
	offline(): void;
	/** The host stops. */
	stop(): Promise<void>;
	/** The bot's own user id. */
	botId: string;
}

export interface VoiceSubject {
	voice: DiscordVoice;
	world: VoiceWorld;
}

interface Scenario {
	name: string;
	run(subject: VoiceSubject): Promise<void>;
}

const GUILD = "100000000000000001";
const ROOM = "200000000000000001";
const ANN: VoiceMember = { userId: "301", bot: false, displayName: "Ann" };
const BEN: VoiceMember = { userId: "302", bot: false, displayName: "Ben" };
const DJ: VoiceMember = { userId: "303", bot: true, displayName: "DJ" };
/** A 20 ms frame: 960 samples of 16-bit mono, every byte `fill`. */
const frame = (fill: number) => new Uint8Array(1_920).fill(fill);

async function joined(
	{ voice, world }: VoiceSubject,
	members: VoiceMember[] = [ANN],
	options?: Parameters<DiscordVoice["join"]>[1],
): Promise<VoiceSession> {
	world.channel(ROOM, { guildId: GUILD, members });
	const answer = await voice.join({ guildId: GUILD, channelId: ROOM }, options);
	if (!answer.ok) throw new Error(`join failed: ${answer.failure}`);
	return answer.session;
}

/** Everything a session reports, as short lines in the order it came. */
function heard(session: VoiceSession): string[] {
	const lines: string[] = [];
	session.onMember(({ kind, member }) =>
		lines.push(`${kind} ${member.displayName}`),
	);
	session.onSpeaking(({ userId, speaking }) =>
		lines.push(`${speaking ? "speaks" : "quiet"} ${userId}`),
	);
	session.onUtterance(({ userId, pcm, continues }) =>
		lines.push(
			`said ${userId} ${pcm.byteLength}${continues ? " continues" : ""}`,
		),
	);
	session.onDisconnect(({ reason }) => lines.push(`ended ${reason}`));
	return lines;
}

async function refused(
	{ voice }: VoiceSubject,
	channelId: string,
	failure: VoiceJoinFailure,
	guildId = GUILD,
): Promise<void> {
	const answer = await voice.join({ guildId, channelId });
	expect(answer.ok ? "joined" : answer.failure).toBe(failure);
	if (!answer.ok) expect(answer.message.length).toBeGreaterThan(0);
	if (failure !== "already_joined")
		expect(voice.session(guildId)).toBeUndefined();
}

const scenarios: Scenario[] = [
	{
		name: "1. a join answers the session with who is in the channel, the bot not among them; a guild has one session",
		async run(subject) {
			const { voice, world } = subject;
			const me = { userId: world.botId, bot: true, displayName: "me" };
			const session = await joined(subject, [ANN, DJ, me]);
			expect([session.guildId, session.channelId]).toEqual([GUILD, ROOM]);
			expect(session.members()).toEqual([ANN, DJ]);
			expect(session.ended()).toBeUndefined();
			expect(voice.session(GUILD)).toBe(session);
			world.channel("200000000000000002", { guildId: GUILD });
			await refused(subject, ROOM, "already_joined");
			await refused(subject, "200000000000000002", "already_joined");
			expect(voice.session(GUILD)).toBe(session);
			// Another guild is another connection.
			world.channel("200000000000000009", { guildId: "100000000000000009" });
			const other = await voice.join({
				guildId: "100000000000000009",
				channelId: "200000000000000009",
			});
			expect(other.ok).toBe(true);
		},
	},
	{
		name: "2. each refusal has its failure, leaves no session, and the guild can be joined after it",
		async run(subject) {
			const { voice, world } = subject;
			world.channel("21", { guildId: GUILD, kind: "text" });
			world.channel("22", { guildId: GUILD, forbidden: true });
			world.channel("23", { guildId: GUILD, full: true });
			world.channel("24", { guildId: "100000000000000002" });
			world.channel("25", { guildId: GUILD, kind: "stage" });
			await refused(subject, "20", "channel_gone");
			await refused(subject, "21", "not_voice");
			await refused(subject, "22", "forbidden");
			await refused(subject, "23", "full");
			await refused(subject, "24", "channel_gone");
			const stage = await voice.join({ guildId: GUILD, channelId: "25" });
			expect(stage.ok).toBe(true);
		},
	},
	{
		name: "3. a join while Discord is not connected is unavailable, and an option out of range throws",
		async run(subject) {
			const { voice, world } = subject;
			world.channel(ROOM, { guildId: GUILD });
			const at = { guildId: GUILD, channelId: ROOM };
			for (const options of [
				{ silenceMs: 199 },
				{ silenceMs: 5_001 },
				{ silenceMs: 800.5 },
				{ maxUtteranceMs: 999 },
				{ maxUtteranceMs: 300_001 },
			])
				await expect(voice.join(at, options)).rejects.toThrow(RangeError);
			world.offline();
			await refused(subject, ROOM, "unavailable");
		},
	},
	{
		name: "4. who enters and leaves the channel is reported and listed; other channels are not",
		async run(subject) {
			const { world } = subject;
			world.channel("200000000000000002", { guildId: GUILD });
			const session = await joined(subject);
			const lines = heard(session);
			world.enter(ROOM, BEN);
			world.enter("200000000000000002", DJ);
			expect(session.members()).toEqual([ANN, BEN]);
			world.enter("200000000000000002", ANN);
			world.exit(ROOM, BEN.userId);
			world.exit("200000000000000002", DJ.userId);
			expect(lines).toEqual(["joined Ben", "left Ann", "left Ben"]);
			expect(session.members()).toEqual([]);
		},
	},
	{
		name: "5. each speaker's audio is one utterance: speaking with the first frame, quiet and the audio when they stop",
		async run(subject) {
			const { world } = subject;
			const session = await joined(subject, [ANN, BEN]);
			const lines = heard(session);
			const said: { userId: string; bytes: number[]; span: number }[] = [];
			session.onUtterance((utterance) =>
				said.push({
					userId: utterance.userId,
					bytes: [...new Set(utterance.pcm)],
					span: utterance.endedAt - utterance.startedAt,
				}),
			);
			world.audio(ROOM, ANN.userId, frame(1));
			world.audio(ROOM, BEN.userId, frame(2));
			world.audio(ROOM, ANN.userId, frame(3));
			expect(lines).toEqual(["speaks 301", "speaks 302"]);
			world.quiet();
			// Ben spoke last before Ann did, so his silence is over first.
			expect(lines.slice(2)).toEqual([
				"quiet 302",
				"said 302 1920",
				"quiet 301",
				"said 301 3840",
			]);
			expect(said.map((one) => [one.userId, one.bytes])).toEqual([
				["302", [2]],
				["301", [1, 3]],
			]);
			expect(said[1]?.span).toBeGreaterThan(0);
			// What comes next is a new utterance.
			world.audio(ROOM, ANN.userId, frame(4));
			world.quiet();
			expect(lines.slice(6)).toEqual([
				"speaks 301",
				"quiet 301",
				"said 301 1920",
			]);
		},
	},
	{
		name: "6. an utterance is cut at maxUtteranceMs and goes on in the next",
		async run(subject) {
			const { world } = subject;
			const session = await joined(subject, [ANN], { maxUtteranceMs: 1_000 });
			const lines = heard(session);
			// 1.2 s of audio: 60 frames of 20 ms.
			for (let index = 0; index < 60; index++)
				world.audio(ROOM, ANN.userId, frame(index));
			world.quiet();
			expect(lines).toEqual([
				"speaks 301",
				"said 301 96000 continues",
				"quiet 301",
				"said 301 19200",
			]);
		},
	},
	{
		name: "7. what someone was saying is delivered when they leave the channel",
		async run(subject) {
			const { world } = subject;
			const session = await joined(subject);
			const lines = heard(session);
			world.audio(ROOM, ANN.userId, frame(1));
			world.exit(ROOM, ANN.userId);
			expect(lines).toEqual([
				"speaks 301",
				"quiet 301",
				"said 301 1920",
				"left Ann",
			]);
		},
	},
	{
		name: "8. leave ends the session once: open audio is delivered, the guild is free, and nothing is reported after",
		async run(subject) {
			const { voice, world } = subject;
			const session = await joined(subject);
			const lines = heard(session);
			world.audio(ROOM, ANN.userId, frame(1));
			await session.leave();
			await session.leave();
			expect(lines).toEqual([
				"speaks 301",
				"quiet 301",
				"said 301 1920",
				"ended left",
			]);
			expect(session.ended()).toBe("left");
			expect(session.members()).toEqual([]);
			expect(voice.session(GUILD)).toBeUndefined();
			world.enter(ROOM, BEN);
			world.audio(ROOM, BEN.userId, frame(2));
			world.quiet();
			expect(lines).toHaveLength(4);
			// A listener added after the end still learns of it.
			const late: string[] = [];
			session.onDisconnect(({ reason }) => late.push(reason));
			await Promise.resolve();
			expect(late).toEqual(["left"]);
			const again = await voice.join({ guildId: GUILD, channelId: ROOM });
			expect(again.ok && again.session !== session).toBe(true);
		},
	},
	...(["removed", "moved", "connection_lost"] as const).map(
		(how, index): Scenario => ({
			name: `${9 + index}. a session ended from outside (${how}) says why, delivers open audio, and frees the guild`,
			async run(subject) {
				const { voice, world } = subject;
				const session = await joined(subject);
				const lines = heard(session);
				world.audio(ROOM, ANN.userId, frame(1));
				world.drop(GUILD, how);
				expect(lines).toEqual([
					"speaks 301",
					"quiet 301",
					"said 301 1920",
					`ended ${how}`,
				]);
				expect(session.ended()).toBe(how);
				expect(voice.session(GUILD)).toBeUndefined();
				await session.leave();
				expect(lines).toHaveLength(4);
				const again = await voice.join({ guildId: GUILD, channelId: ROOM });
				expect(again.ok).toBe(true);
			},
		}),
	),
	{
		name: "12. a stopping host ends every session with stopped and joins nothing more",
		async run(subject) {
			const { world } = subject;
			const session = await joined(subject);
			const lines = heard(session);
			await world.stop();
			expect(lines).toEqual(["ended stopped"]);
			await refused(subject, ROOM, "unavailable");
		},
	},
	{
		name: "13. a listener that throws does not stop the next, and a removed listener hears nothing",
		async run(subject) {
			const { world } = subject;
			const session = await joined(subject);
			const lines: string[] = [];
			session.onMember(() => {
				throw new Error("boom");
			});
			const remove = session.onMember(() => lines.push("removed"));
			session.onMember(({ member }) => lines.push(member.displayName));
			remove();
			world.enter(ROOM, BEN);
			expect(lines).toEqual(["Ben"]);
		},
	},
	{
		name: "14. a listener that leaves when an utterance is cut is handed every frame once",
		async run(subject) {
			const { world } = subject;
			const session = await joined(subject, [ANN], { maxUtteranceMs: 1_000 });
			/** The first byte of each frame handed over, in order. */
			const fills: number[] = [];
			session.onUtterance(({ pcm, continues }) => {
				for (let at = 0; at < pcm.byteLength; at += 1_920)
					fills.push(pcm[at] ?? -1);
				if (continues) void session.leave();
			});
			for (let index = 0; index < 60; index++)
				world.audio(ROOM, ANN.userId, frame(index));
			expect(session.ended()).toBe("left");
			// Everything up to the cut, and nothing of it again as the session ends.
			expect(fills.length).toBeGreaterThanOrEqual(50);
			expect(fills).toEqual(fills.map((_, index) => index));
		},
	},
	{
		name: "15. an utterance that is full just as its speaker stops is their last, and one that is cut is followed by the rest",
		async run(subject) {
			const { world } = subject;
			const session = await joined(subject, [ANN], { maxUtteranceMs: 1_000 });
			const lines = heard(session);
			const spans: [number, number][] = [];
			session.onUtterance(({ startedAt, endedAt }) =>
				spans.push([startedAt, endedAt]),
			);
			// Exactly one second, 50 frames of 20 ms: nothing follows, so nothing says it continues.
			for (let index = 0; index < 50; index++)
				world.audio(ROOM, ANN.userId, frame(index));
			world.quiet();
			expect(lines).toEqual(["speaks 301", "quiet 301", "said 301 96000"]);
			// One frame more: the full second is handed over as that frame arrives, which starts the next.
			for (let index = 0; index < 51; index++)
				world.audio(ROOM, ANN.userId, frame(index));
			expect(lines.slice(3)).toEqual([
				"speaks 301",
				"said 301 96000 continues",
			]);
			world.quiet();
			expect(lines.slice(5)).toEqual(["quiet 301", "said 301 1920"]);
			const from = spans[1]?.[0] ?? 0;
			expect(
				spans.slice(1).map(([start, end]) => [start - from, end - from]),
			).toEqual([
				[0, 980],
				[1_000, 1_000],
			]);
		},
	},
];

/** Runs every scenario over a fresh subject; `make` builds the voice under test and its world. */
export function voiceContract(make: () => VoiceSubject): void {
	for (const scenario of scenarios)
		test(scenario.name, () => scenario.run(make()));
}
