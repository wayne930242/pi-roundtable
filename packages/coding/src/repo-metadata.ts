import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
} from "node:fs";
import { join } from "node:path";

const MAX_SUMMARY_CHARS = 120;
const MAX_METADATA_BYTES = 65_536;

/** Metadata discovery never follows links or opens devices/FIFOs; each file is bounded. */
function metadataText(path: string): string | undefined {
	let fd: number | undefined;
	try {
		if (!lstatSync(path).isFile()) return undefined;
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		if (!fstatSync(fd).isFile()) return undefined;
		const bytes = Buffer.alloc(MAX_METADATA_BYTES);
		const count = readSync(fd, bytes, 0, bytes.length, 0);
		return bytes.subarray(0, count).toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** The first prose line of a README or AGENTS.md: no frontmatter, heading, badge, or markup. */
export function summaryOf(dir: string): string | undefined {
	for (const name of ["README.md", "AGENTS.md"]) {
		const file = join(dir, name);
		const content = metadataText(file);
		if (!content) continue;
		const text = content.replace(/^---\n[\s\S]*?\n---\n/, "");
		const line = text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => /\p{L}/u.test(l) && !/^([#!<>|`[\-*=]|\d+\.)/.test(l));
		if (line)
			return line.length > MAX_SUMMARY_CHARS
				? `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…`
				: line;
	}
	return undefined;
}

export function ciOnPush(dir: string): boolean {
	const workflows = join(dir, ".github", "workflows");
	try {
		if (
			!lstatSync(join(dir, ".github")).isDirectory() ||
			!lstatSync(workflows).isDirectory()
		)
			return false;
		return readdirSync(workflows)
			.filter((name) => /\.ya?ml$/.test(name))
			.some((name) =>
				/^\s*(on:\s*\[?[^\n]*\bpush\b|push\s*:)/m.test(
					metadataText(join(workflows, name)) ?? "",
				),
			);
	} catch {
		return false;
	}
}
