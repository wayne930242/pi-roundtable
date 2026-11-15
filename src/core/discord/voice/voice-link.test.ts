import { expect, test } from "bun:test";
import {
	getVoiceConnection,
	type VoiceConnection,
	type VoiceConnectionState,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import {
	type DiscordVoiceWorld,
	discordVoiceWorld,
} from "./voice-contract-discord.ts";
import { loadVoiceLib } from "./voice-link.ts";

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
