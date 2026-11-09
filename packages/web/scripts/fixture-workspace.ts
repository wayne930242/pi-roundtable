import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What the agents left in their workspace, for the files pane: code in several languages, a file with
// Windows line endings, a binary one, a large one, a repository's `.git`, and a link out of the workspace.
export function seedWorkspace(workDir: string): void {
	const put = (path: string, text: string) => {
		mkdirSync(join(workDir, path, ".."), { recursive: true });
		writeFileSync(join(workDir, path), text);
	};
	put(
		"README.md",
		"# Field notes\n\nThe agents keep their work here.\n\n- `src/` the scout's code\n- `notes/` what the archivist wrote down\n\n```ts\nconst answer = 42;\n```\n",
	);
	put(
		"src/main.ts",
		`import { readFile } from "node:fs/promises";

/** Counts the words of a file, ignoring blank lines. */
export async function words(path: string): Promise<number> {
	const text = await readFile(path, "utf8");
	return text.split(/\\s+/).filter(Boolean).length; // "quoted" 12_000
}

export const GREETING = \`hello \${"world"}\`;
`,
	);
	put(
		"src/report.py",
		`from dataclasses import dataclass


@dataclass
class Finding:
    title: str
    severity: int = 3  # 1 is worst


def worst(findings: list[Finding]) -> Finding | None:
    """The most severe finding, or None."""
    return min(findings, key=lambda f: f.severity, default=None)
`,
	);
	put(
		"deploy/stack.yml",
		'services:\n  web:\n    image: ghcr.io/example/web:1.4.0\n    ports: ["8080:80"]\n    environment:\n      MODE: production # not a secret\n',
	);
	put("notes/windows.txt", "line one\r\nline two\r\nno final newline");
	put(
		"config/settings.json",
		'{\n  "retries": 3,\n  "tags": ["a", "b"],\n  "debug": false\n}\n',
	);
	put("data/blob.bin", "\u0000\u0001binary\u0000");
	put("logs/big.log", "x".repeat(100));
	truncateSync(join(workDir, "logs/big.log"), 3 * 1024 * 1024);
	put("repo/.git/config", "[core]\n\trepositoryformatversion = 0\n");
	put("repo/readme.txt", "a repository");
	symlinkSync("/etc/hosts", join(workDir, "outside-link"));
}
