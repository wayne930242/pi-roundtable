import {
	type ConversationRegistry,
	channelKey,
	type DirectChannelProvider,
	type IdentityService,
} from "pi-roundtable";
import { Refusal, type WebChat } from "./chat.ts";
import type { PgNotices } from "./notices.ts";

export interface WebDirectChannelOptions {
	chat: WebChat;
	identity(): IdentityService;
	registry(): ConversationRegistry;
	notices: PgNotices;
}

/** A private inbox, known offline through linked identities or existing private web conversations. */
export function webDirectChannel(
	options: WebDirectChannelOptions,
): DirectChannelProvider {
	const { chat, identity, registry, notices } = options;
	const surface = chat.surface.surface;
	const knows = async (principalId: string) => {
		const principal = await identity().principal(principalId);
		if (!principal || principal.disabled) return false;
		const linked = await identity().identities(principalId);
		if (
			linked.some(
				(link) =>
					link.provider.startsWith("oidc:") || link.provider === surface,
			)
		)
			return true;
		return (await registry().list({ principal: principalId })).some(
			(record) => record.surface === surface && record.visibility === "private",
		);
	};
	return {
		name: `webchat:${surface}`,
		label: "a notice in the web inbox",
		knows,
		reaches: async (principalId) => {
			if (!(await knows(principalId))) return undefined;
			const speaker = await identity().speakerFor(principalId);
			const available = chat.personasFor(speaker);
			const persona = available[0];
			if (!persona) return undefined;
			const records = await chat.list(speaker);
			const existing = records.find((record) =>
				available.some((p) => p.kind === record.kind),
			);
			const key = existing?.key ?? channelKey(surface, crypto.randomUUID());
			if (!existing)
				await registry().register({
					key,
					kind: persona.kind,
					visibility: "private",
					principalId,
				});
			// Proves ownership, teaches the surface the recipient, and never changes visibility.
			await chat.own(speaker, chat.surface.conversationOf(key));
			return key;
		},
		deliver: async (principalId, text) => {
			if (!(await knows(principalId))) throw new Refusal("forbidden");
			const notice = await notices.add(principalId, text);
			chat.connections.sendTo(principalId, { type: "notice", notice });
		},
	};
}
