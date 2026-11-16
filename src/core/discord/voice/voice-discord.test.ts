import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { VoiceConnectionStatus } from "@discordjs/voice";
import { Events, GatewayIntentBits } from "discord.js";
import type { VoiceSession } from "./voice.ts";
import {
	type DiscordVoiceWorld,
	discordVoiceWorld,
} from "./voice-contract-discord.ts";
import { voiceIntents } from "./voice-discord.ts";
import { loadOpusDecoders, loadVoiceLib } from "./voice-link.ts";

const GUILD = "100000000000000001";
const ROOM = "200000000000000001";
const ANN = { userId: "301", bot: false, displayName: "Ann" };
const BEN = { userId: "302", bot: false, displayName: "Ben" };
const CAL = { userId: "303", bot: false, displayName: "Cal" };
const AT = { guildId: GUILD, channelId: ROOM };
const frame = (fill: number) => new Uint8Array(1_920).fill(fill);
const tick = () => new Promise((done) => setImmediate(done));

async function joined(subject: DiscordVoiceWorld): Promise<VoiceSession> {
	subject.world.channel(ROOM, { guildId: GUILD, members: [ANN, BEN] });
	const answer = await subject.voice.join(AT);
	if (!answer.ok) throw new Error(`join failed: ${answer.failure}`);
	return answer.session;
}

function ends(session: VoiceSession): string[] {
	const reasons: string[] = [];
	session.onDisconnect(({ reason }) => reasons.push(reason));
	return reasons;
}

/** Whether a logged value holds bytes anywhere in it. */
function holdsBytes(value: unknown): boolean {
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).some(holdsBytes);
}

test("the Guild Voice States intent comes only with voice", () => {
	expect(voiceIntents(undefined)).toEqual([]);
	expect(voiceIntents(false)).toEqual([]);
	expect(voiceIntents(true)).toEqual([GatewayIntentBits.GuildVoiceStates]);
});

test("the voice library is loaded once, by the first start or join, and the bot joins muted and not deafened", async () => {
	const subject = discordVoiceWorld();
	expect(subject.loads).toEqual({ lib: 0, decoders: 0 });
	await subject.voice.start();
	await joined(subject);
	expect(subject.loads).toEqual({ lib: 1, decoders: 1 });
	expect(subject.connections).toHaveLength(1);
	expect(subject.connections[0]?.joinConfig).toMatchObject({
		...AT,
		selfMute: true,
		selfDeaf: false,
		group: "pi-roundtable",
	});
});

test("a refused join opens no connection", async () => {
	const subject = discordVoiceWorld();
	subject.world.channel("21", { guildId: GUILD, kind: "text" });
	subject.world.channel("22", { guildId: GUILD, forbidden: true });
	subject.world.channel("23", { guildId: GUILD, full: true });
	for (const channelId of ["20", "21", "22", "23"])
		expect((await subject.voice.join({ guildId: GUILD, channelId })).ok).toBe(
			false,
		);
	expect(subject.connections).toEqual([]);
});

test("a connection that comes up late is joined; one that takes longer than the connect time is unavailable and closed", async () => {
	const subject = discordVoiceWorld({ connect: false });
	subject.world.channel(ROOM, { guildId: GUILD });
	const late = subject.voice.join(AT);
	await tick();
	// Held while it connects: a second join of the guild is refused, and nobody sees the session yet.
	expect(await subject.voice.join(AT)).toMatchObject({
		failure: "already_joined",
	});
	expect(subject.voice.session(GUILD)).toBeUndefined();
	subject.clock.advance(19_999);
	subject.connections[0]?.ready();
	const first = await late;
	expect(first.ok).toBe(true);
	if (first.ok) await first.session.leave();

	const never = subject.voice.join(AT);
	await tick();
	subject.clock.advance(20_000);
	expect(await never).toMatchObject({ ok: false, failure: "unavailable" });
	expect(subject.connections[1]?.state.status).toBe(
		VoiceConnectionStatus.Destroyed,
	);
	expect(subject.voice.session(GUILD)).toBeUndefined();
});

test("who enters or leaves while the connection comes up is in the session the join answers", async () => {
	const subject = discordVoiceWorld({ connect: false });
	subject.world.channel(ROOM, { guildId: GUILD, members: [ANN] });
	const joining = subject.voice.join(AT);
	await tick();
	subject.world.enter(ROOM, BEN);
	subject.world.exit(ROOM, ANN.userId);
	subject.connections[0]?.ready();
	const answer = await joining;
	expect(answer.ok && answer.session.members()).toEqual([BEN]);
});

test("a host that stops while a join is connecting answers unavailable and closes the connection", async () => {
	const subject = discordVoiceWorld({ connect: false });
	subject.world.channel(ROOM, { guildId: GUILD });
	const joining = subject.voice.join(AT);
	await tick();
	await subject.voice.stop();
	subject.connections[0]?.ready();
	expect(await joining).toMatchObject({ ok: false, failure: "unavailable" });
	expect(subject.connections[0]?.state.status).toBe(
		VoiceConnectionStatus.Destroyed,
	);
});

test("a drop that comes back within the resume time ends nothing, and audio is heard again", async () => {
	const subject = discordVoiceWorld();
	const session = await joined(subject);
	const reasons = ends(session);
	const said: number[] = [];
	session.onUtterance(({ pcm }) => said.push(pcm.byteLength));
	const connection = subject.connections[0];
	if (!connection) throw new Error("no connection");
	connection.disconnected();
	expect(connection.rejoins).toBe(1);
	subject.clock.advance(19_999);
	connection.ready();
	subject.clock.advance(60_000);
	expect(reasons).toEqual([]);
	subject.world.audio(ROOM, ANN.userId, frame(1));
	subject.world.quiet();
	expect(said).toEqual([1_920]);
});

test("when a drop comes back, who is in the channel is read again, and whoever left or entered meanwhile is reported", async () => {
	const subject = discordVoiceWorld();
	const session = await joined(subject);
	const lines: string[] = [];
	session.onMember(({ kind, member }) =>
		lines.push(`${kind} ${member.displayName}`),
	);
	session.onUtterance(({ userId }) => lines.push(`said ${userId}`));
	const connection = subject.connections[0];
	if (!connection) throw new Error("no connection");
	// While the connection is up, the gateway's word is all the session goes by.
	subject.resync(ROOM, [BEN]);
	await tick();
	expect(session.members()).toEqual([ANN, BEN]);

	subject.world.audio(ROOM, ANN.userId, frame(1));
	connection.disconnected();
	subject.resync(ROOM, [BEN, CAL]);
	connection.ready();
	await tick();
	// What Ann was saying comes first, and her decoder is freed.
	expect(lines).toEqual(["said 301", "left Ann", "joined Cal"]);
	expect(session.members()).toEqual([BEN, CAL]);
	expect(subject.decoders).toEqual({ made: 1, freed: 1 });
	expect(session.ended()).toBeUndefined();
});

test("when the gateway is ready again or resumed, who is in the channel is read again, though the voice connection never dropped", async () => {
	const subject = discordVoiceWorld();
	const session = await joined(subject);
	const lines: string[] = [];
	session.onMember(({ kind, member }) =>
		lines.push(`${kind} ${member.displayName}`),
	);
	// The gateway identified again: the guild's voice states are sent anew, with no word of what changed.
	subject.resync(ROOM, [BEN, CAL]);
	subject.client.emit(Events.ShardReady, 0, undefined);
	await tick();
	expect(lines).toEqual(["left Ann", "joined Cal"]);
	subject.resync(ROOM, [CAL]);
	subject.client.emit(Events.ShardResume, 0, 0);
	await tick();
	expect(lines).toEqual(["left Ann", "joined Cal", "left Ben"]);
	expect(session.members()).toEqual([CAL]);
	expect(session.ended()).toBeUndefined();
	// A session that ended is read no more.
	await session.leave();
	subject.resync(ROOM, [ANN]);
	subject.client.emit(Events.ShardReady, 0, undefined);
	await tick();
	expect(lines).toEqual(["left Ann", "joined Cal", "left Ben"]);
});

test("a channel that cannot be read again after a drop is logged, and the session goes on with who it knew", async () => {
	const subject = discordVoiceWorld();
	const session = await joined(subject);
	const reasons = ends(session);
	const connection = subject.connections[0];
	if (!connection) throw new Error("no connection");
	connection.disconnected();
	subject.client.channels.fetch = async () => {
		throw new Error("Discord cannot be reached");
	};
	connection.ready();
	await tick();
	expect(
		subject.logs.lines.filter(
			(line) => line.message === "voice members not read again",
		),
	).toMatchObject([{ level: "warn", fields: { guildId: GUILD } }]);
	expect(session.members()).toEqual([ANN, BEN]);
	expect(reasons).toEqual([]);
});

test("Discord's own disconnect (4014) is not rejoined, and without word of where the bot is the session ends after the resume time", async () => {
	const subject = discordVoiceWorld();
	const session = await joined(subject);
	const reasons = ends(session);
	const connection = subject.connections[0];
	if (!connection) throw new Error("no connection");
	connection.disconnected(4014);
	subject.clock.advance(19_999);
	expect(connection.rejoins).toBe(0);
	expect(reasons).toEqual([]);
	subject.clock.advance(1);
	expect(reasons).toEqual(["connection_lost"]);
	expect(connection.state.status).toBe(VoiceConnectionStatus.Destroyed);
});

test("a connection the main gateway cannot carry is asked for again every 3 s until it is", async () => {
	const subject = discordVoiceWorld();
	const session = await joined(subject);
	const reasons = ends(session);
	const connection = subject.connections[0];
	if (!connection) throw new Error("no connection");
	connection.carries = false;
	connection.disconnected();
	expect(connection.rejoins).toBe(1);
	subject.clock.advance(3_000);
	expect(connection.rejoins).toBe(2);
	connection.carries = true;
	subject.clock.advance(3_000);
	expect(connection.rejoins).toBe(3);
	connection.ready();
	subject.clock.advance(60_000);
	expect(connection.rejoins).toBe(3);
	expect(reasons).toEqual([]);
});

test("the resume time is never longer than 30 s", async () => {
	const subject = discordVoiceWorld({ resumeMs: 120_000 });
	const session = await joined(subject);
	const reasons = ends(session);
	subject.connections[0]?.disconnected(4014);
	subject.clock.advance(29_999);
	expect(reasons).toEqual([]);
	subject.clock.advance(1);
	expect(reasons).toEqual(["connection_lost"]);
});

test("a connection destroyed underneath ends the session as lost", async () => {
	const subject = discordVoiceWorld();
	const session = await joined(subject);
	const reasons = ends(session);
	subject.connections[0]?.destroy();
	expect(reasons).toEqual(["connection_lost"]);
	expect(subject.voice.session(GUILD)).toBeUndefined();
});

test("leaving destroys the connection, ends every stream, and frees each speaker's decoder", async () => {
	const subject = discordVoiceWorld();
	const session = await joined(subject);
	const reasons = ends(session);
	subject.world.audio(ROOM, ANN.userId, frame(1));
	subject.world.audio(ROOM, BEN.userId, frame(2));
	subject.world.audio(ROOM, ANN.userId, frame(3));
	const connection = subject.connections[0];
	if (!connection) throw new Error("no connection");
	expect(connection.receiver.subscriptions.size).toBe(2);
	expect(subject.decoders).toEqual({ made: 2, freed: 0 });
	await session.leave();
	expect(connection.state.status).toBe(VoiceConnectionStatus.Destroyed);
	expect(connection.receiver.subscriptions.size).toBe(0);
	expect(subject.decoders).toEqual({ made: 2, freed: 2 });
	// The bot's own leaving, which the gateway reports after, ends nothing twice.
	expect(reasons).toEqual(["left"]);
	// A packet still on its way is not heard.
	connection.packet(ANN.userId, frame(4));
	expect(connection.receiver.subscriptions.size).toBe(0);
});

test("a stream the library destroys on a packet it cannot decrypt is replaced, and the speaker is heard on", async () => {
	const subject = discordVoiceWorld({ realStreams: true });
	const session = await joined(subject);
	const said: number[][] = [];
	session.onUtterance(({ pcm }) => said.push([...new Set(pcm)]));
	const connection = subject.connections[0];
	if (!connection) throw new Error("no connection");
	connection.packet(ANN.userId, frame(1));
	await tick();
	const first = connection.receiver.subscriptions.get(ANN.userId);
	first?.destroy(new Error("Failed to parse packet"));
	await tick();
	const second = connection.receiver.subscriptions.get(ANN.userId);
	expect(second && second !== first).toBe(true);
	connection.packet(ANN.userId, frame(2));
	await tick();
	subject.world.quiet();
	expect(said).toEqual([[1, 2]]);
	// The same decoder goes on: Opus keeps state between packets.
	expect(subject.decoders.made).toBe(1);
	expect(
		subject.logs.lines.filter((line) => line.message === "voice stream failed"),
	).toMatchObject([
		{ level: "debug", fields: { reason: "Failed to parse packet" } },
	]);
});

test("a packet still held by its stream when the session ends is not decoded, so no decoder is left behind", async () => {
	const subject = discordVoiceWorld({ realStreams: true });
	const session = await joined(subject);
	const said: number[] = [];
	session.onUtterance(({ pcm }) => said.push(pcm.byteLength));
	// The library's stream hands its first packets on a tick later.
	subject.connections[0]?.packet(ANN.userId, frame(1));
	await session.leave();
	await tick();
	expect(subject.decoders).toEqual({ made: 0, freed: 0 });
	expect(said).toEqual([]);
});

test("a packet that is no Opus is dropped, and no log line ever holds audio", async () => {
	const subject = discordVoiceWorld({
		decode: (packet) => {
			if (packet[0] === 9) throw new Error("Decode error: Invalid packet");
			return Uint8Array.from(packet);
		},
	});
	const session = await joined(subject);
	const said: number[] = [];
	session.onUtterance(({ pcm }) => said.push(pcm.byteLength));
	session.onUtterance(() => {
		throw new Error("listener failed");
	});
	subject.world.audio(ROOM, ANN.userId, frame(9));
	subject.world.audio(ROOM, ANN.userId, frame(1));
	subject.world.audio(ROOM, ANN.userId, frame(9));
	subject.world.quiet();
	subject.connections[0]?.emit("error", new Error("socket closed"));
	await session.leave();
	expect(said).toEqual([1_920]);
	const messages = subject.logs.lines.map((line) => line.message);
	expect(
		messages.filter((message) => message === "voice packet not decoded"),
	).toHaveLength(1);
	expect(messages).toContain("voice utterance listener failed");
	expect(messages).toContain("voice connection error");
	expect(
		subject.logs.lines.find(
			(line) => line.message === "voice packets were not decoded",
		)?.fields,
	).toMatchObject({ undecoded: 2 });
	expect(subject.logs.lines.filter((line) => holdsBytes(line.fields))).toEqual(
		[],
	);
});

test("the Opus decoder that ships decodes Discord's stereo packets to 48 kHz mono", async () => {
	const { default: OpusScript } = await import("opusscript");
	const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
	// 20 ms of a 400 Hz tone on both channels.
	const stereo = Buffer.alloc(960 * 4);
	for (let sample = 0; sample < 960; sample++) {
		const value = Math.round(
			Math.sin((sample / 960) * 2 * Math.PI * 8) * 8_000,
		);
		stereo.writeInt16LE(value, sample * 4);
		stereo.writeInt16LE(value, sample * 4 + 2);
	}
	const decoder = (await loadOpusDecoders())();
	let pcm: Uint8Array = new Uint8Array();
	// The codec needs a few frames to settle.
	for (let index = 0; index < 5; index++)
		pcm = decoder.decode(encoder.encode(stereo, 960));
	encoder.delete();
	decoder.free();
	expect(pcm.byteLength).toBe(1_920);
	const samples = new Int16Array(pcm.buffer, pcm.byteOffset, 960);
	const peak = Math.max(...samples);
	expect(peak).toBeGreaterThan(6_000);
	expect(peak).toBeLessThan(10_000);
});

test("the voice library loads with what Discord's encryption needs: DAVE, an Opus decoder, and both transport ciphers", async () => {
	const lib = await loadVoiceLib();
	expect(typeof lib.joinVoiceChannel).toBe("function");
	const { generateDependencyReport } = await import("@discordjs/voice");
	// The cipher library is looked for as the module loads; give it a moment.
	await new Promise((done) => setTimeout(done, 50));
	const report = generateDependencyReport();
	expect(report).toMatch(/@snazzah\/davey: \d/);
	expect(report).toMatch(/opusscript: \d/);
	expect(report).toMatch(/aes-256-gcm: yes/);
	expect(report).toMatch(/@noble\/ciphers: \d/);
});

test("a host without discord.voice loads no voice package, and one with it loads none before its services start", () => {
	const root = resolve(import.meta.dir, "../../../..");
	const script = `
		const { discordPlugin, DISCORD } = await import("./src/core/builtin/discord.ts");
		const { DiscordSurface } = await import("./src/core/discord/discord-surface.ts");
		const { silentLogger } = await import("./src/core/kernel/log.ts");
		for (const voice of [false, true]) {
			discordPlugin({ token: "t", ownerId: "1", ownerName: "o", dataDir: "/tmp", rootCommand: "r", voice });
			new DiscordSurface({ token: "t", ownerId: "1", ownerName: "o", prompts: () => undefined, logger: silentLogger(), voice });
		}
		const loaded = Object.keys(require.cache).filter((path) => /@discordjs\\/voice|opusscript|@snazzah\\/davey|@noble\\/ciphers|prism-media/.test(path));
		console.log(JSON.stringify({ discord: typeof DISCORD, loaded }));
	`;
	const run = Bun.spawnSync(["bun", "-e", script], { cwd: root });
	expect(run.stderr.toString()).toBe("");
	expect(JSON.parse(run.stdout.toString())).toEqual({
		discord: "object",
		loaded: [],
	});
});
