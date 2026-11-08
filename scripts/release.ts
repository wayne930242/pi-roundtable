import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CORE,
	distribute,
	type Entries,
	emptyEntries,
	FragmentError,
	insertRelease,
	loadFragments,
	lockstepLine,
	parseUnreleased,
	renderEntries,
} from "./changelog-fragments.ts";
import { releasePackages } from "./check-release.ts";
import { docsFiles, peerRange, workspaceDirs } from "./docs-files.ts";

export class ReleaseError extends Error {
	override name = "ReleaseError";
}

/** What the registry and the remote already hold; a test hands in its own answers. */
export interface Remote {
	tagExists(tag: string): Promise<boolean>;
	publishedVersions(name: string): Promise<string[]>;
}

export interface ReleaseOptions {
	root: string;
	version: string;
	/** The release date, `YYYY-MM-DD`. */
	date: string;
	/** The few words each lockstep line and the commit message carry about the release. */
	summary?: string;
	/** Print the release and write nothing. */
	dryRun?: boolean;
	/** Skip the checks against origin and npm. */
	offline?: boolean;
	/** Run `bun install` to bring `bun.lock` along; defaults to true. */
	install?: boolean;
	/** Run the docs and release tests afterwards; defaults to true. */
	tests?: boolean;
	remote?: Remote;
	out?: (line: string) => void;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parts(version: string): [number, number, number] {
	const found = SEMVER.exec(version);
	if (!found)
		throw new ReleaseError(`${version} is not a release version (X.Y.Z)`);
	return [Number(found[1]), Number(found[2]), Number(found[3])];
}

function isNewer(version: string, than: string): boolean {
	const [a, b] = [parts(version), parts(than)];
	for (const [index, part] of a.entries()) {
		const other = b[index] ?? 0;
		if (part !== other) return part > other;
	}
	return false;
}

function command(
	cwd: string,
	...args: string[]
): { code: number; out: string; err: string } {
	const run = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: run.exitCode,
		out: run.stdout.toString(),
		err: run.stderr.toString(),
	};
}

/** The remote as `git` and `npm` answer for the repository at `root`. */
export function commandRemote(root: string): Remote {
	return {
		async tagExists(tag) {
			const run = command(
				root,
				"git",
				"ls-remote",
				"--tags",
				"origin",
				`refs/tags/${tag}`,
			);
			if (run.code !== 0)
				throw new ReleaseError(`git ls-remote failed: ${run.err.trim()}`);
			return run.out.trim() !== "";
		},
		async publishedVersions(name) {
			const run = command(root, "npm", "view", name, "versions", "--json");
			if (run.code !== 0)
				throw new ReleaseError(`npm view ${name} failed: ${run.err.trim()}`);
			const value: unknown = JSON.parse(run.out);
			return Array.isArray(value) ? value.map(String) : [String(value)];
		},
	};
}

interface Manifest {
	name?: string;
	version?: string;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

const readText = (root: string, file: string): string =>
	readFileSync(join(root, file), "utf8");

/** The manifest text with the version, the core pin and the core peer range moved, checked against what was there. */
function bumpManifest(
	file: string,
	text: string,
	from: string,
	to: string,
	workspace: boolean,
): string {
	const manifest = JSON.parse(text) as Manifest;
	const [oldRange, newRange] = [peerRange(from), peerRange(to)];
	const problems = [
		manifest.version === from
			? ""
			: `version is ${manifest.version}, not ${from}`,
		!workspace || manifest.devDependencies?.["pi-roundtable"] === from
			? ""
			: `develops against ${manifest.devDependencies?.["pi-roundtable"]}, not ${from}`,
		!workspace || manifest.peerDependencies?.["pi-roundtable"] === oldRange
			? ""
			: `peers on ${manifest.peerDependencies?.["pi-roundtable"]}, not ${oldRange}`,
	].filter(Boolean);
	if (problems.length > 0)
		throw new ReleaseError(
			`${manifest.name ?? file} is out of lockstep: ${problems.join("; ")}`,
		);
	const moved = text
		.replace(`"version": "${from}"`, `"version": "${to}"`)
		.replaceAll(`"pi-roundtable": "${from}"`, `"pi-roundtable": "${to}"`)
		.replaceAll(
			`"pi-roundtable": "${oldRange}"`,
			`"pi-roundtable": "${newRange}"`,
		);
	const after = JSON.parse(moved) as Manifest;
	if (
		after.version !== to ||
		(workspace &&
			(after.devDependencies?.["pi-roundtable"] !== to ||
				after.peerDependencies?.["pi-roundtable"] !== newRange))
	)
		throw new ReleaseError(
			`${file}: could not move the version and the core range to ${to}`,
		);
	return moved;
}

export interface ReleasePlan {
	writes: Map<string, string>;
	removals: string[];
	/** The new section of each changelog, by `core` or workspace directory. */
	sections: Map<string, string>;
}

/** Everything the release changes, computed from the tree and written nowhere. */
export function planRelease(options: ReleaseOptions): ReleasePlan {
	const { root, version, date } = options;
	const core = JSON.parse(readText(root, "package.json")) as Manifest;
	const from = core.version ?? "";
	if (!isNewer(version, from))
		throw new ReleaseError(`${version} is not newer than the current ${from}`);
	const dirs = workspaceDirs(root);
	const writes = new Map<string, string>();
	writes.set(
		"package.json",
		bumpManifest(
			"package.json",
			readText(root, "package.json"),
			from,
			version,
			false,
		),
	);
	for (const dir of dirs) {
		const file = `packages/${dir}/package.json`;
		writes.set(
			file,
			bumpManifest(file, readText(root, file), from, version, true),
		);
	}
	const [oldRange, newRange] = [peerRange(from), peerRange(version)];
	for (const file of docsFiles(root)) {
		const text = readText(root, file);
		if (text.includes(oldRange))
			writes.set(file, text.replaceAll(oldRange, newRange));
	}

	const fragments = loadFragments(root, dirs);
	const targets = [CORE, ...dirs];
	const changelogOf = (target: string) =>
		target === CORE ? "CHANGELOG.md" : `packages/${target}/CHANGELOG.md`;
	const unreleased = new Map<string, Entries>(
		targets.map((target) => [
			target,
			parseUnreleased(readText(root, changelogOf(target))),
		]),
	);
	const entries = distribute(fragments, unreleased);
	if (
		![...entries.values()].some(
			(e) =>
				e.plain.length > 0 || [...e.groups.values()].some((g) => g.length > 0),
		)
	)
		throw new ReleaseError(
			"nothing to release: add a fragment under changes/unreleased, or write entries under ## [Unreleased]",
		);
	const sections = new Map<string, string>();
	for (const target of targets) {
		const section = renderEntries(
			entries.get(target) ?? emptyEntries(),
			lockstepLine(version, options.summary),
		);
		sections.set(target, section);
		const file = changelogOf(target);
		writes.set(
			file,
			insertRelease(readText(root, file), version, date, section),
		);
	}
	return {
		writes,
		removals: fragments.map((fragment) => fragment.file),
		sections,
	};
}

async function checkRemote(options: ReleaseOptions): Promise<void> {
	if (options.offline) return;
	const remote = options.remote ?? commandRemote(options.root);
	if (await remote.tagExists(`v${options.version}`))
		throw new ReleaseError(`v${options.version} is already a tag on origin`);
	if (
		(await remote.publishedVersions("pi-roundtable")).includes(options.version)
	)
		throw new ReleaseError(`${options.version} is already on npm`);
}

/** Moves the repository to `options.version`; it commits, tags and pushes nothing. */
export async function release(options: ReleaseOptions): Promise<void> {
	const out = options.out ?? console.log;
	const { root, version } = options;
	parts(version);
	if (!options.dryRun && existsSync(join(root, ".git"))) {
		const status = command(root, "git", "status", "--porcelain");
		if (status.code !== 0 || status.out.trim() !== "")
			throw new ReleaseError(
				"the working tree is not clean: commit or stash first",
			);
	}
	await checkRemote(options);
	const plan = planRelease(options);
	const verb = options.dryRun ? "would change" : "changed";
	out(
		`release ${version}: ${verb} ${plan.writes.size} files, removes ${plan.removals.length} fragments`,
	);
	for (const file of [...plan.writes.keys()].sort()) out(`  ${file}`);
	for (const file of plan.removals) out(`  - ${file}`);
	for (const [target, section] of plan.sections) {
		if (target !== CORE && !options.dryRun) continue;
		out(
			`\n${target === CORE ? "CHANGELOG.md" : `packages/${target}/CHANGELOG.md`} ## [${version}]\n${section}`,
		);
	}
	if (options.dryRun) return;

	for (const [file, text] of plan.writes) writeFileSync(join(root, file), text);
	for (const file of plan.removals) rmSync(join(root, file));
	if (options.install !== false) {
		const install = Bun.spawnSync(["bun", "install"], {
			cwd: root,
			stdout: "inherit",
			stderr: "inherit",
		});
		if (install.exitCode !== 0)
			throw new ReleaseError(
				"bun install failed; the files are already changed (git checkout . undoes them)",
			);
	}
	releasePackages(root, `v${version}`);
	if (options.tests !== false) {
		const tests = Bun.spawnSync(
			[
				"bun",
				"test",
				"scripts/docs-drift.test.ts",
				"scripts/check-release.test.ts",
			],
			{ cwd: root, stdout: "inherit", stderr: "inherit" },
		);
		if (tests.exitCode !== 0)
			throw new ReleaseError("the docs and release tests fail");
	}
	if (existsSync(join(root, ".git")))
		out(command(root, "git", "diff", "--stat").out);
	out(
		`release ${version} is ready to review; commit it, then push the tag after CI passes.`,
	);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const value = (flag: string): string | undefined => {
		const at = args.indexOf(flag);
		return at < 0 ? undefined : args[at + 1];
	};
	const version = args.find(
		(arg, index) =>
			!arg.startsWith("--") &&
			args[index - 1] !== "--summary" &&
			args[index - 1] !== "--date",
	);
	if (!version)
		throw new ReleaseError(
			"Usage: bun scripts/release.ts <version> [--summary text] [--date YYYY-MM-DD] [--dry-run] [--offline] [--no-install] [--no-tests]",
		);
	const summary = value("--summary");
	try {
		await release({
			root: process.cwd(),
			version,
			date: value("--date") ?? new Date().toLocaleDateString("sv"),
			...(summary !== undefined ? { summary } : {}),
			dryRun: args.includes("--dry-run"),
			offline: args.includes("--offline"),
			install: !args.includes("--no-install"),
			tests: !args.includes("--no-tests"),
		});
	} catch (error) {
		if (error instanceof ReleaseError || error instanceof FragmentError) {
			console.error(`release: ${error.message}`);
			process.exit(1);
		}
		throw error;
	}
}
