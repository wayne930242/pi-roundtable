import { fakeDiscordVoice } from "../../testing/fake-voice.ts";
import { voiceContract } from "./voice-contract.ts";

voiceContract(() => {
	const voice = fakeDiscordVoice();
	return {
		voice,
		world: {
			botId: voice.botId,
			channel: (channelId, channel) => voice.channels.set(channelId, channel),
			enter: (channelId, member) => voice.enter(channelId, member),
			exit: (channelId, userId) => voice.exit(channelId, userId),
			audio: (channelId, userId, pcm) => voice.audio(channelId, userId, pcm),
			quiet: () => voice.quiet(),
			drop: (guildId, how) => voice.drop(guildId, how),
			offline: () => {
				voice.available = false;
			},
			stop: () => voice.stop(),
		},
	};
});
