import { ConfigError } from "../domain/errors.ts";

/**
 * What an agent's shell and the host's other child processes get of the host's environment: the
 * names on a whitelist, and nothing else. Secrets the host needs stay in the host process; a child
 * that needs one gets it from code, through `pass` or `set`, for that child only.
 */

/** Extra names and fixed values for the agents' shells, on top of `SHELL_ENV_NAMES`. */
export interface ShellEnv {
	/** Host variables the shell gets too, by exact name (`LC_*`-style trailing `*` matches a prefix). */
	pass?: readonly string[];
	/** Fixed values the shell gets, set after the passed names, so they win. */
	set?: Readonly<Record<string, string>>;
}

/** The `shellEnv` option of the host's environment and of `roundtable.config.ts`. */
export interface ShellEnvConfig {
	/**
	 * What the agents' shell gets of the host's environment besides `SHELL_ENV_NAMES` (the user,
	 * locale, terminal, paths and proxies): host variables to `pass` by name and fixed values to
	 * `set`. Plugins read it as `env.shellEnv` for shells of their own. Default: `pass` is
	 * `DEFAULT_SHELL_PASS`, empty, so no host secret reaches the shell; a shell that runs `gh` or
	 * `git push` needs a token named, as in `pass: ["GH_TOKEN"]`, or a narrower one in `set`.
	 */
	shellEnv?: ShellEnv;
}

/**
 * The host variables every child gets: the user, the locale and the terminal, the paths, proxies
 * and certificates; `LC_*` is every locale category. Pi's own `PI_*` session names (the model and
 * session the shell runs in) carry no secret, so the shell keeps them.
 */
export const SHELL_ENV_NAMES: readonly string[] = Object.freeze([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LANGUAGE",
	"LC_*",
	"TZ",
	"TERM",
	"TMPDIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
]);

function matches(name: string, pattern: string): boolean {
	return pattern.endsWith("*")
		? name.startsWith(pattern.slice(0, -1))
		: name === pattern;
}

/**
 * The environment of a child process: the variables of `source` that `SHELL_ENV_NAMES` or `pass`
 * names, then `set`.
 */
export function childEnv(
	source: Readonly<Record<string, string | undefined>>,
	options: ShellEnv = {},
): Record<string, string> {
	const names = [...SHELL_ENV_NAMES, ...(options.pass ?? [])];
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source))
		if (value !== undefined && names.some((pattern) => matches(name, pattern)))
			env[name] = value;
	return { ...env, ...options.set };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A copy of `shellEnv` that later changes to the caller's object do not reach; a name that is not a variable name stops the start. */
export function frozenShellEnv(shellEnv: ShellEnv): Readonly<ShellEnv> {
	for (const name of shellEnv.pass ?? [])
		if (!ENV_NAME.test(name.endsWith("*") ? name.slice(0, -1) : name))
			throw new ConfigError(`shellEnv.pass: "${name}" is not a variable name`);
	for (const [name, value] of Object.entries(shellEnv.set ?? {}))
		if (!ENV_NAME.test(name) || typeof value !== "string")
			throw new ConfigError(
				`shellEnv.set: "${name}" needs a variable name and a string value`,
			);
	return Object.freeze({
		...(shellEnv.pass ? { pass: Object.freeze([...shellEnv.pass]) } : {}),
		...(shellEnv.set ? { set: Object.freeze({ ...shellEnv.set }) } : {}),
	});
}

/** The host variables an agent's shell gets beyond `SHELL_ENV_NAMES` when `shellEnv.pass` is not given. */
export const DEFAULT_SHELL_PASS: readonly string[] = Object.freeze([]);

/** The environment of an agent's shell: `childEnv` with `shellEnv`, whose `pass` defaults to `DEFAULT_SHELL_PASS`. */
export function shellChildEnv(
	source: Readonly<Record<string, string | undefined>>,
	shellEnv: ShellEnv = {},
): Record<string, string> {
	return childEnv(source, {
		...shellEnv,
		pass: shellEnv.pass ?? DEFAULT_SHELL_PASS,
	});
}
