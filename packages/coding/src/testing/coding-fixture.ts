import { fileURLToPath } from "node:url";
import type { ChatSurface, OwnerPrompts } from "pi-roundtable";

export const FAUX_PROVIDER = fileURLToPath(
	new URL("./faux-provider.ts", import.meta.url),
);

export const stops: (() => Promise<void>)[] = [];

export function gate<T>() {
	let resolve = (_value: T) => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export function surface(
	prompts?: OwnerPrompts,
): ChatSurface & { posts: string[] } {
	const posts: string[] = [];
	return {
		surface: "test",
		posts,
		start: async () => {},
		sendReply: async (_channel, reply) => {
			posts.push(reply.chunks.join("\n"));
		},
		prompts: () => prompts,
	};
}

export const request = (repo = "sample/project") => ({
	repo,
	task: "Implement the contract",
	channel: "test:room" as const,
	model: "faux/worker",
	thinking: "off" as const,
	skillFiles: [],
});
