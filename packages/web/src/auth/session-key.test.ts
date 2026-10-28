import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("starts racing to make the session key all end up with the one key, and leave no temporary file", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "web-session-key-"));
	const script = `import { loadSessionKey } from ${JSON.stringify(join(import.meta.dir, "session-key.ts"))};
const logger = { warn() {}, info() {}, debug() {}, error() {} };
process.stdout.write(loadSessionKey(${JSON.stringify(dataDir)}, logger).toString("hex"));`;
	const runs = await Promise.all(
		Array.from({ length: 8 }, async () => {
			const child = Bun.spawn(["bun", "-e", script], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(await child.exited, err).toBe(0);
			return out;
		}),
	);
	const onDisk = readFileSync(join(dataDir, "web", "session.key")).toString(
		"hex",
	);
	expect(onDisk).toHaveLength(64);
	expect(new Set(runs)).toEqual(new Set([onDisk]));
	expect(readdirSync(join(dataDir, "web"))).toEqual(["session.key"]);
});
