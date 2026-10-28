import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scan = (pattern: string) =>
	[...new Bun.Glob(pattern).scanSync({ cwd: root })].sort();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const markdown = [
	"README.md",
	"README.zh-TW.md",
	"CHANGELOG.md",
	".github/PACKAGE-RELEASES.md",
	...scan("docs/*.md"),
	...scan("packages/*/README.md"),
	...scan("packages/*/CHANGELOG.md"),
];
const pages = scan("site/src/content/docs/**/*.mdx");

/** The text of a file without its fenced code, whose brackets are not links. */
function prose(text: string): string {
	let fenced = false;
	return text
		.split("\n")
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				fenced = !fenced;
				return "";
			}
			return fenced ? "" : line;
		})
		.join("\n");
}

/** The anchors a document offers: its headings, slugged as GitHub and Starlight slug them. */
function anchors(text: string): Set<string> {
	const seen = new Map<string, number>();
	const out = new Set<string>();
	for (const match of prose(text).matchAll(
		/<(?:span|a|div)[^>]*\bid="([^"]+)"/g,
	))
		out.add(match[1] ?? "");
	for (const line of prose(text).split("\n")) {
		const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
		if (!heading) continue;
		const slug = (heading[1] ?? "")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/[`*_]/g, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s-]/gu, "")
			.trim()
			.replace(/\s/g, "-");
		const count = seen.get(slug) ?? 0;
		seen.set(slug, count + 1);
		out.add(count === 0 ? slug : `${slug}-${count}`);
	}
	return out;
}

interface Link {
	line: number;
	target: string;
}

function links(text: string): Link[] {
	const out: Link[] = [];
	prose(text)
		.split("\n")
		.forEach((line, index) => {
			for (const match of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g))
				out.push({ line: index + 1, target: match[1] ?? "" });
			const definition = /^\[[^\]]+\]:\s+(\S+)/.exec(line);
			if (definition)
				out.push({ line: index + 1, target: definition[1] ?? "" });
		});
	return out.filter((link) => !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(link.target));
}

test("every relative link in a Markdown doc reaches a file and a heading", () => {
	const broken: string[] = [];
	for (const file of markdown) {
		const text = read(file);
		for (const { line, target } of links(text)) {
			const [path = "", anchor] = target.split("#");
			const destination = path === "" ? file : resolve(dirname(file), path);
			const absolute = resolve(root, destination);
			if (!existsSync(absolute)) {
				broken.push(`${file}:${line} ${target} (no such file)`);
				continue;
			}
			if (anchor !== undefined && /\.md$/.test(absolute)) {
				const offered = anchors(
					path === "" ? text : readFileSync(absolute, "utf8"),
				);
				if (!offered.has(decodeURIComponent(anchor)))
					broken.push(`${file}:${line} ${target} (no such heading)`);
			}
		}
	}
	expect(broken).toEqual([]);
});

test("every site link reaches a page and a heading", () => {
	const known = new Map(
		pages.map((file) => [
			file
				.replace(/^site\/src\/content\/docs/, "")
				.replace(/(\/index)?\.mdx$/, "/")
				.replace(/^$/, "/"),
			file,
		]),
	);
	const broken: string[] = [];
	for (const file of pages) {
		const text = read(file);
		for (const { line, target } of links(text)) {
			const [path = "", anchor] = target.split("#");
			let page = file;
			if (path !== "") {
				if (!path.startsWith("/")) {
					broken.push(`${file}:${line} ${target} (not a site path)`);
					continue;
				}
				const found = known.get(path.endsWith("/") ? path : `${path}/`);
				if (!found) {
					if (existsSync(resolve(root, "site/public", path.slice(1)))) continue;
					broken.push(`${file}:${line} ${target} (no such page)`);
					continue;
				}
				page = found;
			}
			if (anchor !== undefined && !anchors(read(page)).has(anchor))
				broken.push(`${file}:${line} ${target} (no such heading)`);
		}
	}
	expect(broken).toEqual([]);
});
