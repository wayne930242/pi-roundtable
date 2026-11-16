import { expect, test } from "bun:test";
import type { VoiceSession } from "./voice.ts";
import { manualVoiceClock } from "./voice-clock.ts";
import type { StubConnection } from "./voice-contract-connection.ts";
import {
	type DiscordVoiceWorld,
	discordVoiceWorld,
} from "./voice-contract-discord.ts";
import { hearingWatch } from "./voice-hearing.ts";

// What counts as proof that a link hears, and what a remedy's time is: the edges of the watch
// that voice-hearing.test.ts leaves out. A stand-in connection and a manual clock throughout.

const GUILD = "100000000000000001";
const ROOM = "200000000000000001";
const ANN = { userId: "301", bot: false, displayName: "Ann" };
const BEN = { userId: "302", bot: false, displayName: "Ben" };
const frame = (fill: number) => new Uint8Array(1_920).fill(fill);

async function joined(
	subject: DiscordVoiceWorld,
): Promise<{ session: VoiceSession; connection: StubConnection }> {
	subject.world.channel(ROOM, { guildId: GUILD, members: [ANN, BEN] });
	const answer = await subject.voice.join({ guildId: GUILD, channelId: ROOM });
	if (!answer.ok) throw new Error(`join failed: ${answer.failure}`);
	const connection = subject.connections[0];
	if (!connection) throw new Error("no connection");
	// Past the first seconds of a media path, in which a speaking state may be one Discord repeats.
	subject.clock.advance(3_000);
	return { session: answer.session, connection };
}

/** What the link asked of the connection: how often it set the networking up again, and how often it left to join again. */
const remedies = (connection: StubConnection) => [
	connection.configures,
	connection.leaves,
];

/** The watch alone, with what it asked for and logged. */
function watched() {
	const clock = manualVoiceClock(1_000_000);
	const asked: string[] = [];
	const lines: string[] = [];
	const log = (_fields: unknown, message?: string) => {
		if (message) lines.push(message);
	};
	const logger = { debug: log, info: log, warn: log, error: log, fatal: log };
	const watch = hearingWatch({
		clock,
		// SAFETY: the watch writes lines and makes no child logger.
		logger: logger as unknown as Parameters<typeof hearingWatch>[0]["logger"],
		fields: { guildId: GUILD, channelId: ROOM },
		person: () => true,
		deafened: () => false,
		rebuild: () => {
			asked.push("rebuild");
			return true;
		},
		rejoin: () => asked.push("rejoin"),
		giveUp: () => asked.push("giveUp"),
	});
	watch.up();
	clock.advance(3_000);
	return { clock, watch, asked, lines };
}

test("a speaker whose audio came just before the voice socket's word of them was heard: their silence after it is no reason for a remedy", async () => {
	const subject = discordVoiceWorld();
	const { connection } = await joined(subject);
	// The datagram outruns the speaking state, which the voice socket resends when it is lost.
	subject.world.audio(ROOM, ANN.userId, frame(1));
	subject.clock.advance(1_979);
	connection.speaking(ANN.userId);
	subject.clock.advance(3_600_000);
	expect(remedies(connection)).toEqual([0, 0]);

	// Audio as old as the 2 s a speaker is given is no proof of them.
	subject.world.audio(ROOM, ANN.userId, frame(2));
	subject.clock.advance(1_980);
	connection.speaking(ANN.userId);
	subject.clock.advance(2_000);
	expect(remedies(connection)).toEqual([1, 0]);
});

test("audio of a speaker the voice socket has not named is not hearing: it keeps no remedy from a resumed link, and ends none", () => {
	const { clock, watch, asked, lines } = watched();
	watch.audio(true);
	watch.down();
	// Audio under a name the link was never told, while the socket is away and after.
	watch.audio(false);
	watch.resumed();
	for (let index = 0; index < 250; index++) watch.audio(false);
	clock.advance(4_999);
	expect(asked).toEqual([]);
	clock.advance(1);
	expect(asked).toEqual(["rebuild"]);
	watch.down();
	watch.up();
	watch.audio(false);
	clock.advance(3_000);
	watch.speaking(ANN.userId);
	watch.audio(false);
	clock.advance(9_000);
	// The speaker was not heard: nothing was heard again, and the channel is left to be joined again.
	expect(asked).toEqual(["rebuild", "rejoin"]);
	expect(lines).not.toContain("voice hears again");
	watch.audio(true);
	expect(lines).toContain("voice hears again");
});

test("audio nobody is named for is a line in the log once for each media path and each resume", () => {
	const { watch, lines } = watched();
	const unnamed = () =>
		lines.filter(
			(line) =>
				line ===
				"voice audio arrives from a speaker the voice socket has not named",
		).length;
	for (let index = 0; index < 250; index++) watch.audio(false);
	expect(unnamed()).toBe(1);
	watch.down();
	watch.resumed();
	for (let index = 0; index < 99; index++) watch.audio(false);
	expect(unnamed()).toBe(1);
	watch.audio(false);
	expect(unnamed()).toBe(2);
});

test("a speaker named while the first remedy is waited on does not cut its 10 s short, and is given their own 2 s at its end", async () => {
	const subject = discordVoiceWorld();
	const { connection } = await joined(subject);
	connection.speaking(ANN.userId);
	subject.clock.advance(2_000);
	connection.ready();
	subject.clock.advance(3_000);
	connection.speaking(BEN.userId);
	subject.clock.advance(6_999);
	expect(remedies(connection)).toEqual([1, 0]);
	subject.clock.advance(1);
	expect(remedies(connection)).toEqual([1, 1]);

	// After a resume alone nobody was said to speak: one named 1 s before the 10 s are over has 1 s more.
	const quiet = discordVoiceWorld();
	const other = await joined(quiet);
	quiet.world.audio(ROOM, ANN.userId, frame(1));
	other.connection.resuming();
	other.connection.ready();
	quiet.clock.advance(5_000);
	other.connection.ready();
	quiet.clock.advance(9_000);
	other.connection.speaking(ANN.userId);
	quiet.clock.advance(1_999);
	expect(remedies(other.connection)).toEqual([1, 0]);
	quiet.clock.advance(1);
	expect(remedies(other.connection)).toEqual([1, 1]);

	// Heard within those 2 s, they are no reason to leave.
	const heard = discordVoiceWorld();
	const third = await joined(heard);
	heard.world.audio(ROOM, ANN.userId, frame(1));
	third.connection.resuming();
	third.connection.ready();
	heard.clock.advance(5_000);
	third.connection.ready();
	heard.clock.advance(9_000);
	third.connection.speaking(ANN.userId);
	heard.clock.advance(1_500);
	heard.world.audio(ROOM, ANN.userId, frame(2));
	heard.clock.advance(3_600_000);
	expect(remedies(third.connection)).toEqual([1, 0]);
});

test("someone who disconnects the bot while it is away to join again ends the session as removed, at once", async () => {
	const subject = discordVoiceWorld();
	const { session, connection } = await joined(subject);
	const reasons: string[] = [];
	session.onDisconnect(({ reason }) => reasons.push(reason));
	connection.speaking(ANN.userId);
	subject.clock.advance(2_000);
	connection.ready();
	subject.clock.advance(10_000);
	// The link's own leave was reported and ended nothing.
	expect(remedies(connection)).toEqual([1, 1]);
	expect(reasons).toEqual([]);
	subject.world.exit(ROOM, subject.world.botId);
	connection.disconnected(4014);
	expect(reasons).toEqual(["removed"]);
	expect(subject.voice.session(GUILD)).toBeUndefined();
});
