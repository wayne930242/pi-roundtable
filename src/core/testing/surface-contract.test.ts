import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { Approval } from "../domain/owner-prompts.ts";
import {
	checkSurfaceContract,
	describeSurfaceContract,
	type SurfaceContractSubject,
	type SurfaceObservation,
} from "./surface-contract.ts";

/** An in-memory chat that keeps the contract: what the host asks of it is what its person sees. */
function memoryChat(
	options: { files?: boolean; brokenPrompts?: boolean } = {},
): SurfaceContractSubject {
	const seen: SurfaceObservation[] = [];
	const open = new Map<string, (answer: Approval) => void>();
	let deliver: ((message: InboundMessage) => void) | undefined;
	let next = 0;
	const surface: ChatSurface = {
		surface: "memory",
		...(options.files ? { supportsFiles: true } : {}),
		start: async (given) => {
			deliver = given;
		},
		sendReply: async (_channel, reply) =>
			void seen.push({
				kind: "reply",
				text: reply.chunks.join("\n"),
				files: (reply.files ?? []).map((file) => file.name),
			}),
		startTyping: () => {
			seen.push({ kind: "typing", on: true });
			let on = true;
			return () => {
				if (on) seen.push({ kind: "typing", on: false });
				on = false;
			};
		},
		progress: (_channel, event) => void seen.push({ kind: "progress", event }),
		prompts: () => ({
			confirm: (title, _message, signal) =>
				new Promise<Approval>((resolve) => {
					const id = `p${++next}`;
					seen.push({ kind: "prompt", id, title });
					const settle = (answer: Approval) => {
						open.delete(id);
						seen.push({ kind: "prompt_closed", id });
						resolve(answer);
					};
					open.set(id, settle);
					signal?.addEventListener("abort", () =>
						settle(options.brokenPrompts ? "expired" : "cancelled"),
					);
				}),
			ask: async () => undefined,
		}),
	};
	return {
		surface,
		channel: "memory:room",
		write: async (text) =>
			deliver?.({
				channel: "memory:room",
				messageId: `m${++next}`,
				authorId: "1",
				authorName: "Ada",
				authorIsBot: false,
				isDirect: true,
				mentionsBot: false,
				repliesToBot: false,
				text,
				attachments: [],
			}),
		observations: () => seen,
		answer: async (id, approved) =>
			open.get(id)?.(approved ? "approved" : "declined"),
	};
}

describeSurfaceContract("an in-memory chat", async () => memoryChat());
describeSurfaceContract("an in-memory chat with files", async () =>
	memoryChat({ files: true }),
);

test("the contract catches a surface whose cancelled card does not say cancelled", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ brokenPrompts: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"a stopped turn's approval resolves cancelled and closes",
	]);
});

test("the contract catches a surface that delivers nothing", async () => {
	const failures = await checkSurfaceContract(async () => ({
		...memoryChat(),
		write: async () => undefined,
	}));
	expect(failures.map((failure) => failure.name)).toContain(
		"delivers what the person writes, in their channel",
	);
});
