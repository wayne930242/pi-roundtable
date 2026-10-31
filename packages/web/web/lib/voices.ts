import { signal } from "./signal.ts";

// Who speaks in each room's dialogue box: the agent whose words the box reveals now. The box tells it
// and the round table lights that member, so the light follows the words and not the turn.

let voices: Readonly<Record<string, string>> = {};
const { emit, use } = signal();

/** The member whose words the room's box reveals now, or nobody (`undefined`). */
export function setVoice(room: string, agent: string | undefined): void {
	if (voices[room] === agent) return;
	const next = { ...voices };
	if (agent === undefined) delete next[room];
	else next[room] = agent;
	voices = next;
	emit();
}

/** Every room's voice, by room key. */
export const currentVoices = (): Readonly<Record<string, string>> => voices;

/** Every room's voice; the component draws again when one changes. */
export function useVoices(): Readonly<Record<string, string>> {
	return use(currentVoices);
}
