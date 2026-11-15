import { expect, test } from "bun:test";
import { DISCORD, type VoiceUtterance } from "./discord/index.ts";
import { definePlugin } from "./index.ts";
import { fakeDiscord, fakeDiscordVoice, testPlugin } from "./testing.ts";

const GUILD = "100000000000000001";
const ROOM = "200000000000000001";
const ANN = { userId: "301", bot: false, displayName: "Ann" };
const frame = (fill: number) => new Uint8Array(1_920).fill(fill);

/** A plugin that joins a room as it starts and keeps what it hears. */
function recorder(heard: VoiceUtterance[], failures: string[]) {
	return definePlugin({
		name: "recorder",
		setup: ({ services }) => ({
			services: [
				{
					name: "recorder",
					start: async () => {
						const voice = services.get(DISCORD).voice;
						if (!voice) return void failures.push("voice is off");
						const answer = await voice.join({
							guildId: GUILD,
							channelId: ROOM,
						});
						if (!answer.ok) return void failures.push(answer.failure);
						answer.session.onUtterance((utterance) => heard.push(utterance));
					},
					stop: async () => {
						await services.get(DISCORD).voice?.session(GUILD)?.leave();
					},
				},
			],
		}),
	});
}

test("a plugin under test joins through the fake voice, hears what the test says, and its leave is recorded", async () => {
	const voice = fakeDiscordVoice({ now: 1_000_000 });
	voice.channels.set(ROOM, { guildId: GUILD, members: [ANN] });
	const heard: VoiceUtterance[] = [];
	const failures: string[] = [];
	const harness = await testPlugin(recorder(heard, failures), {
		services: [fakeDiscord({ voice }).service],
	});
	expect(voice.joins).toEqual([{ guildId: GUILD, channelId: ROOM }]);
	expect(voice.session(GUILD)?.members()).toEqual([ANN]);
	voice.say(ROOM, ANN.userId, frame(1), frame(2));
	expect(heard).toHaveLength(1);
	expect(heard[0]).toMatchObject({
		userId: "301",
		startedAt: 1_000_000,
		endedAt: 1_000_020,
		continues: false,
	});
	expect(heard[0]?.pcm.byteLength).toBe(3_840);
	await harness.stop();
	expect(voice.ended).toEqual([
		{ guildId: GUILD, channelId: ROOM, reason: "left" },
	]);
	expect(failures).toEqual([]);
});

test("without a voice the plugin reads none, as on a host with discord.voice off; a join failure reaches it", async () => {
	const failures: string[] = [];
	const off = await testPlugin(recorder([], failures), {
		services: [fakeDiscord().service],
	});
	await off.stop();
	const voice = fakeDiscordVoice();
	voice.channels.set(ROOM, { guildId: GUILD, forbidden: true });
	const refused = await testPlugin(recorder([], failures), {
		services: [fakeDiscord({ voice }).service],
	});
	await refused.stop();
	voice.available = false;
	expect(voice.available).toBe(false);
	expect(await voice.join({ guildId: GUILD, channelId: ROOM })).toMatchObject({
		failure: "unavailable",
	});
	expect(failures).toEqual(["voice is off", "forbidden"]);
	expect(voice.joins).toHaveLength(2);
	expect(voice.ended).toEqual([]);
});

test("the fake says what a test got wrong, and keeps the frame it was given", async () => {
	const voice = fakeDiscordVoice();
	expect(() => voice.enter("nowhere", ANN)).toThrow(/there is no channel/);
	voice.channels.set(ROOM, { guildId: GUILD });
	expect(() => voice.audio(ROOM, ANN.userId, frame(1))).toThrow(
		/is not in the channel/,
	);
	const answer = await voice.join({ guildId: GUILD, channelId: ROOM });
	if (!answer.ok) throw new Error(answer.failure);
	const heard: number[] = [];
	answer.session.onUtterance(({ pcm }) => heard.push(pcm[0] ?? -1));
	voice.enter(ROOM, ANN);
	const given = frame(7);
	voice.audio(ROOM, ANN.userId, given);
	// The session holds its own copy: what the test does with its frame later changes nothing.
	given.fill(0);
	voice.quiet();
	expect(heard).toEqual([7]);
	// Someone speaking where the bot is not is not heard.
	voice.channels.set("200000000000000002", { guildId: GUILD, members: [ANN] });
	voice.say("200000000000000002", ANN.userId, frame(1));
	expect(heard).toEqual([7]);
	voice.drop(GUILD, "removed");
	expect(voice.ended).toMatchObject([{ reason: "removed" }]);
});
