import type { Tier } from "pi-roundtable";
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

/** A web chat whose person is `person` at `tier`, and whose stranger is another signed-in person. */
function webSubject(person: string, tier: Tier, roles: string[]) {
	const { chat, connect, say } = testChat();
	const conversation = chat.open(speakerOf(person, tier), "helper");
	let socket: ReturnType<typeof connect> | undefined;
	let stranger: ReturnType<typeof connect> | undefined;
	return {
		surface: chat.surface,
		channel: `web:${conversation}` as const,
		speaker: speakerOf(person, tier),
		join: async () => {
			socket = connect(person, roles);
			// Proving the conversation is theirs teaches the surface whose it is.
			await say(socket, { type: "stop", conversation });
		},
		write: async (text: string) => {
			if (socket)
				await say(socket, { type: "send", id: "w", conversation, text });
		},
		observations: () =>
			(socket?.frames ?? []).flatMap((frame) => {
				const seen = observation(frame);
				return seen ? [seen] : [];
			}),
		answer: async (prompt: string, approved: boolean) => {
			if (socket) await say(socket, { type: "approval", prompt, approved });
		},
		stranger: {
			join: async () => {
				stranger = connect("mallory", roles);
			},
			answer: async (prompt: string, approved: boolean) => {
				if (stranger)
					await say(stranger, { type: "approval", prompt, approved });
			},
		},
		close: async () => {
			if (socket) chat.closed(socket);
			if (stranger) chat.closed(stranger);
		},
	};
}

// The owner's approvals need the owner, so the stranger, an admin, is refused by tier as well.
describeSurfaceContract("the web chat surface", async () =>
	webSubject("boss", "owner", ["Admin"]),
);
// A member's approvals need a member, which the stranger is too.
describeSurfaceContract("the web chat surface for a member", async () =>
	webSubject("ann", "member", ["User"]),
);
