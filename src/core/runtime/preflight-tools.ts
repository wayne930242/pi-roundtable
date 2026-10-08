import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ConfirmationGate } from "./extensions/confirmation-gate.ts";
import { PromptSlot } from "./prompt-slot.ts";
import type { PiAgentRuntimeOptions } from "./runtime-types.ts";
import type { SessionFactory } from "./session-factory.ts";

/**
 * Tools available in either startup scope, without running a turn or retaining a session.
 * The private probe is built only when the shared one lacks a required tool, so a host
 * without scoped tools starts exactly as before.
 */
export async function preflightTools(
	factory: SessionFactory,
	owner: PiAgentRuntimeOptions["owner"],
	required: readonly string[],
): Promise<Set<string>> {
	const registered = new Set<string>();
	for (const conversation of [
		{ visibility: "shared" },
		{ visibility: "private", principalId: owner.id },
	] as const) {
		if (
			conversation.visibility === "private" &&
			required.every((name) => registered.has(name))
		)
			break;
		const probe = await factory.create(
			conversation.visibility === "shared"
				? "probe:startup"
				: "probe:startup-private",
			SessionManager.inMemory(factory.workDir()),
			new ConfirmationGate(factory.link().holds, owner),
			new PromptSlot(),
			join(factory.workDir(), "probe-attachments"),
			undefined,
			"owner",
			conversation,
		);
		try {
			for (const tool of probe.session.getAllTools()) registered.add(tool.name);
		} finally {
			probe.session.dispose();
		}
	}
	return registered;
}
