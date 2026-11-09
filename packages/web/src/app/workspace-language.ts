import type { WorkspaceLanguage } from "../api-types.ts";

const BY_EXTENSION: Record<string, WorkspaceLanguage> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "json",
	json5: "json",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	css: "css",
	scss: "css",
	html: "html",
	htm: "html",
	py: "python",
	pyi: "python",
	yml: "yaml",
	yaml: "yaml",
	go: "go",
	rs: "rust",
	sql: "sql",
	xml: "xml",
	svg: "xml",
	plist: "xml",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	toml: "toml",
};

const BY_NAME: Record<string, WorkspaceLanguage> = {
	dockerfile: "dockerfile",
	containerfile: "dockerfile",
	".bashrc": "shell",
	".zshrc": "shell",
	".profile": "shell",
	".bash_profile": "shell",
	".gitignore": "plain",
};

/** The language to highlight a file in, from its name. */
export function languageOf(name: string): WorkspaceLanguage {
	const lower = name.toLowerCase();
	const byName = BY_NAME[lower];
	if (byName) return byName;
	if (lower.startsWith("dockerfile.")) return "dockerfile";
	const dot = lower.lastIndexOf(".");
	return dot <= 0 ? "plain" : (BY_EXTENSION[lower.slice(dot + 1)] ?? "plain");
}
