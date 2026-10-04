import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export type FindingKind = "ipv4" | "snowflake" | "credential" | "name" | "cjk";
export interface Finding {
	file: string;
	line: number;
	kind: FindingKind;
	text: string;
}

/** Per-file allowed name spellings, limited to the name detector only. */
export type NameAllowlist = Readonly<Record<string, readonly string[]>>;

const allowedNames = (
	allow: NameAllowlist,
	file: string,
): readonly string[] => [
	...(allow[file] ?? []),
	...Object.entries(allow).flatMap(([key, names]) =>
		key.endsWith("/") && file.startsWith(key) ? names : [],
	),
];

/** Detector patterns are written in pieces so this file does not itself contain the names it detects. */
const spell = (...pieces: string[]): string => pieces.join("");

const OWNER_HANDLE = spell("way", "ne930242");

// Attribution and repository metadata are the only public uses of the owner's GitHub handle.
// The site names the repository in its links and the owner's domain, which starts with the owner's first name.
// The lockfile lists a dependency's own registry name, which a transitive dependency spells with one of the names below.
export const PUBLIC_NAME_ALLOWLIST: NameAllowlist = {
	LICENSE: [OWNER_HANDLE],
	"package.json": [OWNER_HANDLE, spell("way", "ne"), spell("j", "ev")],
	"site/astro.config.mjs": [OWNER_HANDLE, spell("way", "ne")],
	"CHANGELOG.md": [spell("way", "ne"), spell("j", "ev")],
	"site/public/CNAME": [spell("way", "ne")],
	"site/public/robots.txt": [spell("way", "ne")],
	// A key ending in "/" covers every file below that directory: documentation pages link to the repository,
	// and the page on pi-roundtable-mcp names the public MCP gateway that package works with.
	"site/src/content/docs/": [OWNER_HANDLE, spell("context", "forge")],
	// The READMEs say which gateway the connectors need, and link the repository and the site.
	"README.md": [OWNER_HANDLE, spell("way", "ne"), spell("context", "forge")],
	"README.zh-TW.md": [
		OWNER_HANDLE,
		spell("way", "ne"),
		spell("context", "forge"),
	],
	"bun.lock": [spell("type", "safe"), spell("j", "ev")],
	".github/PACKAGE-RELEASES.md": [OWNER_HANDLE],
	// Workspace metadata keeps the same public attribution as the root package.
	...Object.fromEntries(
		["drawing", "coding", "web", "sandbox", "mcp"].flatMap((name) =>
			["LICENSE", "README.md", "package.json"].map((file) => [
				`packages/${name}/${file}`,
				// The sandbox README points to the kit's compactor for the judging service.
				name === "sandbox" && file === "README.md"
					? [OWNER_HANDLE, spell("j", "ev")]
					: [OWNER_HANDLE],
			]),
		),
	),
	// The imported MCP API publicly integrates with IBM's gateway. Only these files
	// name it; no owner/persona names, credentials, or other detectors are exempted.
	...Object.fromEntries(
		[
			"CHANGELOG.md",
			"README.md",
			"package.json",
			"examples/roundtable.config.ts",
			"src/index.ts",
			"src/plugins.test.ts",
			`src/testing/fake-${spell("context", "forge")}.ts`,
			"src/connectors/connector-commands.ts",
			"src/connectors/connector-registry.ts",
			"src/connectors/connector-registry.test.ts",
			"src/connectors/connectors-plugin.ts",
			"src/connectors/connectors-plugin.test.ts",
			`src/connectors/${spell("context", "forge")}.ts`,
			`src/connectors/${spell("context", "forge")}.test.ts`,
			"src/connectors/messages.ts",
		].map((file) => [
			`packages/mcp/${file}`,
			[
				spell("context", "forge"),
				...(["README.md", "package.json"].includes(file) ? [OWNER_HANDLE] : []),
			],
		]),
	),
	// The guide names its one private consumer, links public workspace READMEs, and documents the judging service's compactor.
	"docs/plugins.md": [spell("Mer", "lin"), OWNER_HANDLE, spell("j", "ev")],
	// The kit's compactor for the judging service depends on that service's public npm compaction package and is named after it;
	// only these files, the root package.json, bun.lock and CHANGELOG.md name it, and its test answers in the package's own answer type.
	...Object.fromEntries(
		[
			"src/kit/index.ts",
			`src/kit/${spell("j", "ev")}.ts`,
			"scripts/entries.exports.json",
			"scripts/public-api.report.json",
			"packages/sandbox/CHANGELOG.md",
			`packages/sandbox/src/${spell("j", "ev")}-compactor.test.ts`,
		].map((file) => [file, [spell("j", "ev")]]),
	),
	[`src/kit/${spell("j", "ev")}.test.ts`]: [
		spell("j", "ev"),
		spell("no", "ul"),
		// Its public compaction package names this service in its environment key.
		spell("type", "safe"),
	],
};

/**
 * The private consumer's names and its services, the owner, and the fixtures that named real
 * people and repositories. Alternatives are tried in order, so the owner's handle is matched whole
 * before the bare first name, and the allowlist compares whole matches.
 */
const NAMES = new RegExp(
	[
		spell("mer", "lin"),
		spell("wei-?", "hung"),
		OWNER_HANDLE,
		spell("way", "ne"),
		spell("type", "safe"),
		// The judging service's name as a word or a camelCase head, not inside another word such as a city's name.
		spell("(?<![a-z])", "j", "ev"),
		spell("phoe", "nix"),
		spell("context", "forge"),
		spell("no", "ul"),
		spell("aaa", "av"),
		// The name is split across two pieces so this file does not contain it.
		spell("\\bmel", "ody\\b"),
	].join("|"),
	"gi",
);
/** The judging service's name at the end of a camelCase word, which the case-blind pattern above cannot tell from a city. */
const CAMEL_NAMES = new RegExp(spell("(?<=[a-z])J", "ev(?![a-z])"), "g");
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const SNOWFLAKE = /(?<!\d)\d{17,20}(?!\d)/g;
const CREDENTIALS = [
	/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
	/\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/g,
	/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/-]{30,}/gi,
	/\b(?:secret|token|key|password)\w*\s*[:=]\s*["']?[a-fA-F0-9]{40,}["']?/gi,
];

/** Where Chinese text is written: the message catalogs, the translated README, and the site's zh-TW pages and their language label. */
const CJK_DIRECTORIES = [
	"src/core/i18n/",
	"src/i18n/",
	"site/src/content/docs/zh-tw/",
];
const CJK_FILES = ["README.zh-TW.md", "site/astro.config.mjs"];

// pi-lens-ignore: high-complexity — one flat list of the documentation and private address ranges a public tree may name
function allowedIp(ip: string): boolean {
	const octets = ip.split(".").map(Number);
	const [a, b, c] = octets;
	if (octets.some((n) => n > 255)) return true; // Not an IPv4 address.
	return (
		ip === "127.0.0.1" ||
		ip === "0.0.0.0" ||
		a === 10 ||
		(a === 172 && b !== undefined && b >= 16 && b <= 31) ||
		(a === 192 && (b === 168 || (b === 0 && c === 2))) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113)
	);
}

function tree(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if ([".git", "node_modules"].includes(entry.name)) return [];
		const path = join(dir, entry.name);
		return entry.isDirectory() ? tree(path) : [path];
	});
}

/** Inspect exported text; credential matches are truncated so reporting does not leak them. */
// pi-lens-ignore: high-complexity, high-fan-out — one pass that runs every detector over each line, so the findings come out in file and line order
export function scanTree(
	dir: string,
	allowNames: NameAllowlist = PUBLIC_NAME_ALLOWLIST,
): Finding[] {
	const root = resolve(dir);
	const findings: Finding[] = [];
	for (const path of tree(root)) {
		const file = relative(root, path).split(sep).join("/");
		const bytes = readFileSync(path);
		if (bytes.includes(0)) continue;
		const lines = bytes.toString("utf8").split("\n");
		for (const [index, line] of lines.entries()) {
			const add = (kind: FindingKind, text: string) =>
				findings.push({
					file,
					line: index + 1,
					kind,
					text: kind === "credential" ? `${text.slice(0, 8)}…` : text,
				});
			for (const match of line.matchAll(IPV4))
				if (match[0] && !allowedIp(match[0])) add("ipv4", match[0]);
			for (const match of line.matchAll(SNOWFLAKE))
				if (
					match[0] &&
					!match[0].startsWith("9") &&
					!/(\d)\1{5}/.test(match[0])
				)
					add("snowflake", match[0]);
			for (const pattern of CREDENTIALS)
				for (const match of line.matchAll(pattern))
					if (match[0]) add("credential", match[0]);
			for (const match of [
				...line.matchAll(NAMES),
				...line.matchAll(CAMEL_NAMES),
			])
				if (
					match[0] &&
					!allowedNames(allowNames, file).some(
						(allowed) => allowed.toLowerCase() === match[0]?.toLowerCase(),
					)
				)
					add("name", match[0]);
			if (
				!CJK_DIRECTORIES.some((directory) => file.startsWith(directory)) &&
				!CJK_FILES.includes(file)
			)
				for (const match of line.matchAll(/[\u4e00-\u9fff]+/g))
					if (match[0]) add("cjk", match[0]);
		}
	}
	return findings;
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (!dir) throw new Error("Usage: bun scripts/scan-public.ts <exportedDir>");
	const findings = scanTree(dir);
	for (const finding of findings)
		console.log(
			`${finding.file}:${finding.line} ${finding.kind}: ${finding.text}`,
		);
	console.log(`${findings.length} finding(s)`);
	if (findings.length) process.exitCode = 1;
}
