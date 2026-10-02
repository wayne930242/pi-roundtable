import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** One built file of the page. */
export interface Asset {
	body: Uint8Array;
	type: string;
}

/** The page's files by their path under the mount, `index.html` included. */
export type AssetBundle = ReadonlyMap<string, Asset>;

/** Where `bun run build` leaves the page; the published package ships it ready-made. */
export const BUILT_PAGE_DIR = fileURLToPath(
	new URL("../dist/", import.meta.url),
);

/**
 * Reads the built page into memory. A missing page throws, so a checkout that was never built
 * stops the host at startup instead of serving a blank page.
 */
export function loadAssets(dir: string = BUILT_PAGE_DIR): AssetBundle {
	let entries: ReturnType<typeof listFiles>;
	try {
		entries = listFiles(dir);
	} catch {
		throw new Error(
			`the console page is not built: ${dir} does not exist. Run \`bun run build\` in the package, or install the published package, which ships it built.`,
		);
	}
	const assets = new Map<string, Asset>();
	for (const path of entries)
		assets.set(relative(dir, path).split(sep).join("/"), {
			body: readFileSync(path),
			type: Bun.file(path).type,
		});
	if (!assets.has("index.html"))
		throw new Error(`the console page is not built: ${dir} has no index.html`);
	return assets;
}

function listFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}
