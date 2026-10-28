import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetBundle } from "./assets.ts";

/** The page's background in each scheme, which the browser's toolbar takes (these are `--bg` in tokens.css). */
export const THEME_COLORS = { light: "#f5f6f8", dark: "#0f1115" } as const;

/**
 * Applies the stored colour scheme before the page paints. It is a file of its own, not an inline
 * script, because the page's policy allows scripts from itself only; the page loads it in the
 * head, where it blocks the first paint for the few bytes it is. It does what `initTheme` does
 * once the bundle runs (`rt-theme` in `web/lib/theme.ts`), and the toolbar colour follows.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("rt-theme");if(t!=="light"&&t!=="dark")return;document.documentElement.dataset.theme=t;var c={light:"${THEME_COLORS.light}",dark:"${THEME_COLORS.dark}"}[t];var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++)m[i].setAttribute("content",c)}catch(e){}})();\n`;

/** The icons this package ships, which `options.icons.dir` replaces. */
export const DEFAULT_ICONS_DIR = fileURLToPath(
	new URL("../assets/icons/", import.meta.url),
);

const ICON_FILE = /^[A-Za-z0-9-]+\.png$/;

export interface PwaOptions {
	mount: string;
	title: string;
	assets: AssetBundle;
	iconsDir?: string;
}

/** The web app manifest for a console served under `mount`; its icon URLs are relative to it. */
export function manifestFor(mount: string, title: string): string {
	const base = `${mount}/`;
	return JSON.stringify({
		id: base,
		start_url: base,
		scope: base,
		name: title,
		short_name: title,
		display: "standalone",
		// A manifest has one colour for the splash; the light page is the one most owners see.
		theme_color: THEME_COLORS.light,
		background_color: THEME_COLORS.light,
		icons: [
			{ src: "icons/192.png", sizes: "192x192", type: "image/png" },
			{ src: "icons/512.png", sizes: "512x512", type: "image/png" },
			{
				src: "icons/maskable-512.png",
				sizes: "512x512",
				type: "image/png",
				purpose: "maskable",
			},
		],
	});
}

/**
 * The installability files under the mount: the manifest, the service worker and the icons. A
 * path that is none of them returns undefined. The caller has already admitted the request.
 */
export function servePwa(
	rest: string,
	options: PwaOptions,
): Response | undefined {
	if (rest === "manifest.webmanifest")
		return new Response(manifestFor(options.mount, options.title), {
			headers: {
				"content-type": "application/manifest+json;charset=utf-8",
				"cache-control": "no-cache",
			},
		});
	if (rest === "theme-init.js")
		return new Response(THEME_INIT_SCRIPT, {
			headers: {
				"content-type": "text/javascript;charset=utf-8",
				"cache-control": "no-cache",
			},
		});
	if (rest === "sw.js") {
		const worker = options.assets.get("sw.js");
		if (!worker) return undefined;
		return new Response(new Uint8Array(worker.body), {
			headers: {
				"content-type": "text/javascript;charset=utf-8",
				"cache-control": "no-cache",
			},
		});
	}
	if (rest.startsWith("icons/")) {
		const name = rest.slice("icons/".length);
		if (!ICON_FILE.test(name) || basename(name) !== name) return undefined;
		try {
			const body = readFileSync(
				join(options.iconsDir ?? DEFAULT_ICONS_DIR, name),
			);
			return new Response(new Uint8Array(body), {
				headers: {
					"content-type": "image/png",
					"cache-control": "private, max-age=86400",
				},
			});
		} catch {
			return undefined;
		}
	}
	return undefined;
}
