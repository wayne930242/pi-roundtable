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
	look?: "modern" | "camelot",
	extra: Partial<ConstructorParameters<typeof ConsoleServer>[0]> = {},
): ConsoleServer {
	const { logger } = recordingLogger();
	return new ConsoleServer({
		mount: "/app",
		title: "Team",
		assets,
		...(iconsDir ? { iconsDir } : {}),
		...(look ? { look } : {}),
		...extra,
		authenticator: createAuthenticator({
			auth: {
				mode: "verifier",
				verifier: () => (allow ? admit() : refuse("no")),
			},
			identify: async () => ({
				visitor: {
					principal: { id: "owner", displayName: "Owner", disabled: false },
					tier: "owner",
					speakerId: "owner",
					roles: [],
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

const get = (server: ConsoleServer, path: string, init?: RequestInit) =>
	server.handle(new Request(`http://localhost${path}`, init));

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

test("the manifest and the icons answer without a session; the worker and the page do not", async () => {
	const server = serverOver(real, false);
	for (const path of [
		"manifest.webmanifest",
		"icons/192.png",
		"icons/512.png",
		"icons/mark.svg",
	]) {
		const answer = await get(server, `/app/${path}`);
		expect({ path, status: answer.status }).toEqual({ path, status: 200 });
		expect(answer.headers.get("set-cookie")).toBeNull();
	}
	const mark = await get(server, "/app/icons/mark.svg");
	expect(mark.headers.get("content-type")).toBe("image/svg+xml");
	expect(mark.headers.get("content-security-policy")).toContain(
		"default-src 'none'",
	);
	for (const path of ["sw.js", "theme-init.js", "", "index.html"])
		expect({
			path,
			status: (await get(server, `/app/${path}`)).status,
		}).toEqual({ path, status: 403 });
	// A name that is no icon is not a way around the session either.
	for (const path of ["icons/nope.png", "icons/..%2Fx.png", "icons/a.txt"])
		expect({
			path,
			status: (await get(server, `/app/${path}`)).status,
		}).toEqual({ path, status: 403 });
	const write = await get(server, "/app/icons/192.png", { method: "POST" });
	expect(write.status).toBe(403);
});

test("only the icons the page links answer without a session: another file of a host's icon directory stays behind it", async () => {
	const custom = mkdtempSync(join(tmpdir(), "web-pwa-public-icons-"));
	const png = readFileSync(join(DEFAULT_ICONS_DIR, "192.png"));
	writeFileSync(join(custom, "192.png"), png);
	writeFileSync(join(custom, "team-photo.png"), png);
	const out = serverOver(real, false, custom);
	expect((await get(out, "/app/icons/192.png")).status).toBe(200);
	expect((await get(out, "/app/icons/team-photo.png")).status).toBe(403);
	const signedIn = serverOver(real, true, custom);
	expect((await get(signedIn, "/app/icons/team-photo.png")).status).toBe(200);
});

test("the served page names the round-table mark as its icon, and carries a title, a description and a link preview", async () => {
	const server = serverOver(real, true, undefined, undefined, {
		origin: "https://rt.example.test",
	});
	const html = await (await get(server, "/app/")).text();
	expect(html).toContain(
		'<link rel="icon" href="/app/icons/mark.svg" type="image/svg+xml" sizes="any">',
	);
	expect(html).toContain(
		'<link rel="icon" href="/app/icons/192.png" type="image/png">',
	);
	expect(html).toContain("<title>Team</title>");
	expect(html).not.toContain("<title>Console</title>");
	expect(html).toContain(
		'<meta name="description" content="Chat with your agent team in Team.">',
	);
	expect(html).toContain('<meta property="og:title" content="Team">');
	expect(html).toContain(
		'<meta property="og:image" content="https://rt.example.test/app/icons/512.png">',
	);
});

test("a host's title and description are escaped where they land, and its own icons keep the tab", async () => {
	const custom = mkdtempSync(join(tmpdir(), "web-pwa-own-icons-"));
	for (const name of ["192.png", "512.png"])
		writeFileSync(join(custom, name), "x");
	const server = serverOver(real, true, custom, undefined, {
		title: '</title><script>alert(1)</script>"',
		description: 'a "quote" & <b>',
		origin: "https://rt.example.test",
	});
	const html = await (await get(server, "/app/")).text();
	expect(html).toContain(
		"<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;</title>",
	);
	expect(html).toContain('content="a &quot;quote&quot; &amp; &lt;b&gt;"');
	expect(html).not.toContain("<script>alert(1)");
	// The directory has no mark.svg, so only its PNG is linked; the host's PNG is what answers.
	expect(html).not.toContain("mark.svg");
	expect(html).toContain('href="/app/icons/192.png"');
	expect((await get(server, "/app/icons/192.png")).status).toBe(200);
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

test("the built worker leaves the round table's WebGL chunk out of the precache and caches it when it is fetched", () => {
	const text = readFileSync(join(built, "sw.js"), "utf8");
	const list = /\["index\.html"[^\]]*\]/.exec(text)?.[0] ?? "";
	expect(list).toContain("chunk-table2d-");
	expect(list).not.toContain("chunk-table3d-");
	expect(text).toContain("chunk-table3d-");
	expect(text).toContain('"api/"');
});

test("the built worker leaves the files pane's editor out of the precache, and nothing precached carries it", () => {
	const text = readFileSync(join(built, "sw.js"), "utf8");
	const list = JSON.parse(
		/\["index\.html"[^\]]*\]/.exec(text)?.[0] ?? "[]",
	) as string[];
	expect(list.length).toBeGreaterThan(2);
	for (const file of list) {
		expect(file).not.toMatch(/^chunk-(codeeditor|lang-[a-z]+)-/);
		if (file.endsWith(".js"))
			expect(readFileSync(join(built, file), "utf8")).not.toContain(
				"cm-scroller",
			);
	}
	expect(text).toContain("codeeditor");
});

test("the page names a theme colour for each scheme and loads the stored scheme before it paints", async () => {
	const { presentPage } = await import("./page-presentation.ts");
	const html = String(
		presentPage(
			new TextEncoder().encode("<html><head></head></html>"),
			"/app",
			undefined,
		),
	);
	expect(html).toContain(
		'content="#f5f6f8" media="(prefers-color-scheme: light)"',
	);
	expect(html).toContain(
		'content="#0f1115" media="(prefers-color-scheme: dark)"',
	);
	// A script of the page's own origin, after the base so it resolves under the mount.
	expect(html).toContain('<script src="./theme-init.js"></script>');
	expect(html.indexOf("<base")).toBeLessThan(html.indexOf("theme-init.js"));
	const response = await get(serverOver(real), "/app/theme-init.js");
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("javascript");
	const manifest = (await (
		await get(serverOver(real), "/app/manifest.webmanifest")
	).json()) as { theme_color: string; background_color: string };
	expect(manifest.background_color).toBe("#f5f6f8");
	expect(manifest.theme_color).toBe("#f5f6f8");
});

test("the pre-paint script sets an explicit scheme and its toolbar colours, and leaves a system choice to the page", async () => {
	const { THEME_INIT_SCRIPT } = await import("./pwa.ts");
	const run = (stored: string | null) => {
		const metas = [
			{ content: "#f5f6f8", media: "(prefers-color-scheme: light)" },
			{ content: "#0f1115", media: "(prefers-color-scheme: dark)" },
		].map((meta) => ({
			...meta,
			getAttribute(_name: string) {
				return this.media;
			},
			setAttribute(_name: string, value: string) {
				this.content = value;
			},
		}));
		const root = { dataset: {} as Record<string, string> };
		new Function("localStorage", "document", THEME_INIT_SCRIPT)(
			{ getItem: (key: string) => (key === "rt-theme" ? stored : null) },
			{
				documentElement: root,
				querySelectorAll: () => metas,
			},
		);
		return {
			theme: root.dataset.theme,
			colours: metas.map((meta) => meta.content),
		};
	};
	expect(run("dark")).toEqual({
		theme: "dark",
		colours: ["#0f1115", "#0f1115"],
	});
	expect(run("light")).toEqual({
		theme: "light",
		colours: ["#f5f6f8", "#f5f6f8"],
	});
	for (const stored of [null, "system", "junk"])
		expect(run(stored)).toEqual({
			theme: undefined,
			colours: ["#f5f6f8", "#0f1115"],
		});
	// Storage that throws changes nothing and throws nothing.
	expect(() =>
		new Function("localStorage", "document", THEME_INIT_SCRIPT)(
			{
				getItem: () => {
					throw new Error("off");
				},
			},
			{},
		),
	).not.toThrow();
});

test("appearance.look camelot changes the manifest colours", async () => {
	const manifest = (await (
		await get(
			serverOver(real, true, undefined, "camelot"),
			"/app/manifest.webmanifest",
		)
	).json()) as { theme_color: string; background_color: string };
	expect(manifest.theme_color).toBe("#f4ead5");
	expect(manifest.background_color).toBe("#0f1726");
});

test("under camelot the page names the look's toolbar colours, and the pre-paint script puts on the look and its colours", async () => {
	const { presentPage } = await import("./page-presentation.ts");
	const { themeInitScript } = await import("./pwa.ts");
	const html = String(
		presentPage(
			new TextEncoder().encode("<html><head></head></html>"),
			"/app",
			undefined,
			"camelot",
		),
	);
	expect(html).toContain(
		'content="#f4ead5" media="(prefers-color-scheme: light)"',
	);
	expect(html).toContain(
		'content="#0f1726" media="(prefers-color-scheme: dark)"',
	);
	const run = (
		host: "modern" | "camelot",
		stored: { theme?: string; look?: string },
	) => {
		const metas = ["light", "dark"].map((scheme) => ({
			content: "",
			getAttribute: () => `(prefers-color-scheme: ${scheme})`,
			setAttribute(_name: string, value: string) {
				this.content = value;
			},
		}));
		const root = { dataset: {} as Record<string, string> };
		new Function("localStorage", "document", themeInitScript(host))(
			{
				getItem: (key: string) =>
					(key === "rt-theme" ? stored.theme : stored.look) ?? null,
			},
			{ documentElement: root, querySelectorAll: () => metas },
		);
		return {
			look: root.dataset.look,
			theme: root.dataset.theme,
			colours: metas.map((meta) => meta.content),
		};
	};
	// The host's look, until the device picked its own.
	expect(run("camelot", {})).toEqual({
		look: "camelot",
		theme: undefined,
		colours: ["#f4ead5", "#0f1726"],
	});
	expect(run("camelot", { look: "modern" })).toEqual({
		look: "modern",
		theme: undefined,
		colours: ["#f5f6f8", "#0f1115"],
	});
	expect(run("modern", { look: "camelot", theme: "dark" })).toEqual({
		look: "camelot",
		theme: "dark",
		colours: ["#0f1726", "#0f1726"],
	});
	expect(run("camelot", { theme: "light", look: "junk" })).toEqual({
		look: "camelot",
		theme: "light",
		colours: ["#f4ead5", "#f4ead5"],
	});
});
