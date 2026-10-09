import { expect, test } from "bun:test";
import {
	type ContextSourceMessage,
	selectChannelContext,
} from "./channel-context.ts";
import { DEFAULT_FRESH_MARKER, postFreshMarker } from "./fresh-marker.ts";

function target(dm: boolean, sent: string[], fail = false) {
	return async () => ({
		dm,
		send: async (text: string) => {
			if (fail) throw new Error("Missing Permissions");
			sent.push(text);
		},
	});
}

test("a guild channel gets the divider once, as a post of the assistant that bounds the context window", async () => {
	const sent: string[] = [];
	await postFreshMarker(DEFAULT_FRESH_MARKER, target(false, sent));
	expect(sent).toEqual([DEFAULT_FRESH_MARKER]);
	const at = (n: number) => n * 1_000;
	const message = (
		id: string,
		text: string,
		extra: Partial<ContextSourceMessage> = {},
	): ContextSourceMessage => ({
		id,
		authorId: "200",
		authorName: "Kai",
		bot: false,
		own: false,
		at: at(Number(id)),
		text,
		...extra,
	});
	const { messages } = selectChannelContext(
		[
			message("1", "chatter before the reset"),
			message("2", sent[0] ?? "", { own: true, bot: true, authorId: "900" }),
			message("3", "chatter after the reset"),
		],
		{
			seen: new Set(),
			owners: [],
			settings: {
				fetch: 50,
				keep: 15,
				similarity: 0.8,
				messageChars: 500,
				botMessageChars: 80,
			},
		},
	);
	expect(messages.map((m) => m.text)).toEqual(["chatter after the reset"]);
});

test("a configured text is posted as given", async () => {
	const sent: string[] = [];
	await postFreshMarker("--- reset ---", target(false, sent));
	expect(sent).toEqual(["--- reset ---"]);
});

test("a direct message gets no divider", async () => {
	const sent: string[] = [];
	await postFreshMarker(DEFAULT_FRESH_MARKER, target(true, sent));
	expect(sent).toEqual([]);
});

test("false posts nothing and does not even look the channel up", async () => {
	let looked = false;
	await postFreshMarker(false, async () => {
		looked = true;
		return undefined;
	});
	expect(looked).toBe(false);
});

test("a channel that cannot be found or written to is left as it is", async () => {
	await postFreshMarker(DEFAULT_FRESH_MARKER, async () => undefined);
});

test("a failed post rejects so the caller can log it", async () => {
	await expect(
		postFreshMarker(DEFAULT_FRESH_MARKER, target(false, [], true)),
	).rejects.toThrow("Missing Permissions");
});
