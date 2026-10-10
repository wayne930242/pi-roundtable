import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentPort } from "./contract/attachments.ts";
import { PluginError } from "./errors.ts";
import { Roundtable, type RoundtableOptions } from "./host.ts";
import { silentLogger } from "./log.ts";

const hosts: Roundtable[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const roundtable of hosts.splice(0)) await roundtable.shutdown("test");
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A host whose one plugin keeps the attachment port it was given. */
function hostWith(options: Partial<RoundtableOptions>) {
	const seen: { port?: AttachmentPort } = {};
	const roundtable = new Roundtable(
		{
			logger: silentLogger(),
			drain: { intervalMs: 1, limitMs: 50 },
			...options,
		},
		[
			{
				name: "uploads",
				setup: (context) => {
					seen.port = context.attachments;
					return { services: [{ name: "uploads" }] };
				},
			},
		],
	);
	hosts.push(roundtable);
	return { roundtable, seen };
}

function dataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-host-retention-"));
	dirs.push(dir);
	return dir;
}

const upload = {
	name: "notes.txt",
	contentType: "text/plain",
	data: new TextEncoder().encode("private"),
};

describe("attachments.retention", () => {
	test("removes a used file once it is older than the age", async () => {
		const { roundtable, seen } = hostWith({
			dataDir: dataDir(),
			attachments: { retention: { maxAgeMs: 60, sweepEveryMs: 25 } },
		});
		await roundtable.run();
		const saved = await seen.port?.save("web:a", "ada", upload);
		const turn = await seen.port?.turnAttachments("web:a", "ada", [
			saved?.file ?? "",
		]);
		const path = turn?.files[0]?.path ?? "";
		expect(existsSync(path)).toBe(true);
		await Bun.sleep(250);
		expect(existsSync(path)).toBe(false);
	});

	test("keeps a used file when no retention is set", async () => {
		const { roundtable, seen } = hostWith({ dataDir: dataDir() });
		await roundtable.run();
		const saved = await seen.port?.save("web:a", "ada", upload);
		const turn = await seen.port?.turnAttachments("web:a", "ada", [
			saved?.file ?? "",
		]);
		await Bun.sleep(100);
		expect(existsSync(turn?.files[0]?.path ?? "")).toBe(true);
	});

	test("sweeps once at start, so files that aged while the host was down go at once", async () => {
		const dir = dataDir();
		const first = hostWith({ dataDir: dir });
		await first.roundtable.run();
		const saved = await first.seen.port?.save("web:a", "ada", upload);
		const turn = await first.seen.port?.turnAttachments("web:a", "ada", [
			saved?.file ?? "",
		]);
		await first.roundtable.shutdown("test");
		await Bun.sleep(30);
		const second = hostWith({
			dataDir: dir,
			attachments: { retention: { maxAgeMs: 10, sweepEveryMs: 3_600_000 } },
		});
		await second.roundtable.run();
		expect(existsSync(turn?.files[0]?.path ?? "")).toBe(false);
	});

	test("refuses to start without a dataDir, naming the option", async () => {
		const { roundtable } = hostWith({
			attachments: { retention: { maxAgeMs: 1_000 } },
		});
		const error = await roundtable.run().then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		expect(error).toBeInstanceOf(PluginError);
		expect((error as Error).message).toContain("dataDir");
		expect((error as Error).message).toContain("attachments.retention");
	});

	test("refuses an age or a period that is not a positive whole number", async () => {
		for (const retention of [
			{ maxAgeMs: 0 },
			{ maxAgeMs: 1.5 },
			{ maxAgeMs: 1_000, sweepEveryMs: 0 },
		]) {
			const { roundtable } = hostWith({
				dataDir: dataDir(),
				attachments: { retention },
			});
			const error = await roundtable.run().then(
				() => undefined,
				(thrown: unknown) => thrown,
			);
			expect(error).toBeInstanceOf(PluginError);
			expect((error as Error).message).toContain("attachments.retention");
		}
	});
});
