import { afterEach, expect, test } from "bun:test";
import {
	getVoiceConnection,
	type VoiceConnection,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import type { VoiceSession } from "./voice.ts";
import type { StubConnection } from "./voice-contract-connection.ts";
import {
	type DiscordVoiceWorld,
	discordVoiceWorld,
} from "./voice-contract-discord.ts";
import {
	type LocalVoiceServer,
	localVoiceServer,
} from "./voice-contract-gateway.ts";
import { loadVoiceLib } from "./voice-link.ts";

// A link that hears nothing while its connection says ready: after the library resumed a dropped
// voice socket, Discord's audio can stop arriving, and nothing in the connection's state shows it.
// The first half drives a stand-in connection through every step of the remedy; the second runs
// @discordjs/voice itself against a voice server on this machine.

const GUILD = "100000000000000001";
const ROOM = "200000000000000001";
const ANN = { userId: "301", bot: false, displayName: "Ann" };
const BEN = { userId: "302", bot: false, displayName: "Ben" };
const DJ = { userId: "303", bot: true, displayName: "DJ" };
const frame = (fill: number) => new Uint8Array(1_920).fill(fill);

const REBUILT = "voice hears nothing: its networking is set up again";
const REJOINED = "voice hears nothing: the channel is left and joined again";
const WAITING = "voice has heard nothing since its remedy";
const GAVE_UP = "voice audio not recovered";
const AGAIN = "voice hears again";
const HEARING = [REBUILT, REJOINED, WAITING, GAVE_UP, AGAIN];

/** The lines the hearing watch logged, in order. */
function logged(subject: DiscordVoiceWorld): string[] {
	return subject.logs.lines
		.map((line) => line.message)
		.filter((message) => HEARING.includes(message));
}

async function joined(
	subject: DiscordVoiceWorld,
	members = [ANN, BEN],
): Promise<{ session: VoiceSession; connection: StubConnection }> {
	subject.world.channel(ROOM, { guildId: GUILD, members });
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

test("someone the voice socket says is speaking, and no datagram for 2 s: the networking is set up again, and nothing more once they are heard", async () => {
	const subject = discordVoiceWorld();
	const { session, connection } = await joined(subject);
	const said: number[] = [];
	session.onUtterance(({ pcm }) => said.push(pcm.byteLength));
	connection.speaking(ANN.userId);
	subject.clock.advance(1_999);
	expect(remedies(connection)).toEqual([0, 0]);
	subject.clock.advance(1);
	expect(remedies(connection)).toEqual([1, 0]);
	expect(connection.state.status).toBe(VoiceConnectionStatus.Connecting);
	connection.ready();
	subject.world.audio(ROOM, ANN.userId, frame(1));
	subject.world.quiet();
	expect(said).toEqual([1_920]);
	subject.clock.advance(3_600_000);
	expect(remedies(connection)).toEqual([1, 0]);
	expect(session.ended()).toBeUndefined();
	expect(logged(subject)).toEqual([REBUILT, AGAIN]);
	expect(
		subject.logs.lines.find((line) => line.message === REBUILT),
	).toMatchObject({
		level: "warn",
		fields: { guildId: GUILD, channelId: ROOM, after: "speaking" },
	});
});

test("a speaker who is heard within the 2 s is no reason for a remedy", async () => {
	const subject = discordVoiceWorld();
	const { connection } = await joined(subject);
	connection.speaking(ANN.userId);
	subject.clock.advance(1_999);
	// Anyone's audio shows the media path is alive.
	connection.datagram();
	connection.speaking(BEN.userId);
	subject.clock.advance(1_000);
	subject.world.audio(ROOM, BEN.userId, frame(1));
	subject.clock.advance(3_600_000);
	expect(remedies(connection)).toEqual([0, 0]);
	expect(logged(subject)).toEqual([]);
});

test("silence is never taken for deafness: a quiet channel, a bot, a stranger, a state of not speaking, and a state in a media path's first 3 s start no remedy", async () => {
	const subject = discordVoiceWorld();
	subject.world.channel(ROOM, { guildId: GUILD, members: [ANN, DJ] });
	const answer = await subject.voice.join({ guildId: GUILD, channelId: ROOM });
	if (!answer.ok) throw new Error(`join failed: ${answer.failure}`);
	const connection = subject.connections[0];
	if (!connection) throw new Error("no connection");
	// Discord may repeat the speaking states it knows to a connection that just came up.
	connection.speaking(ANN.userId);
	subject.clock.advance(2_999);
	connection.speaking(ANN.userId);
	subject.clock.advance(3_600_000);
	connection.speaking(DJ.userId);
	connection.speaking("399");
	connection.speaking(ANN.userId, 0);
	// Sound shared with a video is no microphone.
	connection.speaking(ANN.userId, 2);
	subject.clock.advance(3_600_000);
	// The voice socket is resumed in a channel where nothing was heard.
	connection.resuming();
	connection.ready();
	subject.clock.advance(3_600_000);
	expect(remedies(connection)).toEqual([0, 0]);
	expect(answer.session.ended()).toBeUndefined();
	expect(logged(subject)).toEqual([]);
});

test("a bot a moderator deafened is sent no audio, which no remedy mends: a speaker it does not hear starts none until it is undeafened", async () => {
	const subject = discordVoiceWorld();
	const { session, connection } = await joined(subject);
	subject.world.audio(ROOM, ANN.userId, frame(1));
	subject.deafened = true;
	connection.speaking(ANN.userId);
	subject.clock.advance(1_000);
	// Undeafened before the 2 s are over: what Ann said until now was not sent all the same.
	subject.deafened = false;
	subject.clock.advance(30_000);
	subject.deafened = true;
	connection.resuming();
	connection.ready();
	subject.clock.advance(3_600_000);
	expect(remedies(connection)).toEqual([0, 0]);
	expect(session.ended()).toBeUndefined();
	expect(logged(subject)).toEqual([]);

	subject.deafened = false;
	connection.speaking(BEN.userId);
	subject.clock.advance(2_000);
	expect(remedies(connection)).toEqual([1, 0]);
});

test("a resumed voice socket after which nothing arrives for 5 s, in a channel heard within the two minutes before: the networking is set up again", async () => {
	const subject = discordVoiceWorld();
	const { session, connection } = await joined(subject);
	subject.world.audio(ROOM, ANN.userId, frame(1));
	// The frame's own 20 ms have passed: the socket drops two minutes to the millisecond after it.
	subject.clock.advance(119_980);
	connection.resuming();
	subject.clock.advance(1_000);
	connection.ready();
	subject.clock.advance(4_999);
	expect(remedies(connection)).toEqual([0, 0]);
	subject.clock.advance(1);
	expect(remedies(connection)).toEqual([1, 0]);
	expect(
		subject.logs.lines.find((line) => line.message === REBUILT)?.fields,
	).toMatchObject({ after: "resume" });
	connection.ready();
	// Nothing says anyone is speaking: the channel is not left for its silence.
	subject.clock.advance(3_600_000);
	expect(remedies(connection)).toEqual([1, 0]);
	expect(session.ended()).toBeUndefined();
	expect(logged(subject)).toEqual([REBUILT, WAITING]);
});

test("a resumed voice socket is no reason for a remedy when audio went on, when the channel was quiet for two minutes before, or when only a bot is there", async () => {
	const subject = discordVoiceWorld();
	const { connection } = await joined(subject);
	// Audio arrives while the socket is away: the media path never stopped.
	subject.world.audio(ROOM, ANN.userId, frame(1));
	connection.resuming();
	connection.datagram();
	connection.ready();
	subject.clock.advance(60_000);
	// Audio arrives within the 5 s after.
	subject.world.audio(ROOM, ANN.userId, frame(2));
	connection.resuming();
	connection.ready();
	subject.clock.advance(4_999);
	subject.world.audio(ROOM, ANN.userId, frame(3));
	// The frame's own 20 ms have passed.
	subject.clock.advance(119_981);
	// The last audio is a millisecond more than two minutes old.
	connection.resuming();
	connection.ready();
	subject.clock.advance(3_600_000);
	// Everyone but a bot left.
	subject.world.enter(ROOM, DJ);
	subject.world.audio(ROOM, DJ.userId, frame(4));
	subject.world.exit(ROOM, ANN.userId);
	subject.world.exit(ROOM, BEN.userId);
	connection.resuming();
	connection.ready();
	subject.clock.advance(3_600_000);
	expect(remedies(connection)).toEqual([0, 0]);
	expect(logged(subject)).toEqual([]);
});

test("a speaker still not heard 10 s after the networking was set up again: the bot leaves the channel and joins it again, and the session goes on with its members and listeners", async () => {
	const subject = discordVoiceWorld();
	const { session, connection } = await joined(subject);
	const lines: string[] = [];
	session.onMember(({ kind, member }) =>
		lines.push(`${kind} ${member.displayName}`),
	);
	session.onUtterance(({ userId }) => lines.push(`said ${userId}`));
	session.onDisconnect(({ reason }) => lines.push(`ended ${reason}`));
	connection.speaking(ANN.userId);
	subject.clock.advance(2_000);
	connection.ready();
	subject.clock.advance(9_999);
	expect(remedies(connection)).toEqual([1, 0]);
	subject.clock.advance(1);
	expect(remedies(connection)).toEqual([1, 1]);
	// It asked for the session's channel, which the connection had forgotten with the leaving.
	expect(connection.rejoins).toBe(1);
	expect(connection.joinConfig.channelId).toBe(ROOM);
	expect(connection.state.status).toBe(VoiceConnectionStatus.Signalling);
	// The bot's own leaving and entering ended nothing.
	expect(session.ended()).toBeUndefined();
	connection.ready();
	subject.world.audio(ROOM, ANN.userId, frame(1));
	subject.world.quiet();
	expect(lines).toEqual(["said 301"]);
	expect(session.members()).toEqual([ANN, BEN]);
	expect(subject.voice.session(GUILD)).toBe(session);
	expect(logged(subject)).toEqual([REBUILT, REJOINED, AGAIN]);

	// Heard again, the remedies start over: the next deafness is met with the networking first.
	subject.clock.advance(3_000);
	connection.speaking(BEN.userId);
	subject.clock.advance(2_000);
	expect(remedies(connection)).toEqual([2, 1]);
});

test("a voice socket resumed while a remedy is waited on starts its 10 s again", async () => {
	const subject = discordVoiceWorld();
	const { connection } = await joined(subject);
	connection.speaking(ANN.userId);
	subject.clock.advance(2_000);
	connection.ready();
	subject.clock.advance(5_000);
	connection.resuming();
	connection.ready();
	subject.clock.advance(9_999);
	expect(remedies(connection)).toEqual([1, 0]);
	subject.clock.advance(1);
	expect(remedies(connection)).toEqual([1, 1]);
});

test("after the rejoin silence ends nothing, and a speaker who is still not heard ends the session as lost", async () => {
	const subject = discordVoiceWorld();
	const { session, connection } = await joined(subject);
	const reasons: string[] = [];
	session.onDisconnect(({ reason }) => reasons.push(reason));
	connection.speaking(ANN.userId);
	subject.clock.advance(2_000);
	connection.ready();
	subject.clock.advance(10_000);
	connection.ready();
	subject.clock.advance(3_600_000);
	expect(remedies(connection)).toEqual([1, 1]);
	expect(reasons).toEqual([]);
	expect(logged(subject)).toEqual([REBUILT, REJOINED, WAITING]);

	connection.speaking(BEN.userId);
	subject.clock.advance(1_999);
	expect(reasons).toEqual([]);
	subject.clock.advance(1);
	expect(reasons).toEqual(["connection_lost"]);
	expect(connection.state.status).toBe(VoiceConnectionStatus.Destroyed);
	expect(subject.voice.session(GUILD)).toBeUndefined();
	expect(remedies(connection)).toEqual([1, 1]);
	expect(logged(subject)).toEqual([REBUILT, REJOINED, WAITING, GAVE_UP]);
});

test("after a resume alone the channel is left only once someone is said to speak and is not heard", async () => {
	const subject = discordVoiceWorld();
	const { session, connection } = await joined(subject);
	subject.world.audio(ROOM, ANN.userId, frame(1));
	connection.resuming();
	connection.ready();
	subject.clock.advance(5_000);
	expect(remedies(connection)).toEqual([1, 0]);
	connection.ready();
	subject.clock.advance(60_000);
	expect(remedies(connection)).toEqual([1, 0]);
	connection.speaking(ANN.userId);
	subject.clock.advance(2_000);
	expect(remedies(connection)).toEqual([1, 1]);
	expect(session.ended()).toBeUndefined();
});

test("a networking that cannot be set up again is passed over: the channel is left and joined again at once", async () => {
	const subject = discordVoiceWorld();
	const { session, connection } = await joined(subject);
	connection.configurable = false;
	connection.speaking(ANN.userId);
	subject.clock.advance(2_000);
	expect(remedies(connection)).toEqual([0, 1]);
	expect(session.ended()).toBeUndefined();
	expect(logged(subject)).toEqual([REJOINED]);

	// After a resume alone it is a line in the log, and the channel is not left.
	const quiet = discordVoiceWorld();
	const other = await joined(quiet);
	other.connection.configurable = false;
	quiet.world.audio(ROOM, ANN.userId, frame(1));
	other.connection.resuming();
	other.connection.ready();
	quiet.clock.advance(3_600_000);
	expect(remedies(other.connection)).toEqual([0, 0]);
	expect(
		quiet.logs.lines.filter(
			(line) =>
				line.message ===
				"voice hears nothing, and its networking could not be set up again",
		),
	).toMatchObject([{ level: "warn", fields: { after: "resume" } }]);
});

test("a remedy that does not come up within the resume time ends the session as lost, and no remedy outlives the session", async () => {
	const subject = discordVoiceWorld();
	const { session, connection } = await joined(subject);
	const reasons: string[] = [];
	session.onDisconnect(({ reason }) => reasons.push(reason));
	connection.speaking(ANN.userId);
	subject.clock.advance(2_000);
	subject.clock.advance(19_999);
	expect(reasons).toEqual([]);
	subject.clock.advance(1);
	expect(reasons).toEqual(["connection_lost"]);
	subject.clock.advance(3_600_000);
	expect(remedies(connection)).toEqual([1, 0]);

	// A session that was left has no watch either.
	const again = discordVoiceWorld();
	const other = await joined(again);
	other.connection.speaking(ANN.userId);
	await other.session.leave();
	again.clock.advance(3_600_000);
	expect(remedies(other.connection)).toEqual([0, 0]);
});

// --- @discordjs/voice itself, against a voice server on this machine ---

const GROUP = "pi-roundtable";
const servers: LocalVoiceServer[] = [];
const sessions: VoiceSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.leave();
	for (const server of servers.splice(0)) await server.close();
});

/** Waits for what the library does over its sockets, which no test clock moves. */
async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
		await new Promise((done) => setTimeout(done, 2));
	}
}

/** A session over the library's own connection to a voice server on this machine, with what it heard. */
async function overLibrary(guildId: string) {
	const server = await localVoiceServer();
	servers.push(server);
	/** How many packets reached a decoder. */
	const heard = { packets: 0 };
	const subject = discordVoiceWorld({
		lib: await loadVoiceLib(),
		decode: (packet) => {
			heard.packets++;
			return Uint8Array.from(packet);
		},
	});
	subject.world.channel(ROOM, { guildId, members: [ANN, BEN] });
	const me = { userId: subject.world.botId, bot: true, displayName: "bot" };
	/** What the bot asked of the main gateway: the channel of each join, null for a leave. */
	const asked: (string | null)[] = [];
	// The main gateway answers a join with the bot's voice state and its voice server, and reports a leave.
	subject.adapter.carried = (payload, methods) => {
		const channelId = payload.d.channel_id;
		asked.push(channelId);
		queueMicrotask(() => {
			if (channelId === null) return subject.world.exit(ROOM, me.userId);
			subject.world.enter(channelId, me);
			// SAFETY: the library reads these fields of the two dispatches and no other.
			methods.onVoiceStateUpdate({
				session_id: "session",
				user_id: me.userId,
				channel_id: channelId,
				guild_id: guildId,
			} as Parameters<typeof methods.onVoiceStateUpdate>[0]);
			methods.onVoiceServerUpdate({
				token: "token",
				guild_id: guildId,
				endpoint: server.endpoint,
			});
		});
	};
	const answer = await subject.voice.join({ guildId, channelId: ROOM });
	if (!answer.ok) throw new Error(`join failed: ${answer.failure}`);
	sessions.push(answer.session);
	const connection = getVoiceConnection(guildId, GROUP);
	if (!connection) throw new Error(`no voice connection in ${guildId}`);
	const statuses: string[] = [];
	connection.on("stateChange", (_before, state) => statuses.push(state.status));
	/** What each utterance held: the first byte of each of its packets. */
	const said: number[][] = [];
	answer.session.onUtterance(({ pcm }) => said.push([...new Set(pcm)]));
	const ready = () => connection.state.status === VoiceConnectionStatus.Ready;
	/** Someone speaks one packet, which is waited for only when it should arrive. */
	const speaks = async (userId: string, fill: number, arrives = true) => {
		const before = heard.packets;
		server.audio(userId, new Uint8Array(160).fill(fill));
		if (arrives)
			await until(() => heard.packets > before, `packet ${fill} is heard`);
	};
	/** The voice socket names a speaker, and the library has read it. */
	const named = async (userId: string) => {
		server.speaking(userId);
		await until(
			() => connection.receiver.ssrcMap.get(userId) !== undefined,
			`${userId} is named`,
		);
	};
	return {
		subject,
		server,
		session: answer.session,
		connection,
		statuses,
		said,
		asked,
		ready,
		speaks,
		named,
	};
}

/** The media socket of the connection's networking, which a resume keeps and a new networking replaces. */
function mediaSocketOf(connection: VoiceConnection): unknown {
	const networking: unknown = Reflect.get(connection.state, "networking");
	const state: unknown =
		networking && typeof networking === "object"
			? Reflect.get(networking, "state")
			: undefined;
	return state && typeof state === "object"
		? Reflect.get(state, "udp")
		: undefined;
}

test("the library: after a resumed voice socket no audio arrives, the networking is set up again within 5 s, and the speaker is heard on", async () => {
	const { subject, server, session, connection, statuses, said, ...at } =
		await overLibrary("100000000000000021");
	await at.named(ANN.userId);
	await at.speaks(ANN.userId, 1);
	subject.clock.advance(1_000);
	expect(said).toEqual([[1]]);
	const media = mediaSocketOf(connection);

	// The host's network blips: the voice socket drops, and Discord's audio goes where the bot no longer listens.
	statuses.length = 0;
	server.media = "stale";
	server.drop();
	await until(() => server.counts.resumes === 1 && at.ready(), "the resume");
	// A resume: ready, connecting, ready over the media socket it had, which says nothing of the audio.
	expect(statuses).toEqual(["connecting", "ready"]);
	expect(mediaSocketOf(connection)).toBe(media);
	await at.speaks(ANN.userId, 2, false);
	subject.clock.advance(4_999);
	expect(server.counts.identifies).toBe(1);

	subject.clock.advance(1);
	await until(
		() => server.counts.identifies === 2 && at.ready(),
		"the networking is set up again",
	);
	expect(mediaSocketOf(connection)).not.toBe(media);
	// The receiver kept who she is: no new word from the voice socket is needed.
	await at.speaks(ANN.userId, 3);
	subject.clock.advance(1_000);
	expect(said).toEqual([[1], [3]]);
	expect(session.ended()).toBeUndefined();
	expect(session.members()).toEqual([ANN, BEN]);
	expect(at.asked).toEqual([ROOM]);
	expect(logged(subject)).toEqual([REBUILT, AGAIN]);
}, 20_000);

test("the library: a speaker not heard after the networking was set up again has the bot leave and join the channel, and the session hears on", async () => {
	const { subject, server, session, said, ...at } =
		await overLibrary("100000000000000022");
	await at.named(ANN.userId);
	await at.speaks(ANN.userId, 1);
	subject.clock.advance(3_000);
	expect(said).toEqual([[1]]);

	// Nothing arrives any more, whatever the bot sets up; the voice socket goes on naming who speaks.
	server.media = "dead";
	await at.named(BEN.userId);
	await at.speaks(BEN.userId, 2, false);
	subject.clock.advance(2_000);
	await until(
		() => server.counts.identifies === 2 && at.ready(),
		"the networking is set up again",
	);
	expect(at.asked).toEqual([ROOM]);
	subject.clock.advance(10_000);
	await until(
		() => server.counts.identifies === 3 && at.ready(),
		"the channel is joined again",
	);
	// One leave, one join of the same channel, and the bot's own leaving ended nothing.
	expect(at.asked).toEqual([ROOM, null, ROOM]);
	expect(session.ended()).toBeUndefined();
	expect(session.members()).toEqual([ANN, BEN]);

	server.media = "live";
	await at.speaks(BEN.userId, 3);
	subject.clock.advance(1_000);
	expect(said).toEqual([[1], [3]]);
	expect(logged(subject)).toEqual([REBUILT, REJOINED, AGAIN]);
}, 20_000);

test("the library: a voice socket resumed in a quiet channel, or while its audio goes on, starts no remedy", async () => {
	const { subject, server, session, said, ...at } =
		await overLibrary("100000000000000023");
	server.drop();
	await until(() => server.counts.resumes === 1 && at.ready(), "the resume");
	subject.clock.advance(3_600_000);

	await at.named(ANN.userId);
	await at.speaks(ANN.userId, 1);
	server.drop();
	await until(() => server.counts.resumes === 2 && at.ready(), "the resume");
	await at.speaks(ANN.userId, 2);
	subject.clock.advance(3_600_000);
	expect(said).toEqual([[1, 2]]);
	expect(server.counts.identifies).toBe(1);
	expect(at.asked).toEqual([ROOM]);
	expect(session.ended()).toBeUndefined();
	expect(logged(subject)).toEqual([]);
}, 20_000);

test("the library: audio of a speaker the voice socket never named is a line in the log, once, and no reason for a remedy", async () => {
	const guildId = "100000000000000024";
	const { subject, server, ...at } = await overLibrary(guildId);
	const unnamed = () =>
		subject.logs.lines.filter(
			(line) =>
				line.message ===
				"voice audio arrives from a speaker the voice socket has not named",
		);
	for (let index = 0; index < 250; index++)
		await at.speaks("399", index % 250, false);
	// Datagrams arrive in the order they were sent: once Ann is heard, the stranger's all came.
	await at.named(ANN.userId);
	await at.speaks(ANN.userId, 1);
	expect(unnamed()).toMatchObject([
		{ level: "warn", fields: { guildId, channelId: ROOM, datagrams: 100 } },
	]);
	subject.clock.advance(3_600_000);
	expect(server.counts.identifies).toBe(1);
	expect(logged(subject)).toEqual([]);
}, 20_000);
