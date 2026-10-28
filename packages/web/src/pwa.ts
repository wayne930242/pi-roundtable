import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetBundle } from "./assets.ts";

/** The browser toolbar and splash colours, matching the console's dark header. */
export const THEME_COLOR = "#1f2937";

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
		theme_color: THEME_COLOR,
		background_color: THEME_COLOR,
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
