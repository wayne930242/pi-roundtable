import { resolve } from "node:path";
import {
	ReleaseContractError,
	type ReleasePackage,
	releasePackages,
} from "./check-release.ts";

interface PackReport {
	name: string;
	version: string;
	files: { path: string }[];
}

/** npm's prepack scripts may print before the final JSON report. */
export function checkPack(
	output: string,
	pkg: ReleasePackage,
	version: string,
): void {
	const start = output.lastIndexOf("\n[");
	let reports: PackReport[];
	try {
		reports = JSON.parse(
			start < 0 ? output : output.slice(start + 1),
		) as PackReport[];
	} catch (cause) {
		throw new ReleaseContractError(`Invalid npm pack report for ${pkg.name}`, {
			cause,
		});
	}
	const report = reports[0];
	if (
		reports.length !== 1 ||
		report?.name !== pkg.name ||
		report.version !== version
	)
		throw new ReleaseContractError(`Packed identity differs for ${pkg.name}`);
	const paths = new Set(report.files.map((file) => file.path));
	const required = ["package.json", "README.md", "LICENSE", "src/index.ts"];
	if (pkg.name === "pi-roundtable-sandbox")
		required.push(
			"src/protocol.ts",
			"worker/Dockerfile",
			"worker/main.ts",
			"worker/agent.ts",
			"worker/memory.ts",
			"worker/transport.ts",
		);
	if (pkg.name === "pi-roundtable-web") required.push("dist/index.html");
	if (pkg.name === "pi-roundtable-drawing")
		required.push("fonts/NotoSansTC-Bold.otf", "fonts/OFL.txt");
	for (const path of required) {
		if (!paths.has(path))
			throw new ReleaseContractError(`${pkg.name} tarball is missing ${path}`);
	}
	if (
		pkg.name === "pi-roundtable-web" &&
		(![...paths].some(
			(path) => path.startsWith("dist/") && path.endsWith(".js"),
		) ||
			![...paths].some(
				(path) => path.startsWith("dist/") && path.endsWith(".css"),
			))
	)
		throw new ReleaseContractError(
			`${pkg.name} tarball is missing bundled JS or CSS`,
		);
}

function npm(root: string, args: string[]): string {
	const result = Bun.spawnSync(["npm", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (
		result.exitCode !== 0 &&
		args[0] === "view" &&
		result.stderr.toString().includes("E404")
	)
		throw new ReleaseContractError(
			`${args[1]} needs its manual first publication before a lockstep tag`,
		);
	if (result.exitCode !== 0)
		throw new ReleaseContractError(
			`npm ${args[0]} failed in ${root}: ${result.stderr.toString()}`,
		);
	return result.stdout.toString();
}

if (import.meta.main) {
	const tag = process.argv[2];
	if (!tag)
		throw new ReleaseContractError(
			"Usage: bun scripts/preflight-release.ts v<version> [--local]",
		);
	const root = process.cwd();
	const local = process.argv[3] === "--local";
	for (const pkg of releasePackages(root, tag)) {
		checkPack(
			npm(resolve(root, pkg.path), ["pack", "--dry-run", "--json"]),
			pkg,
			tag.slice(1),
		);
		if (!local) {
			const output = npm(root, ["view", pkg.name, "name", "--json"]);
			let name: unknown;
			try {
				name = JSON.parse(output);
			} catch (cause) {
				throw new ReleaseContractError(
					`Invalid npm registry metadata for ${pkg.name}`,
					{ cause },
				);
			}
			if (name !== pkg.name)
				throw new ReleaseContractError(
					`${pkg.name} needs its manual first publication before a lockstep tag`,
				);
		}
		console.log(
			`${pkg.name}: pack verified${local ? "" : ", npm package exists"}`,
		);
	}
}
