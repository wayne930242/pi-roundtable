import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tier } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import type {
	WorkspaceConflict,
	WorkspaceFileView,
	WorkspaceListView,
	WorkspaceRefusalBody,
	WorkspaceRootsView,
	WorkspaceSaved,
	WorkspaceTrashItem,
	WorkspaceTrashView,
} from "./api-types.ts";
import { AppApi, partsOf } from "./app/routes.ts";
import { checkRoots, WorkspaceFiles } from "./app/workspace-files.ts";
import type { AssetBundle } from "./assets.ts";
import { createAuthenticator } from "./auth/authenticator.ts";
import { ConsoleServer } from "./console-server.ts";
import { resolveOptions, showableRoots, workspaceRootsOf } from "./options.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import { admit } from "./verifier.ts";
import type { Visitor } from "./visitors.ts";

const hex = (data: ArrayBufferLike | Uint8Array): string =>
	Buffer.from(data as ArrayBuffer).toString("hex");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const assets: AssetBundle = new Map([
	["index.html", { body: Buffer.from("<html></html>"), type: "text/html" }],
]);

let base: string;
let root: string;
let ro: string;
let who: { id: string; tier: Tier };
let recorder: ReturnType<typeof recordingLogger>;

function setup(withWorkspace = true) {
	recorder = recordingLogger();
	const visitor = (): Visitor => ({
		principal: { id: who.id, displayName: who.id, disabled: false },
	});
	const api = new AppApi({
		surface: {} as never,
		rooms: {} as never,
		log: {} as never,
		cards: {} as never,
		uploads: {} as never,
		files: {} as never,
		modes: {} as never,
		conversations: {} as never,
		identity: { tierOf: async () => who.tier },
		directory: {} as never,
		team: {} as never,
		avatars: {} as never,
		...(withWorkspace
			? {
					workspace: new WorkspaceFiles({
						roots: [
							{ id: "agents", label: "Agents", dir: root, writable: true },
							{ id: "docs", label: "Docs", dir: ro, writable: false },
						],
						logger: recorder.logger,
					}),
				}
			: {}),
		mount: "/console",
		authMode: "verifier",
		changed: () => undefined,
		logger: recorder.logger,
	});
	return new ConsoleServer({
		mount: "/console",
		assets,
		authenticator: createAuthenticator({
			auth: { mode: "verifier", verifier: () => admit() },
			identify: async () => ({ visitor: visitor() }),
			origin: ORIGIN,
			mount: "/console",
			title: "Console",
			logger: recorder.logger,
			dataDir: "unused",
			listener: { id: "public", address: undefined },
		}),
		api: { handle: async () => new Response("no", { status: 404 }) },
		app: {
			handle: (request, rest, admission) =>
				api.handle(request, rest, admission),
			websocket: {} as never,
		},
		subscribe: () => undefined,
		logger: recorder.logger,
	});
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "rt-workspace-routes-"));
	root = join(base, "root");
	ro = join(base, "ro");
	mkdirSync(root);
	mkdirSync(ro);
	writeFileSync(join(base, "sibling.txt"), "SIBLING");
	writeFileSync(join(ro, "r.txt"), "read only");
	who = { id: "owner", tier: "owner" };
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

const call = (
	server: ConsoleServer,
	method: string,
	path: string,
	init: {
		body?: unknown;
		origin?: string | null;
		raw?: string;
		headers?: Record<string, string>;
	} = {},
) =>
	server.handle(
		new Request(`http://host/console/api/workspace${path}`, {
			method,
			headers: {
				...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }),
				...(init.body !== undefined || init.raw !== undefined
					? { "content-type": "application/json" }
					: {}),
				...init.headers,
			},
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
			...(init.raw !== undefined ? { body: init.raw } : {}),
		}),
	);

describe("the workspace API", () => {
	test("lists the roots by id, label and whether they can be written", async () => {
		const response = await call(setup(), "GET", "");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const view = (await response.json()) as WorkspaceRootsView;
		expect(view.roots).toEqual([
			{ id: "agents", label: "Agents", writable: true },
			{ id: "docs", label: "Docs", writable: false },
		]);
		expect(JSON.stringify(view)).not.toContain(base);
	});

	test("lists, reads, saves and downloads a file", async () => {
		writeFileSync(join(root, "a.ts"), "const a = 1;\n");
		const server = setup();
		const list = (await (
			await call(server, "GET", "/agents/list?path=")
		).json()) as WorkspaceListView;
		expect(list.entries.map((entry) => entry.name)).toEqual(["a.ts"]);
		const view = (await (
			await call(server, "GET", "/agents/file?path=a.ts")
		).json()) as WorkspaceFileView;
		expect(view).toMatchObject({
			text: "const a = 1;\n",
			editable: true,
			language: "typescript",
			hash: sha("const a = 1;\n"),
		});
		const saved = await call(server, "PUT", "/agents/file?path=a.ts", {
			body: { text: "const a = 2;\n", baseHash: view.hash },
		});
		expect(saved.status).toBe(200);
		expect(((await saved.json()) as WorkspaceSaved).hash).toBe(
			sha("const a = 2;\n"),
		);
		expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const a = 2;\n");
		const raw = await call(server, "GET", "/agents/raw?path=a.ts&download=1");
		expect(raw.headers.get("content-disposition")).toStartWith("attachment");
		expect(await raw.text()).toBe("const a = 2;\n");
	});

	test("a media file is served by range and by ETag, and only to an owner", async () => {
		const bytes = Buffer.concat([
			Buffer.from([0, 0, 0, 0x20]),
			Buffer.from("ftypisom"),
			Buffer.alloc(24),
		]);
		writeFileSync(join(root, "clip.mp4"), bytes);
		const server = setup();
		const partial = await call(server, "GET", "/agents/raw?path=clip.mp4", {
			headers: { range: "bytes=0-7" },
		});
		expect(partial.status).toBe(206);
		expect(partial.headers.get("content-type")).toBe("video/mp4");
		expect(partial.headers.get("content-range")).toBe(
			`bytes 0-7/${bytes.length}`,
		);
		expect(hex(await partial.arrayBuffer())).toBe(hex(bytes.subarray(0, 8)));
		const etag = partial.headers.get("etag") ?? "";
		const again = await call(server, "GET", "/agents/raw?path=clip.mp4", {
			headers: { "if-none-match": etag },
		});
		expect(again.status).toBe(304);
		const past = await call(server, "GET", "/agents/raw?path=clip.mp4", {
			headers: { range: "bytes=999-" },
		});
		expect(past.status).toBe(416);
		const outside = await call(server, "GET", "/agents/raw?path=..%2Fx.mp4", {
			headers: { range: "bytes=0-7" },
		});
		expect(outside.status).toBe(400);
	});

	test("a stale save is a 409 that names the file as it is now", async () => {
		writeFileSync(join(root, "a.txt"), "one");
		const server = setup();
		writeFileSync(join(root, "a.txt"), "an agent");
		const response = await call(server, "PUT", "/agents/file?path=a.txt", {
			body: { text: "mine", baseHash: sha("one") },
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as WorkspaceConflict;
		expect(body.conflict).toBe("changed");
		expect(body.current?.hash).toBe(sha("an agent"));
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("an agent");
		const gone = await call(server, "PUT", "/agents/file?path=missing.txt", {
			body: { text: "x", baseHash: sha("") },
		});
		expect(gone.status).toBe(409);
		expect(((await gone.json()) as WorkspaceConflict).conflict).toBe("gone");
	});

	test("a visitor who is not an owner gets 403 for every call, reads included, and nothing changes", async () => {
		writeFileSync(join(root, "a.txt"), "one");
		who = { id: "member", tier: "member" };
		const server = setup();
		for (const [method, path, body] of [
			["GET", "", undefined],
			["GET", "/agents/list?path=", undefined],
			["GET", "/agents/file?path=a.txt", undefined],
			["GET", "/agents/raw?path=a.txt", undefined],
			["GET", "/agents/trash", undefined],
			[
				"PUT",
				"/agents/file?path=a.txt",
				{ text: "pwned", baseHash: sha("one") },
			],
			["POST", "/agents/new?path=b.txt", { kind: "file" }],
			["POST", "/agents/rename", { from: "a.txt", to: "b.txt" }],
			["DELETE", "/agents/entry?path=a.txt", undefined],
		] as const) {
			const response = await call(server, method, path, {
				...(body ? { body } : {}),
			});
			expect([method, path, response.status]).toEqual([method, path, 403]);
		}
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one");
		expect(existsSync(join(root, "b.txt"))).toBe(false);
	});

	test("a change from another origin, or with none, is refused by the console before the API sees it", async () => {
		writeFileSync(join(root, "a.txt"), "one");
		const server = setup();
		for (const origin of ["https://evil.example", null]) {
			const put = await call(server, "PUT", "/agents/file?path=a.txt", {
				origin,
				body: { text: "pwned", baseHash: sha("one") },
			});
			expect(put.status).toBe(403);
			const del = await call(server, "DELETE", "/agents/entry?path=a.txt", {
				origin,
			});
			expect(del.status).toBe(403);
			const made = await call(server, "POST", "/agents/new?path=b.txt", {
				origin,
				body: { kind: "file" },
			});
			expect(made.status).toBe(403);
		}
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one");
		expect(existsSync(join(root, "b.txt"))).toBe(false);
	});

	test("a path that leaves the root is a 400 whatever way it is written, and reaches nothing", async () => {
		symlinkSync(base, join(root, "up"));
		const server = setup();
		for (const query of [
			"path=..%2Fsibling.txt",
			"path=a%2F..%2F..%2Fsibling.txt",
			"path=%2Fetc%2Fpasswd",
			"path=a%00b",
			`path=${"x".repeat(5000)}`,
		]) {
			const response = await call(server, "GET", `/agents/file?${query}`);
			expect([query.slice(0, 30), response.status]).toEqual([
				query.slice(0, 30),
				400,
			]);
			expect(((await response.json()) as WorkspaceRefusalBody).reason).toBe(
				"bad-path",
			);
		}
		// Encoded twice, it is only a name, and there is no such file.
		expect(
			(
				await call(
					server,
					"GET",
					"/agents/file?path=%252e%252e%252fsibling.txt",
				)
			).status,
		).toBe(404);
		// A link out of the root is a 403 with its reason.
		const through = await call(
			server,
			"GET",
			"/agents/file?path=up%2Fsibling.txt",
		);
		expect(through.status).toBe(403);
		expect(((await through.json()) as WorkspaceRefusalBody).reason).toBe(
			"outside",
		);
		// The root in the URL is an id: a path there is just an unknown id.
		expect((await call(server, "GET", "/..%2Froot/list?path=")).status).toBe(
			404,
		);
	});

	test("a read-only root refuses writes with 403", async () => {
		const server = setup();
		const response = await call(server, "PUT", "/docs/file?path=r.txt", {
			body: { text: "x", baseHash: sha("read only") },
		});
		expect(response.status).toBe(403);
		expect(((await response.json()) as WorkspaceRefusalBody).reason).toBe(
			"read-only-root",
		);
		expect(readFileSync(join(ro, "r.txt"), "utf8")).toBe("read only");
	});

	test("a body past twice the edit limit is a 413, and so is a text just past 1 MiB", async () => {
		writeFileSync(join(root, "a.txt"), "one");
		const server = setup();
		const huge = await call(server, "PUT", "/agents/file?path=a.txt", {
			raw: JSON.stringify({
				text: "a".repeat(3 * 1024 * 1024),
				baseHash: sha("one"),
			}),
		});
		expect(huge.status).toBe(413);
		const over = await call(server, "PUT", "/agents/file?path=a.txt", {
			body: { text: "a".repeat(1024 * 1024 + 1), baseHash: sha("one") },
		});
		expect(over.status).toBe(413);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one");
	});

	test("a body that is not a text and a hash is a 400", async () => {
		writeFileSync(join(root, "a.txt"), "one");
		const server = setup();
		for (const body of [
			{ text: 1, baseHash: sha("one") },
			{ text: "x" },
			{ text: "x", baseHash: "nothex" },
		])
			expect(
				(await call(server, "PUT", "/agents/file?path=a.txt", { body })).status,
			).toBe(400);
	});

	test("creates, renames, deletes to the trash, restores and purges", async () => {
		writeFileSync(join(root, "a.txt"), "keep");
		const server = setup();
		const made = await call(server, "POST", "/agents/new?path=b.txt", {
			body: { kind: "file", text: "new" },
		});
		expect(made.status).toBe(201);
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("new");
		const again = await call(server, "POST", "/agents/new?path=b.txt", {
			body: { kind: "file" },
		});
		expect(again.status).toBe(409);
		expect(((await again.json()) as WorkspaceConflict).conflict).toBe("exists");
		expect(
			(
				await call(server, "POST", "/agents/rename", {
					body: { from: "b.txt", to: "c.txt" },
				})
			).status,
		).toBe(200);
		expect(existsSync(join(root, "c.txt"))).toBe(true);
		const removed = await call(server, "DELETE", "/agents/entry?path=a.txt");
		const item = (await removed.json()) as WorkspaceTrashItem;
		expect(existsSync(join(root, "a.txt"))).toBe(false);
		const trash = (await (
			await call(server, "GET", "/agents/trash")
		).json()) as WorkspaceTrashView;
		expect(trash.items.map((entry) => entry.id)).toEqual([item.id]);
		expect(
			(await call(server, "POST", `/agents/trash/${item.id}/restore`)).status,
		).toBe(200);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("keep");
		const second = (await (
			await call(server, "DELETE", "/agents/entry?path=c.txt")
		).json()) as WorkspaceTrashItem;
		expect(
			(await call(server, "DELETE", `/agents/trash/${second.id}`)).status,
		).toBe(200);
		expect(
			(
				(await (
					await call(server, "GET", "/agents/trash")
				).json()) as WorkspaceTrashView
			).items,
		).toEqual([]);
		expect(
			(await call(server, "DELETE", "/agents/trash/not-an-id")).status,
		).toBe(400);
	});

	test("without the pane the API answers 404", async () => {
		const response = await call(setup(false), "GET", "");
		expect(response.status).toBe(404);
	});

	test("an unknown call is a 404 and a wrong method is not a write", async () => {
		writeFileSync(join(root, "a.txt"), "one");
		const server = setup();
		expect((await call(server, "GET", "/agents/nope")).status).toBe(404);
		expect(
			(await call(server, "PATCH", "/agents/file?path=a.txt")).status,
		).toBe(404);
		expect((await call(server, "POST", "")).status).toBe(405);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one");
	});

	test("the call's path parts are decoded once", () => {
		expect(partsOf("api/workspace/agents/file")).toEqual([
			"api",
			"workspace",
			"agents",
			"file",
		]);
	});
});

describe("the workspace options", () => {
	const base = () => ({
		auth: { mode: "none" as const },
		origin: "http://localhost:8080",
	});

	test("the files pane is in the default list, and needs the rooms pane when listed", () => {
		expect(resolveOptions(base()).panes).toContain("workspace");
		expect(resolveOptions(base()).panesGiven).toBe(false);
		expect(() =>
			resolveOptions({ ...base(), panes: ["overview", "workspace"] }),
		).toThrow(/rooms pane/);
		expect(
			resolveOptions({ ...base(), panes: ["rooms", "workspace"] }).panesGiven,
		).toBe(true);
	});

	test("a root of the host's is checked: its id, its directory, and that it is not the data directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "rt-opt-"));
		try {
			const roots = (list: unknown) =>
				resolveOptions({
					...base(),
					dataDir: join(dir, "data"),
					workspace: { roots: list as never },
				});
			expect(
				roots([{ id: "shelf", label: "Shelf", dir: join(dir, "shelf") }])
					.workspace.roots,
			).toEqual([
				{
					id: "shelf",
					label: "Shelf",
					dir: join(dir, "shelf"),
					writable: false,
				},
			]);
			expect(() => roots([{ id: "agents", label: "A", dir: dir }])).toThrow(
				/agents/,
			);
			expect(() => roots([{ id: "x", label: "A", dir: dir }])).toThrow(
				/contains/,
			);
			expect(() =>
				roots([{ id: "x", label: "A", dir: join(dir, "data") }]),
			).toThrow(/data/);
			// Pi's agent directory in its default place holds the credentials.
			expect(() =>
				roots([{ id: "x", label: "A", dir: join(dir, "data", "pi") }]),
			).toThrow(/data/);
			expect(() => roots([{ id: "x", label: " ", dir }])).toThrow(/roots\[0\]/);
			expect(() => roots("nope")).toThrow(/list/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the default pane list leaves out an agents' directory that holds the host's data, and keeps the host's own roots for checkRoots to fail", () => {
		const roots = [
			{ id: "agents", label: "Agents", dir: "/srv", writable: true },
			{ id: "scratch", label: "Scratch", dir: "/srv/scratch", writable: true },
			{ id: "shelf", label: "Shelf", dir: "/srv", writable: false },
		];
		const shown = showableRoots(roots, ["/srv/data"]);
		expect(shown.roots.map((root) => root.id)).toEqual(["scratch", "shelf"]);
		expect(shown.left.map((one) => one.id)).toEqual(["agents"]);
		expect(shown.left[0]?.reason).toContain("contains");
		expect(() => checkRoots(shown.roots, ["/srv/data"])).toThrow(/shelf/);
	});

	test("the agents' directories come first, unless left out, then the host's roots", () => {
		const shelf = { id: "shelf", label: "Shelf", dir: "/srv/shelf" };
		const settings = resolveOptions({
			...base(),
			workspace: { roots: [shelf] },
		});
		const agents = { workDir: "/srv/work", scratchDir: "/srv/scratch" };
		expect(
			workspaceRootsOf(settings, agents).map((root) => [
				root.id,
				root.writable,
			]),
		).toEqual([
			["agents", true],
			["scratch", true],
			["shelf", false],
		]);
		expect(
			workspaceRootsOf(settings, { workDir: "/srv/work" }).map(
				(root) => root.id,
			),
		).toEqual(["agents", "shelf"]);
		const left = resolveOptions({
			...base(),
			workspace: { agents: false, scratch: false },
		});
		expect(workspaceRootsOf(left, agents)).toEqual([]);
		expect(
			workspaceRootsOf(settings, undefined).map((root) => root.id),
		).toEqual(["shelf"]);
	});
});
