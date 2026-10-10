import {
	findWorkspaceFile,
	readWorkspaceFile,
	type WorkspaceFile,
	WorkspaceFileError,
	type WorkspaceRoots,
} from "../shared/workspace-files.ts";
import {
	CHANNEL_UPLOAD_MAX_BYTES,
	ChannelToolError,
	FILE_CHANNEL_TOOLS,
} from "./channel-operations.ts";

interface SessionFile {
	path?: string;
	filename?: string;
	dataBase64?: string;
	description?: string;
}

const refuse = (code: string, detail: string) =>
	new ChannelToolError(`${code}: ${detail}`);

/** The bytes a base64 string carries, before it is checked; `parseChannelTool` checks it. */
const base64Bytes = (data: string) =>
	Math.floor((data.length * 3) / 4) -
	(data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/**
 * A session's call to a file tool in the inline form `parseChannelTool` takes: each file names
 * exactly one of `path` or `dataBase64`, and a path is read from the session's workspace or scratch
 * dir. Without `roots` only inline files are accepted. Other tools' arguments pass unchanged.
 */
export async function resolveChannelFiles(
	tool: string,
	args: Record<string, unknown>,
	roots: WorkspaceRoots | undefined,
): Promise<Record<string, unknown>> {
	if (!FILE_CHANNEL_TOOLS.includes(tool) || !Array.isArray(args.files))
		return args;
	const entries = args.files as SessionFile[];
	const found: (WorkspaceFile | undefined)[] = [];
	let bytes = 0;
	for (const entry of entries) {
		const hasPath = typeof entry?.path === "string";
		const hasData = typeof entry?.dataBase64 === "string";
		if (hasPath === hasData)
			throw refuse(
				"INVALID_CHANNEL_FILE",
				"give each file exactly one of path or dataBase64",
			);
		if (hasData) {
			if (typeof entry.filename !== "string")
				throw refuse(
					"INVALID_CHANNEL_FILE",
					"a file given as dataBase64 needs a filename",
				);
			bytes += base64Bytes(entry.dataBase64 as string);
			found.push(undefined);
			continue;
		}
		if (!roots)
			throw refuse(
				"INVALID_CHANNEL_FILE_PATH",
				"this session has no workspace, so it can send files only as dataBase64",
			);
		const file = await find(entry.path as string, roots);
		bytes += file.size;
		found.push(file);
	}
	if (bytes > CHANNEL_UPLOAD_MAX_BYTES)
		throw new ChannelToolError("INVALID_CHANNEL_UPLOAD_SIZE");
	const files = await Promise.all(
		entries.map(async (entry, index) => {
			const file = found[index];
			if (!file) return entry;
			const data = await read(file);
			const { path: _path, ...rest } = entry;
			return {
				...rest,
				filename: entry.filename ?? file.name,
				dataBase64: Buffer.from(data).toString("base64"),
			};
		}),
	);
	return { ...args, files };
}

async function find(path: string, roots: WorkspaceRoots) {
	try {
		return await findWorkspaceFile(path, roots);
	} catch (error) {
		if (error instanceof WorkspaceFileError)
			throw refuse("INVALID_CHANNEL_FILE_PATH", error.message);
		throw error;
	}
}

async function read(file: WorkspaceFile) {
	try {
		return await readWorkspaceFile(file, CHANNEL_UPLOAD_MAX_BYTES);
	} catch (error) {
		if (error instanceof WorkspaceFileError)
			throw new ChannelToolError("INVALID_CHANNEL_UPLOAD_SIZE");
		throw error;
	}
}
