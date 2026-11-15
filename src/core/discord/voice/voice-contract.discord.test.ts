import { voiceContract } from "./voice-contract.ts";
import { discordVoiceWorld } from "./voice-contract-discord.ts";

voiceContract(() => discordVoiceWorld());
