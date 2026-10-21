import { expect, test } from "bun:test";
import { refuseAgentBrowserCommand } from "./agent-browser-commands.ts";

test.each(
	[
		["open", "https://example.com"],
		["open", "example.com"],
		["open", "localhost:3000"],
		["snapshot", "-i"],
		["snapshot", "-i", "-s", "#main"],
		["click", "@e3"],
		["fill", "@e2", "hello"],
		["type", "@e2", " world"],
		["press", "Control+a"],
		["scroll", "down", "500"],
		["wait", "--text", "Done"],
		["wait", "@e1"],
		["get", "text", "@e1"],
		["get", "url"],
		["find", "role", "button", "click", "--name", "Submit"],
		["tab", "new", "https://example.com"],
		["tab"],
		["screenshot"],
		["screenshot", "--full"],
		["eval", "--stdin"],
		["read"],
		["back"],
		["dialog", "accept"],
		["network", "requests", "--filter", "api"],
		["set", "viewport", "1280", "800"],
		["skills", "get", "core", "--full"],
		["skills", "list"],
	].map((args) => [args]),
)("allows %j", (args) =>
	expect(refuseAgentBrowserCommand(args)).toBeUndefined(),
);

test.each([
	[["download", "@e1", "/tmp/x"], "downloads are disabled"],
	[["upload", "@e1", "/etc/passwd"], "file uploads are disabled"],
	[["pdf", "/tmp/x.pdf"], "saving files is disabled"],
	[["install"], "install is refused"],
	[["install", "--with-deps"], "install is refused"],
	[["upgrade"], "upgrade is refused"],
	[["cookies", "get"], "cannot be imported or exported"],
	[["cookies", "set", "--curl", "/tmp/c"], "cannot be imported or exported"],
	[["storage", "local"], "cannot be imported or exported"],
	[["state", "save", "/tmp/s.json"], "state"],
	[["auth", "save", "x"], "no stored logins"],
	[["plugin", "add", "evil"], "plugins are disabled"],
	[["connect", "9222"], "cannot be replaced"],
	[["close", "--all"], "closed for you"],
	[["batch", "open https://example.com"], "each is checked"],
	[["record", "start", "/tmp/a.webm"], "recording is disabled"],
	[["chat", "hi"], "chat is disabled"],
	[["dashboard"], "dashboard is disabled"],
	[["mcp"], "MCP server is disabled"],
	[["session", "list"], "session is fixed"],
	[["frobnicate"], "not one of the commands"],
	[
		["network", "route", "**/api", "--abort"],
		"may only be followed by requests",
	],
	[["network"], "may only be followed by requests"],
	[["set", "offline", "on"], "may only be followed by viewport"],
	[["set", "headers", "{}"], "may only be followed by viewport"],
	[["get", "cdp-url"], "may only be followed by"],
	[["dialog"], "may only be followed by"],
	[["skills", "path"], "may only be followed by get, list"],
	[["diff", "url", "a", "b"], "may only be followed by snapshot"],
])("refuses %j", (args, reason) =>
	expect(refuseAgentBrowserCommand(args)).toContain(reason),
);

test.each([
	"--proxy",
	"--proxy=http://evil:8080",
	"--proxy-bypass",
	"--args",
	"--cdp",
	"--profile",
	"--state",
	"--restore",
	"--auto-connect",
	"--executable-path",
	"--extension",
	"--init-script",
	"--ignore-https-errors",
	"--ca-cert",
	"--allow-file-access",
	"--download-path",
	"--headers",
	"--session",
	"--config",
	"--provider",
	"-p",
	"--headed",
	"--engine",
])("refuses the launch or network flag %s on an allowed command", (flag) =>
	expect(refuseAgentBrowserCommand(["snapshot", "-i", flag, "x"])).toContain(
		"changes how the task's browser launches",
	),
);

test("a flag before the command and an empty command are refused", () => {
	expect(refuseAgentBrowserCommand([])).toContain("Give a command");
	expect(
		refuseAgentBrowserCommand(["--proxy", "x", "open", "https://a.test"]),
	).toContain("Put the command first");
});

test.each([
	"file:///etc/passwd",
	"javascript:alert(1)",
	"chrome://version",
	"data:text/html,hi",
	"about:blank",
	"ftp://example.com/",
	"view-source:https://example.com",
	"blob:https://example.com/x",
])("open refuses %s", (url) => {
	expect(refuseAgentBrowserCommand(["open", url])).toContain(
		"Only http and https",
	);
	expect(refuseAgentBrowserCommand(["tab", "new", url])).toContain(
		"Only http and https",
	);
});
