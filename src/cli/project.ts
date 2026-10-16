import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { liftAdapters } from "../core/config/adapters.ts";
import {
	type ResolvedConfig,
	type RoundtableConfig,
	resolveConfig,
} from "../core/config/config.ts";
import type { DefinedRoundtable } from "../core/define-roundtable.ts";
import { type Logger, silentLogger } from "../core/log.ts";
import { fail, type Result } from "./report.ts";

export const CONFIG_FILE = "roundtable.config.ts";

/** What the command line reaches outside itself, so each check can be run against a fake. */
export interface Ports {
	/** The value `roundtable.config.ts` exports by default. */
	loadConfig(cwd: string, options?: { fresh?: boolean }): Promise<unknown>;
	/** The bot's options and plugin list, assembled from a valid configuration. */
	define(
		config: RoundtableConfig,
		agentDir: string,
		overrides?: { logger?: Logger },
	): Promise<DefinedRoundtable>;
	/** Where the login for `provider` in `agentDir` comes from, or undefined when there is none. */
	login(agentDir: string, provider: string): Promise<string | undefined>;
}

/**
 * Loads the project's configuration file with Bun, which reads `.env` on its own. With `fresh`
 * the file is evaluated again, so the plugins its default export makes are new objects.
 */
export async function loadConfigFile(
	cwd: string,
	options: { fresh?: boolean } = {},
): Promise<unknown> {
	const path = join(cwd, CONFIG_FILE);
	if (!existsSync(path))
		throw new Error(
			`${CONFIG_FILE} is not in ${cwd}. Run this in the project directory, or create a project with \`roundtable init\`.`,
		);
	return loadDefault(path, options);
}

let evaluations = 0;

/**
 * The value a configuration file exports by default, imported with Bun. With `fresh` the file is
 * imported under a path of its own (Bun evaluates a plain path with a new query again, and not a
 * `file:` URL with one), so what the file makes at its top level is made again; the modules it
 * imports stay as they were, shared with the first evaluation.
 */
export async function loadDefault(
	path: string,
	{ fresh = false }: { fresh?: boolean } = {},
): Promise<unknown> {
	const specifier = fresh
		? `${path}?fresh=${++evaluations}`
		: pathToFileURL(path).href;
	const module = (await import(specifier)) as {
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

/** The configuration with its adapters lifted, or as written when they cannot be. */
// pi-lens-ignore: no-unknown-returns — the configuration as written is untyped until the schema checks it
function lifted(value: unknown): unknown {
	try {
		return liftAdapters(value);
	} catch {
		return value;
	}
}

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

	/**
	 * The exported value as written, before the schema looks at it, with its adapters' settings in
	 * the places the host reads them, such as a Discord adapter's as `discord`. Adapters it cannot
	 * read stay as written; the configuration check reports them.
	 */
	raw(): Promise<Loaded<unknown>> {
		this.#raw ??= this.#ports.loadConfig(this.#cwd).then(
			(value): Loaded<unknown> => ({ ok: true, value: lifted(value) }),
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

	/** Whether the configuration, loaded, leaves the top-level key out; false when it could not be loaded. */
	async leavesOut(key: string): Promise<boolean> {
		const raw = await this.raw();
		return (
			raw.ok &&
			typeof raw.value === "object" &&
			raw.value !== null &&
			(raw.value as Record<string, unknown>)[key] === undefined
		);
	}

	/** The configuration checked against its schema and assembled, or the failure that says why not. */
	assembled(): Promise<Loaded<Assembled>> {
		this.#assembled ??= this.#assemble();
		return this.#assembled;
	}

	/**
	 * The configuration assembled again, for a check that runs every plugin's setup: the
	 * configuration file is evaluated again, so the plugins its default export makes with a factory
	 * are new objects, and the built-in plugins are made again. A plugin object that a module the
	 * file imports exports is the same object, and so is state kept at module level, so a plugin's
	 * `setup` must keep nothing one-shot outside its call. The plugins' own log lines go nowhere:
	 * the definition `start` runs speaks for the host.
	 */
	async reassemble(): Promise<DefinedRoundtable> {
		const assembled = await this.assembled();
		if (!assembled.ok) throw new Error("the configuration is not valid yet");
		const value = lifted(
			await this.#ports.loadConfig(this.#cwd, { fresh: true }),
		);
		return this.#ports.define(
			value as RoundtableConfig,
			assembled.value.config.agentDir,
			{ logger: silentLogger() },
		);
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
