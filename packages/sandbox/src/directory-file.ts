import { lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** No check-then-open path: the directory descriptor is the authority, including on macOS fixtures. */
export async function openDirectoryFile(
	directory: number,
	name: string,
	flags: number,
	mode: number,
): Promise<number> {
	if (!name || /[/\\\p{Cc}]/u.test(name) || name === "." || name === "..")
		throw new Error("Invalid directory entry");
	if (process.platform === "linux")
		return openSync(
			join("/proc/self/fd", String(directory), name),
			flags,
			mode,
		);
	if (process.platform !== "darwin")
		throw new Error("Directory-anchored writes require Linux or macOS");
	// macOS has no /proc dirfd paths. Use its POSIX openat rather than weakening path safety.
	const { dlopen } = await import("bun:ffi");
	const libc = dlopen("/usr/lib/libSystem.B.dylib", {
		openat: { args: ["i32", "ptr", "i32", "u32"], returns: "i32" },
	});
	try {
		const file = libc.symbols.openat(
			directory,
			Buffer.from(`${name}\0`),
			flags,
			mode,
		);
		if (file < 0) throw new Error("Directory entry refused");
		return file;
	} finally {
		libc.close();
	}
}

/**
 * Entries under the guest-writable workspace may have been replaced by the guest. A symlink or
 * file where a directory belongs is removed (unlink never follows it) so the host never acts through it.
 */
export function ownDirectory(path: string): void {
	const info = lstatSync(path, { throwIfNoEntry: false });
	if (info && !info.isDirectory()) unlinkSync(path);
	mkdirSync(path, { recursive: true, mode: 0o700 });
}
