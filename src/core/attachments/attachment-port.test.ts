import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentRefusal } from "../contract/attachments.ts";
import type { ConversationRegistry } from "../conversations/conversation-registry.ts";
import { PluginError } from "../errors.ts";
import { Roundtable } from "../host.ts";
import { silentLogger } from "../log.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin.ts";
import { CONVERSATIONS } from "../services.ts";

const hosts: Roundtable[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown("test");
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const file = {
	name: "session.json",
	contentType: "application/json",
	data: new TextEncoder().encode("{}"),
};

/** Boots a host over a registry that records `web:1` as private to ada, and returns a plugin's context. */
async function boot(dataDir: string | undefined): Promise<PluginContext> {
	const registry = {
		get: async (key: string) =>
			key === "web:1"
				? {
						key,
						kind: "support",
						visibility: "private" as const,
						principalId: "ada",
						surface: "web",
						createdAt: new Date(),
						lastActiveAt: new Date(),
					}
				: undefined,
	} as unknown as ConversationRegistry;
	let seen: PluginContext | undefined;
	const plugins: RoundtablePlugin[] = [
		{
			name: "records",
			provides: [CONVERSATIONS],
			setup: ({ services }) => {
				services.provide(CONVERSATIONS, registry);
				return { services: [{ name: "records" }] };
			},
		},
		{
			name: "probe",
			setup: (context) => {
				seen = context;
				return { services: [{ name: "probe" }] };
			},
		},
	];
	const host = new Roundtable(
		{ logger: silentLogger(), ...(dataDir ? { dataDir } : {}) },
		plugins,
	);
	hosts.push(host);
	await host.run();
	if (!seen) throw new Error("the probe was not set up");
	return seen;
}

describe("context.attachments", () => {
	test("keeps files under the host's dataDir and follows the conversation registry", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "roundtable-att-port-"));
		dirs.push(dataDir);
		const { attachments } = await boot(dataDir);
		const saved = await attachments.save("web:2", "bob", file);
		expect(saved.path.startsWith(dataDir)).toBe(true);
		await expect(attachments.save("web:1", "bob", file)).rejects.toBeInstanceOf(
			AttachmentRefusal,
		);
		await attachments.save("web:1", "ada", file);
	});

	test("without a dataDir every call throws a PluginError naming the option", async () => {
		const { attachments } = await boot(undefined);
		expect(() => attachments.save("web:1", "ada", file)).toThrow(PluginError);
		expect(() => attachments.pendingBytes("ada")).toThrow("dataDir");
	});
});
