import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetBundle } from "./assets.ts";
import { PAGE_COLORS } from "./page-colors.ts";

/** The modern page's background in each scheme, which the browser's toolbar takes (`--bg` in tokens.css). */
export const THEME_COLORS = PAGE_COLORS.modern;

/** The manifest's splash colours under each look; modern keeps the page's own. */
export const LOOK_COLORS = {
	modern: {
		theme: PAGE_COLORS.modern.light,
		background: PAGE_COLORS.modern.light,
	},
	camelot: {
		theme: PAGE_COLORS.camelot.light,
		background: PAGE_COLORS.camelot.dark,
	},
} as const;

/**
 * Applies the stored look and colour scheme before the page paints. It is a file of its own, not
 * an inline script, because the page's policy allows scripts from itself only; the page loads it
 * in the head, where it blocks the first paint for the few bytes it is. It does what `initLook`
 * and `initTheme` do once the bundle runs (`rt-look` and `rt-theme`, in `web/lib`): the device's
 * own look wins over the host's, and the toolbar colour follows the look and the scheme.
 */
export const themeInitScript = (host: "modern" | "camelot"): string =>
	`(function(){try{var C=${JSON.stringify(PAGE_COLORS)};var l=localStorage.getItem("rt-look");if(l!=="modern"&&l!=="camelot")l="${host}";var t=localStorage.getItem("rt-theme");var r=document.documentElement;r.dataset.look=l;var x=t==="light"||t==="dark";if(x)r.dataset.theme=t;var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++){var s=x?t:(m[i].getAttribute("media")||"").indexOf("dark")>-1?"dark":"light";m[i].setAttribute("content",C[l][s])}}catch(e){}})();\n`;

/** The script for a modern host. */
export const THEME_INIT_SCRIPT = themeInitScript("modern");

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
	look?: "modern" | "camelot";
}

/** The web app manifest for a console served under `mount`; its icon URLs are relative to it. */
export function manifestFor(
	mount: string,
	title: string,
	look: "modern" | "camelot" = "modern",
): string {
	const base = `${mount}/`;
	return JSON.stringify({
		id: base,
		start_url: base,
		scope: base,
		name: title,
		short_name: title,
		display: "standalone",
		// A manifest has one colour for the splash; the light page is the one most owners see.
		theme_color: LOOK_COLORS[look].theme,
		background_color: LOOK_COLORS[look].background,
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
		return new Response(
			manifestFor(options.mount, options.title, options.look),
			{
				headers: {
					"content-type": "application/manifest+json;charset=utf-8",
					"cache-control": "no-cache",
				},
			},
		);
	if (rest === "theme-init.js")
		return new Response(themeInitScript(options.look ?? "modern"), {
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
