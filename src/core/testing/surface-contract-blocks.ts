import { describe, test } from "bun:test";
import type { SurfaceContractSubject } from "./surface-contract.ts";
import {
	expectThat,
	type Running,
	runCheck,
	seen,
	until,
} from "./surface-contract-support.ts";

/** The contract of a surface that lists `ChatSurface.blocks`: what it says it draws arrives whole. */
export const BLOCK_CHECKS: readonly {
	name: string;
	applies(subject: SurfaceContractSubject): boolean;
	run(running: Running): Promise<void>;
}[] = [
	{
		name: "shows a block of a kind it draws whole, longer than a message",
		applies: (subject) => (subject.surface.blocks?.length ?? 0) > 0,
		run: async (running) => {
			const { surface, channel } = running.subject;
			const kind = surface.blocks?.[0] ?? "table";
			// What the block holds is the kind's to read; the surface must not cut or reflow it.
			const block = [
				`\`\`\`${kind}`,
				...Array.from({ length: 120 }, (_, i) => `row ${i}: ${"x".repeat(30)}`),
				"```",
			].join("\n");
			expectThat(block.length > 2000, "the block is longer than a message");
			await surface.sendReply(channel, { chunks: [`Here it is.\n\n${block}`] });
			await until(
				() => seen(running, "reply").length > 0,
				"the person sees the reply",
			);
			const reply = seen(running, "reply")[0];
			expectThat(
				reply?.kind === "reply" && reply.text.includes(block),
				`the ${kind} block did not arrive whole`,
			);
		},
	},
];

/**
 * Registers only the display-block part of the contract, for a surface that cannot run the whole
 * chat contract (its person writes through a browser, say). The subject needs `surface`,
 * `channel` and `observations()` showing the replies its person has seen; `write` is never called.
 */
export function describeBlocksContract(
	name: string,
	make: () => Promise<SurfaceContractSubject>,
): void {
	describe(`${name} keeps the display-block contract`, () => {
		for (const check of BLOCK_CHECKS)
			test(check.name, async () => {
				await runCheck(check, make);
			});
	});
}
