import { afterEach, expect, test } from "bun:test";
import {
	getVoiceConnection,
	type VoiceConnection,
	type VoiceConnectionState,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import type { VoiceSession } from "./voice.ts";
import {
	type DiscordVoiceWorld,
	discordVoiceWorld,
} from "./voice-contract-discord.ts";
import { loadOpusDecoders, loadVoiceLib } from "./voice-link.ts";

// The voice link over @discordjs/voice itself, where the other voice tests drive a stand-in
// connection: the library's own `joinVoiceChannel`, state changes and `rejoin`, over an adapter the
// test answers for. The library keeps its connections by guild for the whole process, so each test
// has a guild of its own.

const ROOM = "200000000000000001";
const GROUP = "pi-roundtable";
const tick = () => new Promise((done) => setImmediate(done));

async function realWorld(guildId: string): Promise<DiscordVoiceWorld> {
	const subject = discordVoiceWorld({ lib: await loadVoiceLib() });
	subject.world.channel(ROOM, { guildId });
	return subject;
}

function connectionOf(guildId: string): VoiceConnection {
	const connection = getVoiceConnection(guildId, GROUP);
	if (!connection) throw new Error(`no voice connection in ${guildId}`);
	return connection;
}

/** The connection comes up, as when Discord answered the join and the voice socket is ready. */
function ready(connection: VoiceConnection): void {
	// SAFETY: the library reads a ready state's networking only when it has one.
	connection.state = {
		...connection.state,
		status: VoiceConnectionStatus.Ready,
	} as VoiceConnectionState;
}

/** The voice socket closes with a code other than 4014, which the library answers by asking the main gateway to join again. */
function socketCloses(connection: VoiceConnection): void {
	// SAFETY: the library's own handler of its networking's close, private in its types.
	(
		connection as unknown as { onNetworkingClose(code: number): void }
	).onNetworkingClose(1006);
}

test("a connection that drops while the main gateway carries nothing is asked for again once every 3 s, and the session ends after the resume time", async () => {
	const guildId = "100000000000000011";
	const subject = await realWorld(guildId);
	const joining = subject.voice.join({ guildId, channelId: ROOM });
	await tick();
	const connection = connectionOf(guildId);
	ready(connection);
	const answer = await joining;
	if (!answer.ok) throw new Error(`join failed: ${answer.failure}`);
	const reasons: string[] = [];
	answer.session.onDisconnect(({ reason }) => reasons.push(reason));

	// A gateway reconnect: the shard is not ready, so every payload is refused.
	subject.adapter.send = () => false;
	subject.adapter.sends = 0;
	socketCloses(connection);
	// The library's own request, then the link's one.
	expect(subject.adapter.sends).toBe(2);
	expect(connection.state.status).toBe(VoiceConnectionStatus.Disconnected);
	subject.clock.advance(2_999);
	expect(subject.adapter.sends).toBe(2);
	subject.clock.advance(1);
	expect(subject.adapter.sends).toBe(3);
	subject.clock.advance(3_000);
	expect(subject.adapter.sends).toBe(4);
	expect(reasons).toEqual([]);
	subject.clock.advance(14_000);
	expect(reasons).toEqual(["connection_lost"]);
	expect(connection.state.status).toBe(VoiceConnectionStatus.Destroyed);
	expect(getVoiceConnection(guildId, GROUP)).toBeUndefined();
	// One every 3 s for 20 s, and the leave.
	expect(subject.adapter.sends).toBe(9);
	subject.clock.advance(60_000);
	expect(subject.adapter.sends).toBe(9);
});

test("a dropped connection the main gateway carries again comes back, and is asked for no more", async () => {
	const guildId = "100000000000000012";
	const subject = await realWorld(guildId);
	const joining = subject.voice.join({ guildId, channelId: ROOM });
	await tick();
	const connection = connectionOf(guildId);
	ready(connection);
	const answer = await joining;
	if (!answer.ok) throw new Error(`join failed: ${answer.failure}`);
	const reasons: string[] = [];
	answer.session.onDisconnect(({ reason }) => reasons.push(reason));

	subject.adapter.send = () => false;
	socketCloses(connection);
	subject.adapter.send = () => true;
	subject.adapter.sends = 0;
	subject.clock.advance(3_000);
	expect(subject.adapter.sends).toBe(1);
	expect(connection.state.status).toBe(VoiceConnectionStatus.Signalling);
	ready(connection);
	subject.clock.advance(60_000);
	expect(subject.adapter.sends).toBe(1);
	expect(reasons).toEqual([]);
	await answer.session.leave();
	expect(getVoiceConnection(guildId, GROUP)).toBeUndefined();
});

test("a join the main gateway cannot carry is asked for again every 3 s, answers unavailable after the connect time, and leaves no connection behind", async () => {
	const guildId = "100000000000000013";
	const subject = await realWorld(guildId);
	subject.adapter.send = () => false;
	const joining = subject.voice.join({ guildId, channelId: ROOM });
	await tick();
	// The library's join, then the link's first rejoin.
	expect(subject.adapter.sends).toBe(2);
	expect(connectionOf(guildId).state.status).toBe(
		VoiceConnectionStatus.Disconnected,
	);
	subject.clock.advance(3_000);
	expect(subject.adapter.sends).toBe(3);
	subject.clock.advance(17_000);
	expect(await joining).toMatchObject({ ok: false, failure: "unavailable" });
	expect(getVoiceConnection(guildId, GROUP)).toBeUndefined();
	expect(
		subject.logs.lines.filter((line) => line.message === "voice join failed"),
	).toEqual([]);

	// The guild is joined again on a connection of its own.
	subject.adapter.send = () => true;
	const again = subject.voice.join({ guildId, channelId: ROOM });
	await tick();
	ready(connectionOf(guildId));
	const answer = await again;
	expect(answer.ok).toBe(true);
	if (answer.ok) await answer.session.leave();
	expect(getVoiceConnection(guildId, GROUP)).toBeUndefined();
});

test("a connection whose setup throws is destroyed, so the guild's next join is not handed it", async () => {
	const guildId = "100000000000000014";
	const subject = await realWorld(guildId);
	const failures = () =>
		subject.logs.lines.filter((line) => line.message === "voice join failed");
	// The main gateway refuses the join, then fails the link's rejoin.
	subject.adapter.send = () => {
		if (subject.adapter.sends === 2) throw new Error("no shard");
		return false;
	};
	expect(await subject.voice.join({ guildId, channelId: ROOM })).toMatchObject({
		ok: false,
		failure: "unavailable",
	});
	expect(getVoiceConnection(guildId, GROUP)).toBeUndefined();
	expect(failures()).toHaveLength(1);

	// It fails the join itself, inside the library, which had the connection already.
	subject.adapter.send = () => {
		throw new Error("no shard");
	};
	expect(await subject.voice.join({ guildId, channelId: ROOM })).toMatchObject({
		ok: false,
		failure: "unavailable",
	});
	expect(getVoiceConnection(guildId, GROUP)).toBeUndefined();
	expect(failures()).toHaveLength(2);
});

test("a later rejoin that throws is warned, not thrown, and asked for again", async () => {
	const guildId = "100000000000000015";
	const subject = await realWorld(guildId);
	subject.adapter.send = () => false;
	const joining = subject.voice.join({ guildId, channelId: ROOM });
	await tick();
	subject.adapter.send = () => {
		throw new Error("no shard");
	};
	expect(() => subject.clock.advance(3_000)).not.toThrow();
	expect(
		subject.logs.lines.filter((line) => line.message === "voice rejoin failed"),
	).toHaveLength(1);
	subject.adapter.send = () => true;
	subject.clock.advance(3_000);
	ready(connectionOf(guildId));
	const answer = await joining;
	expect(answer.ok).toBe(true);
	if (answer.ok) await answer.session.leave();
});

const GUILD = "100000000000000001";
const speaker = (index: number) => ({
	userId: String(1_000 + index),
	bot: false,
	displayName: `Speaker ${index}`,
});

/** Eight Opus packets of 20 ms each, as Discord sends them: a 400 Hz tone on both channels. */
async function tonePackets(): Promise<Uint8Array[]> {
	const { default: OpusScript } = await import("opusscript");
	const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
	const stereo = Buffer.alloc(960 * 4);
	for (let sample = 0; sample < 960; sample++) {
		const value = Math.round(
			Math.sin((sample / 960) * 2 * Math.PI * 8) * 8_000,
		);
		stereo.writeInt16LE(value, sample * 4);
		stereo.writeInt16LE(value, sample * 4 + 2);
	}
	const packets = Array.from({ length: 8 }, () => encoder.encode(stereo, 960));
	encoder.delete();
	return packets;
}

/** Whether an utterance is the eight packets decoded: all of their audio, ending in the tone at its level. */
function isTone(pcm: Uint8Array | undefined): boolean {
	if (pcm?.byteLength !== 8 * 1_920) return false;
	const peak = Math.max(...new Int16Array(pcm.buffer, 7 * 1_920, 960));
	return peak > 6_000 && peak < 10_000;
}

// Every decoder of the process shares one heap: a test that fails gives its decoders back all the same.
const sessions: VoiceSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.leave();
});

/** A session over the stand-in connection and the Opus decoder that ships, with what each speaker's last utterance held. */
async function hearing(count: number) {
	const subject = discordVoiceWorld({ decoders: await loadOpusDecoders() });
	const members = Array.from({ length: count }, (_, index) => speaker(index));
	subject.world.channel(ROOM, { guildId: GUILD, members });
	const answer = await subject.voice.join({ guildId: GUILD, channelId: ROOM });
	if (!answer.ok) throw new Error(`join failed: ${answer.failure}`);
	sessions.push(answer.session);
	const said = new Map<string, Uint8Array>();
	answer.session.onUtterance(({ userId, pcm }) => said.set(userId, pcm));
	const packets = await tonePackets();
	const speaks = (userId: string) => {
		for (const packet of packets) subject.world.audio(ROOM, userId, packet);
	};
	const undecoded = () =>
		subject.logs.lines
			.filter((line) => line.message === "voice packet not decoded")
			.map((line) => line.fields.userId);
	return { subject, session: answer.session, members, said, speaks, undecoded };
}

test("a speaker's decoder is freed when they leave the channel and after a minute of their silence, and made again when they speak", async () => {
	const subject = discordVoiceWorld();
	const [ann, ben] = [speaker(1), speaker(2)];
	subject.world.channel(ROOM, { guildId: GUILD, members: [ann, ben] });
	const answer = await subject.voice.join({ guildId: GUILD, channelId: ROOM });
	if (!answer.ok) throw new Error(`join failed: ${answer.failure}`);
	const said: string[] = [];
	answer.session.onUtterance(({ userId }) => said.push(userId));
	const frame = new Uint8Array(1_920).fill(1);
	subject.world.audio(ROOM, ann.userId, frame);
	subject.world.audio(ROOM, ben.userId, frame);
	expect(subject.decoders).toEqual({ made: 2, freed: 0 });
	subject.world.exit(ROOM, ann.userId);
	expect(subject.decoders).toEqual({ made: 2, freed: 1 });

	// Ben speaks again half a minute on: his minute starts over.
	subject.clock.advance(30_000);
	subject.world.audio(ROOM, ben.userId, frame);
	subject.clock.advance(59_979);
	expect(subject.decoders).toEqual({ made: 2, freed: 1 });
	subject.clock.advance(1);
	expect(subject.decoders).toEqual({ made: 2, freed: 2 });

	subject.world.audio(ROOM, ben.userId, frame);
	subject.world.quiet();
	expect(subject.decoders).toEqual({ made: 3, freed: 2 });
	expect(said).toEqual([ann.userId, ben.userId, ben.userId, ben.userId]);
	await answer.session.leave();
	expect(subject.decoders).toEqual({ made: 3, freed: 3 });
});

test("a hundred speakers who each leave after speaking are all heard: more than the decoder holds at once", async () => {
	const { subject, session, members, said, speaks, undecoded } =
		await hearing(100);
	for (const { userId } of members) {
		speaks(userId);
		subject.world.exit(ROOM, userId);
	}
	expect(members.filter(({ userId }) => !isTone(said.get(userId)))).toEqual([]);
	expect(undecoded()).toEqual([]);
	await session.leave();
});

test("a hundred speakers who stay, each speaking a second after the last, are all heard: a decoder is freed after a minute of silence", async () => {
	const { subject, session, members, said, speaks, undecoded } =
		await hearing(100);
	for (const { userId } of members) {
		speaks(userId);
		subject.clock.advance(1_000);
	}
	expect(members.filter(({ userId }) => !isTone(said.get(userId)))).toEqual([]);
	expect(undecoded()).toEqual([]);
	await session.leave();
});

test("speakers past what the decoder holds at once are named in the log, once each, and heard as soon as others leave", async () => {
	const { subject, session, members, said, speaks, undecoded } =
		await hearing(100);
	for (const { userId } of members) speaks(userId);
	subject.world.quiet();
	const heard = members.filter(({ userId }) => isTone(said.get(userId)));
	const unheard = members.filter(({ userId }) => !said.has(userId));
	expect(heard.length + unheard.length).toBe(100);
	expect(unheard.length).toBeGreaterThan(0);
	expect(undecoded()).toEqual(unheard.map(({ userId }) => userId));
	// Whoever was heard still is: nobody's audio is spoilt by the ones past the limit.
	said.clear();
	for (const { userId } of heard) speaks(userId);
	subject.world.quiet();
	expect(heard.filter(({ userId }) => !isTone(said.get(userId)))).toEqual([]);

	for (const { userId } of heard) subject.world.exit(ROOM, userId);
	for (const { userId } of unheard) speaks(userId);
	subject.world.quiet();
	expect(unheard.filter(({ userId }) => !isTone(said.get(userId)))).toEqual([]);
	// Named once each, whatever they lost.
	expect(undecoded()).toHaveLength(unheard.length);
	await session.leave();
	expect(
		subject.logs.lines.find(
			(line) => line.message === "voice packets were not decoded",
		)?.fields,
	).toMatchObject({ undecoded: unheard.length * 8, speakers: unheard.length });
});
