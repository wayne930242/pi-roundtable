import type { ConversationPort } from "../contract/channels.ts";
import type { HeldActionStore } from "../contract/runtime.ts";
import type { ServiceKey } from "../contract/services.ts";
import type { PendingConfirmation } from "../domain/conversation.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { NotLinkedError, PluginError } from "../kernel/errors.ts";
import type { ChannelRouter } from "../routing/channel-router.ts";

/** The same pre-link failures and wording the host exposes during setup. */
export const NOT_LINKED = {
	conversations:
		"conversations are linked once every plugin is set up. Use them from a service's start or from a handler, not during setup.",
	sessions:
		"session parts are linked once every plugin is set up. Call sessions() from a service's start or from a handler, not during setup.",
	surfaces:
		"chat surfaces are linked once every plugin is set up. Use surfaces from a service's start or from a handler, not during setup.",
	turns:
		"conversation turns are linked once every plugin is set up. Use turns from a service's start or from a handler, not during setup.",
	dashboard:
		"dashboard lines are linked once every plugin is set up. Call dashboard() from a service's start or from a handler, not during setup.",
	chatCommands:
		"chat commands are linked once every plugin is set up. Call chatCommands() from a service's start or from a handler, not during setup.",
};

export function unlinked(part: keyof typeof NOT_LINKED): never {
	throw new NotLinkedError(NOT_LINKED[part]);
}

/** Members a probe may ask of any object: a test's partial service is not refused for them. */
const PROBED = new Set(["then", "toJSON", "asymmetricMatch"]);

/** A service the test gave only some members of: reading another names the option that adds it. */
export function partialService<T extends object>(
	key: ServiceKey<unknown>,
	given: T,
): T {
	return new Proxy(given, {
		get(target, member, receiver) {
			if (member in target || typeof member === "symbol" || PROBED.has(member))
				return Reflect.get(target, member, receiver);
			throw new PluginError(
				`testPlugin gave service ${key.id} no "${member}". Give it in the services option: testPlugin(plugin, { services: [servicePair(KEY, { ${member}: ... })] }).`,
			);
		},
	});
}

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

/** A conversation port that reads the router once the host links it, and throws before; `overrides` replace its methods. */
export function routedConversations(
	router: () => ChannelRouter | undefined,
	overrides: Partial<ConversationPort> | undefined,
): ConversationPort {
	return {
		handle: async (message) =>
			(router() ?? unlinked("conversations")).handle(message),
		messageDeleted: async (channel, id, space) =>
			(router() ?? unlinked("conversations")).messageDeleted(
				channel,
				id,
				space,
			),
		messageEdited: async (message) =>
			(router() ?? unlinked("conversations")).messageEdited(message),
		background: async (turn) =>
			(router() ?? unlinked("conversations")).background(turn),
		runsAs: async (turn) =>
			(router() ?? unlinked("conversations")).runsAs(turn),
		target: (name) => (router() ?? unlinked("conversations")).target(name),
		startFresh: async (channel) =>
			(router() ?? unlinked("conversations")).startFresh(channel),
		deleteConversation: async (channel) =>
			(router() ?? unlinked("conversations")).deleteConversation(channel),
		stop: (channel) => (router() ?? unlinked("conversations")).stop(channel),
		postsInPlace: (channel) =>
			(router() ?? unlinked("conversations")).postsInPlace(channel),
		owns: (channel) => (router() ?? unlinked("conversations")).owns(channel),
		takesBackground: (channel) =>
			(router() ?? unlinked("conversations")).takesBackground(channel),
		takesSystemReports: (channel) =>
			(router() ?? unlinked("conversations")).takesSystemReports(channel),
		...overrides,
	};
}
