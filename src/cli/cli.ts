import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DefinedRoundtable } from "../core/define-roundtable.ts";
import { Roundtable } from "../core/host.ts";
import { addPackage } from "./add-package.ts";
import { addPlugin } from "./add-plugin.ts";
import type { BunFacts } from "./checks/bun.ts";
import { postgres } from "./checks/database.ts";
import { doctor } from "./doctor.ts";
import { fetchHttp } from "./http.ts";
import { init } from "./init.ts";
import { type PackagePorts, piPackagePorts } from "./pi-packages.ts";
import { loadConfigFile, type Ports } from "./project.ts";
import { formatOutcomes } from "./report.ts";
import { assemble, providerLogin } from "./runtime.ts";
import { start } from "./start.ts";
import { ADAPTERS, isAdapter, OFFICIAL_PLUGINS } from "./templates.ts";

/** What the command line reads from its surroundings; tests replace every part. */
export interface CliEnvironment {
	cwd: string;
	env: Record<string, string | undefined>;
	bun: () => BunFacts;
	version: () => string;
	ports: Ports;
	/** Installs Pi packages and reads the tools they register, for `add package`. */
	packages: PackagePorts;
	launch(defined: DefinedRoundtable): Promise<void>;
	out(line: string): void;
	err(line: string): void;
}

const USAGE = `roundtable: a Discord agent server on Pi

  roundtable init [dir] [--adapter discord|web]
                                create a project (default: the current directory) that talks
                                through Discord (the default) or through the web chat
  roundtable doctor [--reachable]  check the setup and say how to fix what is wrong
  roundtable start              run the checks that need no network, then the bot
  roundtable add plugin <name>  add plugins/<name>.ts and its test, and list it in the config
                                the names ${new Intl.ListFormat("en").format(OFFICIAL_PLUGINS)} are reserved for the official plugins,
                                which are copied in ready to run instead of the template
  roundtable add package <spec> install a Pi package with bun add, and add plugins/<name>.ts that
                                loads it and gives its tools to every agent turn
`;

/** The package's own version and the Bun range it needs, from the package.json beside the source. */
export function readPackage(dir = join(import.meta.dir, "../..")): {
	version: string;
	bun: string;
} {
	const path = join(dir, "package.json");
	let manifest: { version?: string; engines?: { bun?: string } } = {};
	if (existsSync(path)) {
		try {
			manifest = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new Error(`${path} is not valid JSON: ${String(error)}`, {
				cause: error,
			});
		}
	}
	if (!manifest.version || !manifest.engines?.bun)
		throw new Error(
			`${path} has no version and engines.bun; the roundtable command runs from an installed pi-roundtable package.`,
		);
	return { version: manifest.version, bun: manifest.engines.bun };
}

/** The real surroundings of the process. */
export function processEnvironment(): CliEnvironment {
	return {
		cwd: process.cwd(),
		env: process.env,
		bun: () => ({
			version: typeof Bun === "undefined" ? undefined : Bun.version,
			required: readPackage().bun,
		}),
		version: () => readPackage().version,
		ports: {
			loadConfig: loadConfigFile,
			define: assemble,
			login: providerLogin,
		},
		packages: piPackagePorts,
		launch: async (defined) => {
			const roundtable = new Roundtable(defined.options, defined.plugins);
			roundtable.listen();
			await roundtable.run();
		},
		// pi-lens-ignore: no-console-except-error — the command line's printed output is its product
		out: (line) => console.log(line),
		// pi-lens-ignore: no-console-except-error — the command line's printed output is its product
		err: (line) => console.error(line),
	};
}

/** Parses the arguments, runs one command, prints its report, and returns the exit code. */
export async function runCli(
	argv: readonly string[],
	io: CliEnvironment,
): Promise<number> {
	const [command, ...rest] = argv;
	if (command === undefined || command === "help" || command === "--help") {
		io.out(USAGE);
		return command === undefined ? 1 : 0;
	}
	if (command === "--version") {
		io.out(io.version());
		return 0;
	}
	if (command === "init") {
		const at = rest.indexOf("--adapter");
		const adapter = at === -1 ? "discord" : rest[at + 1];
		if (adapter === undefined || !isAdapter(adapter))
			return usage(
				io,
				`--adapter takes one of ${ADAPTERS.join(", ")}, not ${JSON.stringify(adapter ?? "")}`,
			);
		const [dir, ...extra] = at === -1 ? rest : rest.toSpliced(at, 2);
		if (extra.length > 0 || dir?.startsWith("-"))
			return usage(io, "init takes at most one directory");
		const report = init({
			cwd: io.cwd,
			...(dir === undefined ? {} : { dir }),
			bun: io.bun(),
			version: io.version(),
			adapter,
		});
		if (!report.ok) {
			for (const line of report.problems) io.err(line);
			return 1;
		}
		io.out(`Created ${report.created.length} files in ${report.root}:`);
		for (const path of report.created) io.out(`  ${path}`);
		io.out("\nNext:");
		for (const [index, step] of report.nextSteps.entries())
			io.out(`  ${index + 1}. ${step}`);
		return 0;
	}
	if (command === "add") {
		const [what, name, ...extra] = rest;
		if (what === "package" && name !== undefined && extra.length === 0) {
			const report = await addPackage({
				cwd: io.cwd,
				spec: name,
				ports: io.packages,
			});
			if (!report.ok) {
				for (const line of report.problems) io.err(line);
				return 1;
			}
			io.out(`Added the Pi package ${name}:`);
			for (const path of report.changed) io.out(`  ${path}`);
			io.out(
				report.tools.length > 0
					? `Its tools: ${report.tools.join(", ")}. One no plugin gives a tier is the owner's alone; lower it with toolTiers in roundtable.config.ts.`
					: "It registers no tools when it loads; the plugin still loads it in every session.",
			);
			return 0;
		}
		if (what !== "plugin" || name === undefined || extra.length > 0)
			return usage(
				io,
				"usage: roundtable add plugin <name>, or roundtable add package <spec>",
			);
		const report = addPlugin({ cwd: io.cwd, name });
		if (!report.ok) {
			for (const line of report.problems) io.err(line);
			return 1;
		}
		io.out(`Added the plugin ${name}:`);
		for (const path of report.changed) io.out(`  ${path}`);
		return 0;
	}
	if (command === "doctor" || command === "start") {
		const flags = rest.filter((arg) => arg.startsWith("-"));
		const reachable = flags.includes("--reachable");
		if (
			rest.length > 0 &&
			!(rest.length === 1 && reachable && command === "doctor")
		)
			return usage(io, `${command} takes no arguments`);
		const inputs = {
			cwd: resolve(io.cwd),
			env: io.env,
			bun: io.bun(),
			ports: io.ports,
			database: postgres,
			http: fetchHttp,
		};
		if (command === "doctor") {
			const report = await doctor({ ...inputs, reachable });
			for (const line of formatOutcomes(report.outcomes)) io.out(line);
			return report.ok ? 0 : 1;
		}
		const report = await start({ ...inputs, launch: io.launch });
		if (!report.started) {
			for (const line of formatOutcomes(report.outcomes)) io.err(line);
			return 1;
		}
		return 0;
	}
	return usage(io, `unknown command ${JSON.stringify(command)}`);
}

function usage(io: CliEnvironment, message: string): number {
	io.err(message);
	io.err(USAGE);
	return 1;
}
