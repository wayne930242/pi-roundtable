import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoShelf } from "../repo-shelf.ts";

// A bare origin, a seeded clone and a shelf that clones from it; `removeTemp` deletes what they made.
const dirs: string[] = [];
export function removeTemp() {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
}
export function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "coding-test-"));
	dirs.push(dir);
	return dir;
}
export async function git(dir: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", "-C", dir, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code) throw new Error(err);
	return out.trim();
}
export async function fixture() {
	const dir = temp();
	const origin = join(dir, "origin.git");
	const seed = join(dir, "seed");
	mkdirSync(origin);
	mkdirSync(seed);
	await git(origin, "init", "--bare", "--initial-branch=main");
	await git(seed, "init", "--initial-branch=main");
	await identity(seed);
	writeFileSync(
		join(seed, "README.md"),
		"# Example\n\nAn example repository.\n",
	);
	await git(seed, "add", "README.md");
	await git(seed, "commit", "-m", "Initial");
	await git(seed, "remote", "add", "origin", origin);
	await git(seed, "push", "-u", "origin", "main");
	const shelf = new RepoShelf(join(dir, "shelf"), async (_repo, path) => {
		await git(dir, "clone", origin, path);
		await identity(path);
	});
	return { dir, origin, seed, shelf };
}
export async function identity(dir: string) {
	await git(dir, "config", "user.name", "Test User");
	await git(dir, "config", "user.email", "test@example.invalid");
}
export async function change(dir: string, filename = "change.txt") {
	writeFileSync(join(dir, filename), "A change.\n");
	await git(dir, "add", filename);
	await git(dir, "commit", "-m", `Add ${filename}`);
}
