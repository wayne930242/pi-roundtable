import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageDir, serveUnix } from "./index.ts";

test("packageDir is the installed package's folder, with its package.json", () => {
	const dir = packageDir("typebox");
	expect(basename(dir)).toBe("typebox");
	expect(existsSync(join(dir, "package.json"))).toBe(true);
});

test("packageDir looks a package up from the file that asks", () => {
	const root = mkdtempSync(join(tmpdir(), "roundtable-package-dir-"));
	const lib = join(root, "node_modules", "elsewhere");
	mkdirSync(lib, { recursive: true });
	writeFileSync(join(lib, "package.json"), '{"name":"elsewhere"}');
	// Only the asking file's own node_modules holds it, not the core's.
	expect(() => packageDir("elsewhere")).toThrow();
	expect(
		packageDir("elsewhere", pathToFileURL(join(root, "host.ts")).href),
	).toBe(lib);
});

test("serveUnix answers on the socket and replaces a stale socket file", async () => {
	const socket = join(
		mkdtempSync(join(tmpdir(), "roundtable-unix-")),
		"s.sock",
	);
	const first = serveUnix(socket, () => new Response("one"));
	first.stop(true);
	const second = serveUnix(socket, () => new Response("two"));
	try {
		const reply = await fetch("http://localhost/", { unix: socket });
		expect(await reply.text()).toBe("two");
	} finally {
		second.stop(true);
	}
});

test("serveUnix gives a failure outside the handler to the error option", async () => {
	const socket = join(
		mkdtempSync(join(tmpdir(), "roundtable-unix-")),
		"e.sock",
	);
	const server = serveUnix(
		socket,
		() => {
			throw new Error("boom");
		},
		{ error: () => new Response("failed", { status: 500 }) },
	);
	try {
		const reply = await fetch("http://localhost/", { unix: socket });
		expect(reply.status).toBe(500);
		expect(await reply.text()).toBe("failed");
	} finally {
		server.stop(true);
	}
});
