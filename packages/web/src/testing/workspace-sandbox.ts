import { afterEach, beforeEach, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingLogger } from "pi-roundtable/testing";
import {
	WorkspaceConflictError,
	WorkspaceFiles,
	WorkspaceRefusal,
	type WorkspaceRoot,
} from "../app/workspace-files.ts";

export const hex = (data: ArrayBufferLike | Uint8Array): string =>
	Buffer.from(data as ArrayBuffer).toString("hex");
export const sha = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");

/** A sandbox outside the repository: `base/root` is the workspace, `base/outside` is what must stay untouched. */
export let base: string;
export let root: string;
export let outside: string;
export let log: ReturnType<typeof recordingLogger>;
export let hooks: { beforeReplace?: (tmp: string, target: string) => void };

export const OWNER = "owner:1";

export function files(extra: Partial<WorkspaceRoot>[] = []) {
	const roots: WorkspaceRoot[] = [
		{ id: "agents", label: "Knights", dir: root, writable: true },
		...extra.map(
			(part, index) =>
				({
					id: `extra${index}`,
					label: `Extra ${index}`,
					dir: join(base, `extra${index}`),
					writable: false,
					...part,
				}) satisfies WorkspaceRoot,
		),
	];
	return new WorkspaceFiles({ roots, logger: log.logger, hooks });
}

/** Registers the sandbox: a fresh one before each test, removed after it. */
export function sandboxPerTest(): void {
	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "rt-workspace-"));
		root = join(base, "root");
		outside = join(base, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
		writeFileSync(join(base, "sibling.txt"), "SIBLING");
		log = recordingLogger();
		hooks = {};
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});
}

/** The refusal a promise ends in, or a failing expectation. */
export async function refused(
	promise: Promise<unknown>,
): Promise<WorkspaceRefusal> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(WorkspaceRefusal);
		return error as WorkspaceRefusal;
	}
	throw new Error("expected a refusal");
}

export async function conflict(
	promise: Promise<unknown>,
): Promise<WorkspaceConflictError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(WorkspaceConflictError);
		return error as WorkspaceConflictError;
	}
	throw new Error("expected a conflict");
}

export const untouched = () => {
	expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP SECRET");
	expect(readFileSync(join(base, "sibling.txt"), "utf8")).toBe("SIBLING");
	expect(readdirSync(outside)).toEqual(["secret.txt"]);
};
