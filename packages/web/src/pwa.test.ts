import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingLogger } from "pi-roundtable/testing";
import { buildPage } from "../scripts/build-page.ts";
import { type AssetBundle, loadAssets } from "./assets.ts";
import { createAuthenticator } from "./auth/authenticator.ts";
import { ConsoleServer } from "./console-server.ts";
import { DEFAULT_ICONS_DIR } from "./pwa.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import { admit, refuse } from "./verifier.ts";

const built = mkdtempSync(join(tmpdir(), "web-pwa-build-"));
await buildPage(built);
const real = loadAssets(built);

function serverOver(
	assets: AssetBundle,
	allow = true,
	iconsDir?: string,
): ConsoleServer {
	const { logger } = recordingLogger();
	return new ConsoleServer({
		mount: "/app",
		title: "Team",
		assets,
		...(iconsDir ? { iconsDir } : {}),
		authenticator: createAuthenticator({
			auth: {
				mode: "verifier",
				verifier: () => (allow ? admit() : refuse("no")),
			},
			identify: async () => ({
				visitor: {
					principal: { id: "owner", displayName: "Owner", disabled: false },
				},
			}),
			origin: ORIGIN,
			mount: "/app",
			title: "Team",
			logger,
			dataDir: "unused",
			listener: { id: "public", address: undefined },
		}),
		api: { handle: async () => Response.json({}) },
		subscribe: () => {},
		logger,
	});
}

const get = (server: ConsoleServer, path: string) =>
	server.handle(new Request(`http://localhost${path}`));

test("the manifest scopes the app to its mount and is named by the title", async () => {
	const response = await get(serverOver(real), "/app/manifest.webmanifest");
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("manifest+json");
	const manifest = (await response.json()) as {
		icons: { sizes: string; purpose?: string }[];
	};
	expect(manifest).toMatchObject({
		id: "/app/",
		start_url: "/app/",
		scope: "/app/",
		display: "standalone",
		name: "Team",
	});
	const sizes = manifest.icons.map((icon) => icon.sizes);
	expect(sizes).toContain("192x192");
	expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
});

test("sw.js is served no-cache as JavaScript, while hashed files stay immutable", async () => {
	const server = serverOver(real);
	const worker = await get(server, "/app/sw.js");
	expect(worker.status).toBe(200);
	expect(worker.headers.get("cache-control")).toBe("no-cache");
	expect(worker.headers.get("content-type")).toContain("javascript");
	const hashed = [...real.keys()].find(
		(name) => name.endsWith(".js") && name !== "sw.js",
	);
	const asset = await get(server, `/app/${hashed}`);
	expect(asset.headers.get("cache-control")).toContain("immutable");
});

test("the manifest, worker and icons sit behind the authenticator", async () => {
	const server = serverOver(real, false);
	for (const path of ["manifest.webmanifest", "sw.js", "icons/192.png"])
		expect((await get(server, `/app/${path}`)).status).toBe(403);
});

test("icons come from the shipped directory, or from options.icons.dir", async () => {
	const shipped = await get(serverOver(real), "/app/icons/192.png");
	expect(shipped.status).toBe(200);
	expect(shipped.headers.get("content-type")).toBe("image/png");
	expect(new Uint8Array(await shipped.arrayBuffer())).toEqual(
		new Uint8Array(readFileSync(join(DEFAULT_ICONS_DIR, "192.png"))),
	);
	const custom = mkdtempSync(join(tmpdir(), "web-pwa-icons-"));
	writeFileSync(join(custom, "192.png"), "mine");
	const overridden = await get(
		serverOver(real, true, custom),
		"/app/icons/192.png",
	);
	expect(await overridden.text()).toBe("mine");
	expect((await get(serverOver(real), "/app/icons/..%2Fx.png")).status).toBe(
		404,
	);
	expect((await get(serverOver(real), "/app/icons/nope.png")).status).toBe(404);
});

test("the built worker precaches index.html and hashed files only, and bypasses private paths", () => {
	const text = readFileSync(join(built, "sw.js"), "utf8");
	const list = JSON.parse(
		/\[("index\.html"[^\]]*)\]/.exec(
			`[${/\["index\.html"[^\]]*\]/.exec(text)?.[0].slice(1)}`,
		)?.[0] ?? "[]",
	) as string[];
	expect(list[0]).toBe("index.html");
	expect(list.length).toBeGreaterThan(2);
	for (const file of list.slice(1))
		expect(file).toMatch(/-[a-z0-9]{6,}\.[a-z0-9]+$/);
	for (const prefix of ["api/", "auth/", "login", "files/", "avatars/"])
		expect(text).toContain(`"${prefix}"`);
	expect(text).toContain("navigate");
});
