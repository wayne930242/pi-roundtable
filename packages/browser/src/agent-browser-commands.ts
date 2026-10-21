/**
 * What the worker may run. The browser container has no network of its own, so this list is not
 * the security boundary; it keeps the worker to browsing: no downloads, uploads, installs, saved
 * logins, cookie or state import and export, plugins, or changes to the browser's launch or
 * network settings. Anything not listed is refused, so a command a later agent-browser adds starts
 * out refused.
 */

/** Commands the worker may run, with the subcommands allowed where only some are. */
const COMMANDS: Readonly<Record<string, readonly string[] | true>> = {
	open: true,
	read: true,
	click: true,
	dblclick: true,
	type: true,
	fill: true,
	press: true,
	keyboard: true,
	hover: true,
	focus: true,
	check: true,
	uncheck: true,
	select: true,
	drag: true,
	scroll: true,
	scrollintoview: true,
	wait: true,
	snapshot: true,
	eval: true,
	back: true,
	forward: true,
	reload: true,
	find: true,
	is: true,
	mouse: true,
	frame: true,
	highlight: true,
	pushstate: true,
	console: true,
	errors: true,
	get: [
		"text",
		"html",
		"value",
		"attr",
		"title",
		"url",
		"count",
		"box",
		"styles",
	],
	tab: true,
	dialog: ["status", "accept", "dismiss"],
	diff: ["snapshot"],
	network: ["requests"],
	set: ["viewport", "device", "geo", "media"],
	skills: ["get", "list"],
	webmcp: ["list", "invoke", "result", "cancel"],
	// Handled by the driver itself, which picks where the image goes.
	screenshot: true,
};

/** Why a command is not offered, for the ones a worker is likely to try. */
const REASONS: Readonly<Record<string, string>> = {
	download: "downloads are disabled",
	upload: "file uploads are disabled",
	pdf: "saving files is disabled",
	install: "the browser is already installed",
	upgrade: "the browser is already installed",
	cookies: "cookies cannot be imported or exported",
	storage: "web storage cannot be imported or exported",
	state: "saved state cannot be imported or exported",
	auth: "the browser has no stored logins and the worker has no credentials",
	plugin: "plugins are disabled",
	profiles: "browser profiles are disabled",
	connect: "the task's browser cannot be replaced",
	close: "the browser is closed for you when the task ends",
	batch: "run each command with its own call, so each is checked",
	record: "recording is disabled",
	trace: "tracing is disabled",
	profiler: "profiling is disabled",
	stream: "streaming is disabled",
	mcp: "the MCP server is disabled",
	chat: "chat is disabled",
	dashboard: "the dashboard is disabled",
	session: "the task's session is fixed",
	doctor: "diagnostics are disabled",
	clipboard: "the clipboard is disabled",
	inspect: "the inspector is disabled",
};

/** Flags that change how the browser launches, what it trusts, where it connects or what it saves. */
const REFUSED_FLAGS = new Set([
	"--profile",
	"--restore",
	"--restore-save",
	"--restore-check-url",
	"--restore-check-text",
	"--restore-check-fn",
	"--session-name",
	"--state",
	"--auto-connect",
	"--cdp",
	"--headers",
	"--session",
	"--namespace",
	"--executable-path",
	"--extension",
	"--init-script",
	"--enable",
	"--args",
	"--user-agent",
	"--proxy",
	"--proxy-bypass",
	"--ignore-https-errors",
	"--ca-cert",
	"--no-ca-cert",
	"--allow-file-access",
	"--provider",
	"-p",
	"--device",
	"--headed",
	"--webgpu",
	"--download-path",
	"--screenshot-dir",
	"--allowed-domains",
	"--action-policy",
	"--confirm-actions",
	"--confirm-interactive",
	"--engine",
	"--config",
	"--idle-timeout",
	"--model",
	"--pin-tab",
	"--no-pin-tab",
]);

/** `--flag=value` and `--flag` name the same flag. */
const flagName = (arg: string) => arg.split("=", 1)[0] ?? arg;

/** Addresses of other kinds than http(s): `file:`, `javascript:`, `chrome://`, `data:` and the like. */
const OTHER_SCHEME =
	/^(?:[a-z][a-z0-9+.-]*:\/\/|(?:file|javascript|data|blob|about|chrome|view-source|devtools|ftp):)/i;

/**
 * The reason a command is refused, written for the worker, or undefined when it may run.
 * `args` is the argument list after `agent-browser`.
 */
export function refuseAgentBrowserCommand(
	args: readonly string[],
): string | undefined {
	const [command, sub] = args;
	if (!command) return "Give a command, such as open, snapshot or click.";
	if (command.startsWith("-")) return "Put the command first, then its flags.";
	for (const arg of args.slice(1)) {
		const flag = flagName(arg);
		if (REFUSED_FLAGS.has(flag))
			return `${flag} is refused: it changes how the task's browser launches, connects or saves state.`;
	}
	const allowed = COMMANDS[command];
	if (allowed === undefined)
		return REASONS[command]
			? `${command} is refused: ${REASONS[command]}.`
			: `${command} is not one of the commands this browser worker offers.`;
	if (allowed !== true && (!sub || !allowed.includes(sub)))
		return `${command} may only be followed by ${allowed.join(", ")}.`;
	if (command === "open" || (command === "tab" && sub === "new"))
		for (const arg of args.slice(command === "open" ? 1 : 2))
			if (
				!arg.startsWith("-") &&
				OTHER_SCHEME.test(arg) &&
				!/^https?:\/\//i.test(arg)
			)
				return "Only http and https pages open; other addresses (file:, javascript:, chrome: and the like) are refused.";
	return undefined;
}
