import type { HeldActionStore } from "../contract/runtime.ts";
import type { PendingConfirmation } from "../domain/conversation.ts";
import type { ChannelKey } from "../domain/sessions.ts";

/** Held actions kept in memory, for the runtime a plugin's provider builds under test. */
export function memoryHeldActions(): HeldActionStore {
	const held = new Map<ChannelKey, PendingConfirmation>();
	return {
		load: async (conversation) => held.get(conversation),
		save: async (conversation, actions) => {
			if (actions) held.set(conversation, actions);
			else held.delete(conversation);
		},
	};
}
