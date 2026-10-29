import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pageText } from "../src/paging.ts";
import {
	FILES_DIR,
	isRecord,
	type SandboxFiles,
	type ToolSpec,
} from "../src/protocol.ts";

const LIST_LIMIT = 500;
const MAX_SEGMENTS = 16;
const MAX_SEGMENT_CHARS = 255;
const MAX_PATH_CHARS = 512;
/** A file this large is not read whole, whatever wrote it. */
const MAX_READ_BYTES = 16 * 1024 * 1024;

const PATH_NOTE =
	"Paths are relative and `/`-separated inside the workspace's files; `..`, absolute paths, empty segments and links are refused.";

export const FILE_TOOLS: ToolSpec[] = [
	{
		name: "files_list",
		description: `List the workspace files recursively with their sizes, at most ${LIST_LIMIT} entries. ${PATH_NOTE}`,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "A directory; omit for all files.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "files_read",
		description: `Read a UTF-8 text file from character offset (default 0). A long file is paged: when more follows, the first line names the next offset. ${PATH_NOTE}`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				offset: { type: "integer", minimum: 0 },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		name: "files_write",
		description: `Create or replace a UTF-8 text file; parent directories are created. ${PATH_NOTE}`,
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
			additionalProperties: false,
		},
	},
	{
		name: "files_delete",
		description: `Delete a file, or an empty directory. ${PATH_NOTE}`,
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
	},
];

class FileError extends Error {}

/**
 * The file tools of one workspace: everything lives in its `files/` directory, which holds
 * neither memory nor history. These checks bound the tools only; a compromised worker can still
 * write anything into its mount, which is what an operator's filesystem quota is for.
 */
export class WorkspaceFiles {
	readonly #root: string;
	readonly #limits: SandboxFiles;
	readonly #resultBytes: number;

	constructor(workspace: string, limits: SandboxFiles, resultBytes: number) {
		this.#root = join(workspace, FILES_DIR);
		this.#limits = limits;
		this.#resultBytes = resultBytes;
	}

	/** Runs one tool; a refusal comes back as `Error: …` text for the model to read. */
	call(name: string, input: Record<string, unknown>): string {
		try {
			switch (name) {
				case "files_list":
					return this.#list(input);
				case "files_read":
					return this.#read(input);
				case "files_write":
					return this.#write(input);
				case "files_delete":
					return this.#delete(input);
				default:
					throw new FileError(`unknown file tool ${name}`);
			}
		} catch (error) {
			if (error instanceof FileError || error instanceof RangeError)
				return `Error: ${error.message}`;
			throw error;
		}
	}

	#segments(raw: unknown, what = "path"): string[] {
		if (typeof raw !== "string")
			throw new FileError(`${what} must be a string`);
		if (
			raw === "" ||
			raw.length > MAX_PATH_CHARS ||
			raw.includes("\0") ||
			raw.startsWith("/")
		)
			throw new FileError(`${what} must be a relative path without NUL`);
		const segments = raw.split("/");
		if (segments.length > MAX_SEGMENTS)
			throw new FileError(`${what} is nested more than ${MAX_SEGMENTS} deep`);
		for (const segment of segments)
			if (
				segment === "" ||
				segment === "." ||
				segment === ".." ||
				segment.length > MAX_SEGMENT_CHARS
			)
				throw new FileError(`${what} has an empty, dot or oversized segment`);
		return segments;
	}

	/** Walks from `files/` down `segments`, refusing a link at any step; stops at the first missing one. */
	#resolve(segments: readonly string[]): {
		path: string;
		existing: number;
		stat?: Stats;
	} {
		let path = this.#root;
		let existing = 0;
		let stat: Stats | undefined;
		const chain = [undefined, ...segments];
		for (const [index, segment] of chain.entries()) {
			if (segment !== undefined) path = join(path, segment);
			try {
				stat = lstatSync(path);
			} catch {
				return { path: join(this.#root, ...segments), existing };
			}
			if (stat.isSymbolicLink())
				throw new FileError("a link in the path is refused");
			if (index < chain.length - 1 && !stat.isDirectory())
				throw new FileError("a parent in the path is not a directory");
			existing = index + 1;
		}
		return { path, existing, stat };
	}

	#total(directory: string): number {
		let sum = 0;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) sum += this.#total(path);
			else if (entry.isFile()) sum += lstatSync(path).size;
		}
		return sum;
	}

	#list(input: Record<string, unknown>): string {
		const segments =
			input.path === undefined || input.path === "."
				? []
				: this.#segments(input.path);
		const { path, stat } = this.#resolve(segments);
		if (!stat) {
			if (segments.length === 0) return "(No files.)";
			throw new FileError("no such directory");
		}
		if (!stat.isDirectory()) throw new FileError("not a directory");
		const prefix = segments.join("/");
		const lines: string[] = [];
		let more = false;
		let used = 0;
		const walk = (directory: string, relative: string): void => {
			const entries = readdirSync(directory, { withFileTypes: true }).sort(
				(a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
			);
			if (entries.length === 0 && relative !== prefix) emit(`${relative}/`);
			for (const entry of entries) {
				if (more) return;
				const child = relative ? `${relative}/${entry.name}` : entry.name;
				const full = join(directory, entry.name);
				if (entry.isDirectory()) walk(full, child);
				else if (entry.isFile())
					emit(`${child} (${lstatSync(full).size} bytes)`);
			}
		};
		const note =
			"[Listing stopped here; more entries exist. List a narrower path.]";
		const emit = (line: string): void => {
			if (more) return;
			const cost = Buffer.byteLength(JSON.stringify(`${line}\n`)) - 2;
			if (
				lines.length >= LIST_LIMIT ||
				used + cost + Buffer.byteLength(note) + 8 > this.#resultBytes
			) {
				more = true;
				return;
			}
			lines.push(line);
			used += cost;
		};
		walk(path, prefix);
		if (more) lines.push(note);
		return lines.length ? lines.join("\n") : "(No files.)";
	}

	#read(input: Record<string, unknown>): string {
		const { path, stat } = this.#resolve(this.#segments(input.path));
		if (!stat) throw new FileError("no such file");
		if (!stat.isFile()) throw new FileError("not a file");
		if (stat.size > MAX_READ_BYTES)
			throw new FileError("file is too large to read");
		const offset = input.offset === undefined ? 0 : input.offset;
		if (typeof offset !== "number")
			throw new FileError("offset must be a whole number");
		return pageText(readFileSync(path, "utf8"), offset, this.#resultBytes);
	}

	#write(input: Record<string, unknown>): string {
		const segments = this.#segments(input.path);
		if (typeof input.content !== "string")
			throw new FileError("content must be a string");
		const bytes = Buffer.byteLength(input.content);
		if (bytes > this.#limits.maxFileBytes)
			throw new FileError(
				`content is ${bytes} bytes; a file may hold at most ${this.#limits.maxFileBytes} bytes`,
			);
		const rootStat = existsSync(this.#root) ? lstatSync(this.#root) : undefined;
		if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory()))
			throw new FileError("the files directory is not usable");
		const { path, stat } = this.#resolve(segments);
		if (stat && !stat.isFile()) throw new FileError("not a file");
		const total =
			(rootStat ? this.#total(this.#root) : 0) - (stat?.size ?? 0) + bytes;
		if (total > this.#limits.maxTotalBytes)
			throw new FileError(
				`this write would bring the files to ${total} bytes; they may hold at most ${this.#limits.maxTotalBytes} bytes`,
			);
		const parent = join(this.#root, ...segments.slice(0, -1));
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		const temporary = join(parent, `.write-${randomUUID().slice(0, 8)}.tmp`);
		try {
			writeFileSync(temporary, input.content, { mode: 0o600, flag: "wx" });
			renameSync(temporary, path);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
		return `Wrote ${bytes} bytes to ${segments.join("/")}.`;
	}

	#delete(input: Record<string, unknown>): string {
		const segments = this.#segments(input.path);
		const { path, stat } = this.#resolve(segments);
		if (!stat) throw new FileError("no such file or directory");
		if (stat.isDirectory()) {
			if (readdirSync(path).length > 0)
				throw new FileError("directory is not empty");
			rmdirSync(path);
		} else if (stat.isFile()) rmSync(path);
		else throw new FileError("not a file or directory");
		return `Deleted ${segments.join("/")}.`;
	}
}

export function fileToolsEnabled(files: unknown): files is SandboxFiles {
	return isRecord(files);
}
