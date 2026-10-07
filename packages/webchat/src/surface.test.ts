import {
	describeSurfaceContract,
	type SurfaceObservation,
} from "pi-roundtable/testing";
import type { ServerFrame } from "./protocol.ts";
import { speakerOf, testChat } from "./testing/fakes.ts";

/** What a browser shows for each frame, in the contract's words. */
function observation(frame: ServerFrame): SurfaceObservation | undefined {
	switch (frame.type) {
		case "reply":
			return {
				kind: "reply",
				text: frame.text,
				files: (frame.files ?? []).map((file) => file.name),
			};
		case "typing":
			return { kind: "typing", on: frame.on };
		case "stoppable":
			return { kind: "stop", on: frame.on };
		case "progress":
			return { kind: "progress", event: frame.event };
		case "prompt":
			return { kind: "prompt", id: frame.prompt.id, title: frame.prompt.title };
		case "prompt_closed":
			return { kind: "prompt_closed", id: frame.prompt };
		default:
			return undefined;
	}
}

describeSurfaceContract("the web chat surface", async () => {
	const { chat, connect, say } = testChat();
	// The person is the owner, so every approval is theirs to answer.
	const conversation = chat.open(speakerOf("boss", "owner"), "helper");
	let socket: ReturnType<typeof connect> | undefined;
	return {
		surface: chat.surface,
		channel: `web:${conversation}`,
		speaker: speakerOf("boss", "owner"),
		join: async () => {
			socket = connect("boss");
			// Proving the conversation is theirs teaches the surface whose it is.
			await say(socket, { type: "stop", conversation });
		},
		write: async (text) => {
			if (socket)
				await say(socket, { type: "send", id: "w", conversation, text });
		},
		observations: () =>
			(socket?.frames ?? []).flatMap((frame) => {
				const seen = observation(frame);
				return seen ? [seen] : [];
			}),
		answer: async (prompt, approved) => {
			if (socket) await say(socket, { type: "approval", prompt, approved });
		},
		close: async () => {
			if (socket) chat.closed(socket);
		},
	};
});
