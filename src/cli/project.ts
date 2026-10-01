import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ResolvedConfig,
	type RoundtableConfig,
	resolveConfig,
} from "../core/config/config.ts";
import type { DefinedRoundtable } from "../core/define-roundtable.ts";
import { fail, type Result } from "./report.ts";

export const CONFIG_FILE = "roundtable.config.ts";

/** What the command line reaches outside itself, so each check can be run against a fake. */
export interface Ports {
	/** The value `roundtable.config.ts` exports by default. */
	loadConfig(cwd: string): Promise<unknown>;
	/** The bot's options and plugin list, assembled from a valid configuration. */
	define(
		config: RoundtableConfig,
		agentDir: string,
	): Promise<DefinedRoundtable>;
	/** Where the login for `provider` in `agentDir` comes from, or undefined when there is none. */
	login(agentDir: string, provider: string): Promise<string | undefined>;
}

/** Loads the project's configuration file with Bun, which reads `.env` on its own. */
export async function loadConfigFile(cwd: string): Promise<unknown> {
	const path = join(cwd, CONFIG_FILE);
	if (!existsSync(path))
		throw new Error(
			`${CONFIG_FILE} is not in ${cwd}. Run this in the project directory, or create a project with \`roundtable init\`.`,
		);
	const module = (await import(pathToFileURL(path).href)) as {
		default?: unknown;
	};
	if (module.default === undefined)
		throw new Error(
			`${CONFIG_FILE} has no default export. Write \`export default { ... } satisfies RoundtableConfig\`.`,
		);
	return module.default;
}

type Loaded<T> = { ok: true; value: T } | { ok: false; failure: Result };

export interface Assembled {
	config: ResolvedConfig;
	defined: DefinedRoundtable;
}

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * The project's configuration, loaded and resolved at most once and shared by every check, so a
 * mistake in it is reported by the configuration check and the checks that need it say so
 * rather than repeating it.
 */
export class Project {
	readonly #cwd: string;
	readonly #ports: Ports;
	#raw: Promise<Loaded<unknown>> | undefined;
	#assembled: Promise<Loaded<Assembled>> | undefined;

	constructor(cwd: string, ports: Ports) {
		this.#cwd = cwd;
		this.#ports = ports;
	}

	/** The exported value as written, before the schema looks at it. */
	raw(): Promise<Loaded<unknown>> {
		this.#raw ??= this.#ports.loadConfig(this.#cwd).then(
			(value): Loaded<unknown> => ({ ok: true, value }),
			(error: unknown): Loaded<unknown> => ({
				ok: false,
				failure: fail(
					`${CONFIG_FILE} could not be loaded: ${message(error)}`,
					`Fix the error in ${CONFIG_FILE}.`,
				),
			}),
		);
		return this.#raw;
	}

	/** A string at `path` in the configuration as written, even when other keys are wrong. */
	async text(...path: string[]): Promise<string | undefined> {
		const raw = await this.raw();
		if (!raw.ok) return undefined;
		let value: unknown = raw.value;
		for (const key of path) {
			if (typeof value !== "object" || value === null) return undefined;
			// A read only: nothing is assigned by key, and every caller passes literal keys.
			// nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop
			value = (value as Record<string, unknown>)[key];
		}
		return typeof value === "string" && value.trim() !== "" ? value : undefined;
	}

	/** The configuration checked against its schema and assembled, or the failure that says why not. */
	assembled(): Promise<Loaded<Assembled>> {
		this.#assembled ??= this.#assemble();
		return this.#assembled;
	}

	async #assemble(): Promise<Loaded<Assembled>> {
		const raw = await this.raw();
		if (!raw.ok) return raw;
		try {
			const config = resolveConfig(raw.value);
			const defined = await this.#ports.define(
				raw.value as RoundtableConfig,
				config.agentDir,
			);
			return { ok: true, value: { config, defined } };
		} catch (error) {
			return {
				ok: false,
				failure: fail(
					message(error),
					`Fix the key in ${CONFIG_FILE}; a value it reads from .env is set there (see .env.example).`,
				),
			};
		}
	}
}
