// What the suites that drive the owner app through `app-host.ts` share: reading its REST and waiting for it.

import type { PromptScope } from "pi-roundtable";
import type { MessagesView, RoomsView } from "../api-types.ts";
import { ADA_DISCORD, type Booted, rest } from "./app-host.ts";

export const OWNER_SCOPE: PromptScope = {
	principalId: ADA_DISCORD,
	speakerId: `discord:${ADA_DISCORD}`,
	tier: "owner",
	escalate: "owners",
};

export const isThreadKey = (key: string) =>
	/^app:thread\.[0-9a-f-]{36}$/.test(key);

/** The messages of a room as the REST serves them. */
export async function messagesOf(booted: Booted, room: string) {
	return (
		(await (
			await rest(booted, `rooms/${encodeURIComponent(room)}/messages`)
		).json()) as MessagesView
	).messages;
}

/** The room list as the REST serves it. */
export async function roomList(booted: Booted) {
	return ((await (await rest(booted, "rooms")).json()) as RoomsView).rooms;
}

/** Waits until `check` returns a value, polling for up to `ms`. */
export async function until<T>(
	check: () => Promise<T | undefined>,
	ms = 4000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = await check();
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error("the condition never held");
		await Bun.sleep(20);
	}
}
