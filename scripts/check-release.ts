import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Manifest {
	name: string;
	version: string;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	repository?: { directory?: string };
}

export interface ReleasePackage {
	name: string;
	path: string;
}

export class ReleaseContractError extends Error {
	override name = "ReleaseContractError";
}

function manifest(path: string): Manifest {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (cause) {
		throw new ReleaseContractError(`Cannot read package manifest: ${path}`, {
			cause,
		});
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("name" in value) ||
		typeof value.name !== "string" ||
		!("version" in value) ||
		typeof value.version !== "string"
	)
		throw new ReleaseContractError(`Invalid package manifest: ${path}`);
	return value as Manifest;
}

/** Validate lockstep metadata before the core or any plugin is published. */
export function releasePackages(root: string, tag: string): ReleasePackage[] {
	const core = manifest(join(root, "package.json"));
	const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(core.version);
	if (!version || tag !== `v${core.version}`)
		throw new ReleaseContractError(
			`Tag ${tag} must match core v${core.version}`,
		);
	const minor = Number(version[2]);
	const peer = `>=${version[1]}.${minor}.0 <${version[1]}.${minor + 1}.0`;
	return readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((entry) => {
			if (!/^[a-z][a-z0-9-]*$/.test(entry.name))
				throw new ReleaseContractError(
					`Invalid workspace directory: ${entry.name}`,
				);
			const path = `packages/${entry.name}`;
			const pkg = manifest(join(root, path, "package.json"));
			if (pkg.name !== `pi-roundtable-${entry.name}`)
				throw new ReleaseContractError(`Unexpected package name in ${path}`);
			if (pkg.version !== core.version)
				throw new ReleaseContractError(
					`${pkg.name} must be ${core.version}, not ${pkg.version}`,
				);
			if (pkg.peerDependencies?.[core.name] !== peer)
				throw new ReleaseContractError(
					`${pkg.name} must peer on ${core.name} ${peer}`,
				);
			if (pkg.devDependencies?.[core.name] !== core.version)
				throw new ReleaseContractError(
					`${pkg.name} must develop against ${core.version}`,
				);
			if (pkg.repository?.directory !== path)
				throw new ReleaseContractError(
					`${pkg.name} must use repository directory ${path}`,
				);
			return { name: pkg.name, path };
		});
}

if (import.meta.main) {
	const tag = process.argv[2];
	if (!tag)
		throw new ReleaseContractError(
			"Usage: bun scripts/check-release.ts v<version>",
		);
	console.log(
		`packages=${JSON.stringify(releasePackages(process.cwd(), tag))}`,
	);
}
