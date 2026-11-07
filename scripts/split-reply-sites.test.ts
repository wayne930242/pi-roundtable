import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");

/**
 * The places that cut text into Discord-sized messages with `splitReply` themselves. Text an
 * agent wrote goes through `chunksFor`, which turns the display blocks in it into text for a
 * surface that does not draw them before it cuts; a call that skips it would put raw YAML on
 * Discord or LINE. Each entry here was reviewed to be host text (a notice or an error report),
 * never agent text, or to be `chunksFor` itself.
 */
const REVIEWED: Record<string, string> = {
	"src/core/presentation/reply-chunks.ts":
		"chunksFor, the one cut for agent text",
	"src/core/builtin/modules.ts": "an error report from the host",
	"src/core/builtin/agent-server.ts": "an error report from the host",
};

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		if (name === "node_modules") return [];
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
			? [path]
			: [];
	});
}

test("every call of splitReply outside chunksFor is one reviewed to be host text", () => {
	const dirs = [
		join(root, "src"),
		...readdirSync(join(root, "packages")).map((name) =>
			join(root, "packages", name, "src"),
		),
	].filter((dir) => {
		try {
			return statSync(dir).isDirectory();
		} catch {
			return false;
		}
	});
	const calling = dirs
		.flatMap(sources)
		.filter((file) =>
			/\bsplitReply\(/.test(
				readFileSync(file, "utf8").replace(/export function splitReply\(/, ""),
			),
		)
		.map((file) => relative(root, file).split(sep).join("/"))
		.filter((file) => file !== "src/core/presentation/reply-splitter.ts")
		.sort();
	expect(calling).toEqual(Object.keys(REVIEWED).sort());
});
