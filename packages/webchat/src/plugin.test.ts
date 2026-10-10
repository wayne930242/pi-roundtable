import { expect, test } from "bun:test";
import type { SQL } from "bun";
import type { PluginContext, Service } from "pi-roundtable";
import { partial, silentLogger } from "pi-roundtable/testing";
import { webChat } from "./plugin.ts";
import { memoryAttachments } from "./testing/memory-attachments.ts";

const verifier = async () => {
	throw new Error("no tokens in this test");
};
const base = {
	verifier,
	origins: ["https://chat.example.test"],
	personas: [{ kind: "helpdesk", prompt: () => "Help." }],
};

/** What setup needs of the context, with the attachment port the test gives. */
function contextOver(attachments: PluginContext["attachments"] | undefined) {
	return partial<PluginContext>({
		logger: silentLogger(),
		database: () => partial<SQL>({}),
		...(attachments ? { attachments } : {}),
	});
}

async function service(
	attachments: PluginContext["attachments"] | undefined,
	limits: Parameters<typeof webChat>[0]["limits"] = {},
): Promise<Service> {
	const contribution = await webChat({ ...base, limits }).setup(
		contextOver(attachments),
	);
	const [one] = contribution.services ?? [];
	if (!one) throw new Error("the plugin contributed no service");
	return one;
}

test("it refuses to set up on a core that keeps no attachments, naming the version", async () => {
	// A core before 0.9.2 has no such member at all.
	const old = {
		logger: silentLogger(),
		database: () => ({}),
	} as unknown as PluginContext;
	await expect(
		Promise.resolve().then(() => webChat(base).setup(old)),
	).rejects.toThrow("pi-roundtable 0.9.2");
});

const upload = (port: ReturnType<typeof memoryAttachments>) =>
	port.save("web:c1", "ada", {
		name: "a.txt",
		contentType: "text/plain",
		data: new TextEncoder().encode("x"),
	});

test("its service sweeps old uploads when the host starts, and as time passes, until it stops", async () => {
	let age = 10_000;
	const port = memoryAttachments(() => Date.now() - age);
	await upload(port);
	const swept = await service(port, { unsentUploadTtlMs: 100 });
	await swept.start?.();
	// The upload was older than its time to live at start.
	expect(port.staged.size).toBe(0);
	age = 0;
	await upload(port);
	for (let waited = 0; port.staged.size > 0; waited += 20) {
		if (waited > 3000) throw new Error("the upload was not swept");
		await Bun.sleep(20);
	}
	await swept.stop?.();
	age = 10_000;
	await upload(port);
	await Bun.sleep(400);
	expect(port.staged.size).toBe(1);
});

test("a host without a dataDir stops at start, naming the option", async () => {
	const refusing = memoryAttachments();
	refusing.discardPending = () => {
		throw new Error("no dataDir is configured");
	};
	const started = await service(refusing);
	await expect(Promise.resolve().then(() => started.start?.())).rejects.toThrow(
		"dataDir",
	);
});

test("limits it cannot honour stop the configuration", () => {
	for (const limits of [
		{ attachmentBytes: 26 * 1024 * 1024 },
		{ attachmentBytes: 0 },
		{ attachmentsPerMessage: 1.5 },
		{ usedAttachmentBytesPerPrincipal: 0 },
		{ attachmentTypes: ["PNG"] },
	])
		expect(() => webChat({ ...base, limits })).toThrow("webChat: limits.");
});
