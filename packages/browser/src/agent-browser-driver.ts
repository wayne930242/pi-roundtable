import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PluginError } from "pi-roundtable";
import { Type } from "typebox";
import { refuseAgentBrowserCommand } from "./agent-browser-commands.ts";
import { docker, firstLine, requireDocker } from "./docker.ts";
import {
	type BrowserDriver,
	type BrowserSkill,
	type BrowserTaskContext,
	type BrowserTaskKit,
	BrowserToolError,
	browserTool,
} from "./driver.ts";
import { EgressProxy } from "./egress-proxy.ts";

const PACKAGE_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");
const VERSION = (
	JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
		version: string;
	}
).version;

/** The Dockerfile's folder, for the host's build command. */
export const BROWSER_IMAGE_CONTEXT = join(PACKAGE_DIR, "docker");
/** The image the default driver runs unless told otherwise; the version is this package's. */
export const DEFAULT_BROWSER_IMAGE = `pi-roundtable-browser:${VERSION}`;

/** The command that builds the image the default driver needs. */
export function browserImageBuildCommand(
	image = DEFAULT_BROWSER_IMAGE,
): string {
	return `docker build -t ${image} -f ${join(BROWSER_IMAGE_CONTEXT, "Dockerfile")} ${BROWSER_IMAGE_CONTEXT}`;
}

export interface AgentBrowserDriverOptions {
	/** The image to run; default `DEFAULT_BROWSER_IMAGE`, built with `browserImageBuildCommand()`. */
	image?: string;
	/** The Docker CLI; default `docker`. */
	binary?: string;
	/** The user and group the container runs as; default the host process's. Never root. */
	user?: { uid: number; gid: number };
	/** Container memory in MiB; default 1024. */
	memoryMb?: number;
	/** Container CPUs; default 1.5. */
	cpus?: number;
	/** Processes the container may run; default 512. */
	pids?: number;
	/** Destination ports the browser may reach; default 80 and 443. */
	ports?: readonly number[];
	/** Time one agent-browser command may take, in milliseconds; default 60,000. */
	commandTimeoutMs?: number;
	/** Told about each request the egress proxy refused: the destination and why. */
	onRefused?: (destination: string, reason: string) => void;
}

const LABEL = "pi-roundtable.browser";
const PROXY_PORT = 3128;
const SCREENSHOT_DIR = "/tmp/shots";

export interface BrowserContainerSpec {
	name: string;
	image: string;
	/** The host folder holding the egress proxy's socket, mounted read-only at /egress. */
	egressDir: string;
	uid: number;
	gid: number;
	memoryMb: number;
	cpus: number;
	pids: number;
	/** Seconds the container may live; it exits by itself after that, even if the host is gone. */
	lifetimeSeconds: number;
	maxOutputChars: number;
	hostPid: number;
}

/**
 * `docker run` arguments of one task's browser. The container has no network interface but
 * loopback; the only way out is the proxy socket mounted at /egress, relayed to 127.0.0.1:3128.
 * It runs unprivileged on a read-only root with a small tmpfs, and the browser's policy (in the
 * image) refuses downloads and local files.
 */
export function browserContainerArgs(spec: BrowserContainerSpec): string[] {
	if (
		!/^[a-z0-9][a-z0-9_.-]{0,90}$/.test(spec.name) ||
		!spec.image ||
		spec.image.startsWith("-") ||
		/\s/.test(spec.image)
	)
		throw new PluginError("browser container name or image is not valid.");
	if (
		!Number.isInteger(spec.uid) ||
		spec.uid <= 0 ||
		!Number.isInteger(spec.gid) ||
		spec.gid <= 0
	)
		throw new PluginError(
			"the browser container must run as a non-root user and group: run the host as one, or pass docker: { user: { uid, gid } }.",
		);
	if (!isAbsolute(spec.egressDir) || /[,\n\r]/.test(spec.egressDir))
		throw new PluginError("the egress folder must be an absolute path.");
	const proxy = `http://127.0.0.1:${PROXY_PORT}`;
	const env: Record<string, string> = {
		HOME: "/tmp/home",
		HTTP_PROXY: proxy,
		HTTPS_PROXY: proxy,
		http_proxy: proxy,
		https_proxy: proxy,
		AGENT_BROWSER_PROXY: proxy,
		AGENT_BROWSER_SESSION: "task",
		AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
		AGENT_BROWSER_ARGS: [
			"--no-sandbox",
			"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		].join("\n"),
		AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
		AGENT_BROWSER_MAX_OUTPUT: String(spec.maxOutputChars),
		BROWSER_LIFETIME_SECONDS: String(spec.lifetimeSeconds),
	};
	return [
		"run",
		"--detach",
		"--rm",
		"--init",
		"--pull",
		"never",
		"--name",
		spec.name,
		"--label",
		`${LABEL}=1`,
		"--label",
		`${LABEL}.pid=${spec.hostPid}`,
		"--network",
		"none",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges:true",
		"--user",
		`${spec.uid}:${spec.gid}`,
		"--memory",
		`${spec.memoryMb}m`,
		"--memory-swap",
		`${spec.memoryMb}m`,
		"--cpus",
		String(spec.cpus),
		"--pids-limit",
		String(spec.pids),
		"--ulimit",
		"nofile=1024:1024",
		"--shm-size",
		"256m",
		"--tmpfs",
		"/tmp:rw,nosuid,nodev,size=512m,mode=1777",
		"--mount",
		`type=bind,src=${spec.egressDir},dst=/egress,readonly,bind-propagation=rprivate`,
		...Object.entries(env).flatMap(([key, value]) => [
			"--env",
			`${key}=${value}`,
		]),
		spec.image,
	];
}

function ownerOf(options: AgentBrowserDriverOptions): {
	uid: number;
	gid: number;
} {
	return (
		options.user ?? {
			uid: process.getuid?.() ?? 0,
			gid: process.getgid?.() ?? 0,
		}
	);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Removes containers a host that is gone left behind. */
async function sweepStale(binary: string): Promise<void> {
	try {
		const listed = await docker(
			binary,
			[
				"ps",
				"--all",
				"--filter",
				`label=${LABEL}`,
				"--format",
				`{{.Names}} {{.Label "${LABEL}.pid"}}`,
			],
			{ timeoutMs: 15_000 },
		);
		if (listed.code !== 0) return;
		for (const line of new TextDecoder().decode(listed.stdout).split("\n")) {
			const [name, pid] = line.trim().split(" ");
			if (name && Number(pid) > 0 && !isAlive(Number(pid)))
				await docker(binary, ["rm", "--force", name], { timeoutMs: 15_000 });
		}
	} catch {
		// Best effort: a container left behind exits by itself when its lifetime ends.
	}
}

const SKILL_FRONT_MATTER = /^---\n[\s\S]*?\n---\n/;

const INSTRUCTIONS = [
	'You drive the task\'s browser with one tool, `agent_browser`, which runs one agent-browser command per call. `args` is the list of arguments after `agent-browser`, for example ["open", "https://example.com"], ["snapshot", "-i"], ["click", "@e3"] or ["fill", "@e2", "some text"]. It is not a shell: write no quotes around arguments, and use no pipes, redirects, environment variables or `export`. For `eval --stdin`, put the script in `stdin`. The browser session is already set up and closes itself when the task ends.',
	"The guide below is agent-browser's own; its examples are shell commands, so turn each into an `args` list, and skip what this tool refuses: downloads, uploads, installs, cookies and saved state, the auth vault, plugins, and changes to the browser's network, proxy or launch settings. Its references are served by `skills get core --full`.",
	"To look at a page, call `snapshot` (add `-i` for interactive elements only) or `screenshot`. A screenshot is shown to you; set `keep: true` on the `screenshot` call to also attach it to the reply of the agent that handed you this task, which is how the agent shows what the page looked like. Keep only what the task needs.",
].join("\n\n");

const AGENT_BROWSER_TOOL = {
	name: "agent_browser",
	description:
		'Run one agent-browser command in this task\'s browser and get its output. `args` are the arguments after `agent-browser`, as a list (not a shell line), such as ["open", "https://example.com"] or ["snapshot", "-i"]. `screenshot` takes no path; set `keep` to attach the image to the reply. Downloads, uploads, installs, cookie or state import and export, logins, plugins and network or proxy settings are refused.',
	parameters: Type.Object({
		args: Type.Array(Type.String({ maxLength: 4_000 }), {
			minItems: 1,
			maxItems: 64,
			description:
				"The arguments after `agent-browser`, one list item per argument.",
		}),
		stdin: Type.Optional(
			Type.String({
				maxLength: 65_536,
				description:
					"Text for the command's standard input, such as the script of `eval --stdin`.",
			}),
		),
		keep: Type.Optional(
			Type.Boolean({
				description:
					"With `screenshot`: also attach the image to the reply. Ignored by other commands.",
			}),
		),
	}),
} as const;

/**
 * The default driver: agent-browser and Chromium in a Docker container started for each task and
 * removed after it, with no network but a unix socket to a proxy on the host that refuses every
 * destination that is not a public address. See the package README for the isolation it gives.
 */
export function agentBrowserDriver(
	options: AgentBrowserDriverOptions = {},
): BrowserDriver {
	const binary = options.binary ?? "docker";
	const image = options.image ?? DEFAULT_BROWSER_IMAGE;
	const commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
	return {
		async check() {
			await requireDocker(binary);
			const { uid } = ownerOf(options);
			if (uid <= 0)
				throw new PluginError(
					"the browser container must run as a non-root user: run the host as one, or pass docker: { user: { uid, gid } }.",
				);
			const found = await docker(
				binary,
				["image", "inspect", image, "--format", "{{.Id}}"],
				{
					timeoutMs: 15_000,
				},
			);
			if (found.code !== 0)
				throw new PluginError(
					`the browser image ${image} is not built on this machine. Build it once with: ${browserImageBuildCommand(image)}`,
				);
			await sweepStale(binary);
		},

		async start(context: BrowserTaskContext): Promise<BrowserTaskKit> {
			const { signal, limits } = context;
			const name = `pi-roundtable-browser-${randomBytes(6).toString("hex")}`;
			const dir = mkdtempSync(join(tmpdir(), "prb-"));
			let proxy: EgressProxy | undefined;
			const remove = async () => {
				const failures: string[] = [];
				const removed = await docker(binary, ["rm", "--force", name], {
					timeoutMs: 20_000,
				}).catch((error: unknown) => ({
					code: 1,
					stderr: String(error),
				}));
				if (removed.code !== 0 && !/No such container/i.test(removed.stderr))
					failures.push(
						`the container ${name} was not removed (${firstLine(removed.stderr)}); remove it with \`${binary} rm --force ${name}\``,
					);
				await proxy?.close().catch(() => undefined);
				rmSync(dir, { recursive: true, force: true });
				if (failures.length > 0) throw new Error(failures.join("; "));
			};
			try {
				proxy = await EgressProxy.listen({
					socketPath: join(dir, "proxy.sock"),
					...(options.ports ? { ports: options.ports } : {}),
					...(options.onRefused ? { onRefused: options.onRefused } : {}),
				});
				const { uid, gid } = ownerOf(options);
				const started = await docker(
					binary,
					browserContainerArgs({
						name,
						image,
						egressDir: dir,
						uid,
						gid,
						memoryMb: options.memoryMb ?? 1024,
						cpus: options.cpus ?? 1.5,
						pids: options.pids ?? 512,
						lifetimeSeconds: Math.ceil(limits.timeoutMs / 1000) + 120,
						maxOutputChars: limits.maxOutputChars,
						hostPid: process.pid,
					}),
					{ signal, timeoutMs: 60_000 },
				);
				if (started.code !== 0)
					throw new Error(
						`the browser container did not start (${firstLine(started.stderr)}). If the image is missing, build it with: ${browserImageBuildCommand(image)}`,
					);
				await exec(["mkdir", "-p", SCREENSHOT_DIR]);
				const guide = await exec(["agent-browser", "skills", "get", "core"], {
					maxBytes: 512 * 1024,
				});
				if (guide.code !== 0)
					throw new Error(
						`the browser image does not serve agent-browser's guide (${firstLine(guide.stderr)}); rebuild it with: ${browserImageBuildCommand(image)}`,
					);
				const skill: BrowserSkill = {
					name: "agent-browser core guide",
					content: new TextDecoder()
						.decode(guide.stdout)
						.replace(SKILL_FRONT_MATTER, ""),
				};
				return makeKit(skill);
			} catch (error) {
				await remove().catch(() => undefined);
				throw error;
			}

			function exec(
				args: readonly string[],
				extra: { stdin?: string; maxBytes?: number } = {},
			) {
				return docker(
					binary,
					[
						"exec",
						...(extra.stdin === undefined ? [] : ["--interactive"]),
						"--workdir",
						"/tmp",
						name,
						...args,
					],
					{
						signal,
						timeoutMs: commandTimeoutMs,
						maxBytes: extra.maxBytes ?? limits.maxOutputChars * 4,
						...(extra.stdin === undefined ? {} : { stdin: extra.stdin }),
					},
				);
			}

			function makeKit(skill: BrowserSkill): BrowserTaskKit {
				// One command at a time: the worker may emit several calls in one message.
				let queue: Promise<unknown> = Promise.resolve();
				let shots = 0;
				const serial = <T>(work: () => Promise<T>): Promise<T> => {
					const next = queue.then(work, work);
					queue = next.catch(() => undefined);
					return next;
				};
				/** Runs one agent-browser command; a failure is an error the worker reads. */
				const agentBrowser = async (
					args: readonly string[],
					stdin?: string,
				): Promise<string> => {
					const result = await exec(
						["agent-browser", ...args],
						stdin === undefined ? {} : { stdin },
					);
					const text = new TextDecoder().decode(result.stdout).trim();
					if (result.code !== 0)
						throw new BrowserToolError(
							`agent-browser exited with ${result.code}: ${(result.stderr.trim() || text).slice(0, 4_000)}`,
						);
					return text;
				};
				/** Takes a screenshot into the container, reads it back, and optionally keeps it for the reply. */
				const screenshot = async (flags: readonly string[], keep: boolean) => {
					if (flags.some((flag) => flag !== "--full" && flag !== "--annotate"))
						throw new BrowserToolError(
							"screenshot takes no path and only the flags --full and --annotate; the image is shown to you, and keep: true attaches it to the reply.",
						);
					const path = `${SCREENSHOT_DIR}/${++shots}.png`;
					await agentBrowser(["screenshot", ...flags, path]);
					const image = await exec(["cat", path], {
						maxBytes: limits.maxScreenshotBytes + 1,
					});
					void exec(["rm", "-f", path]).catch(() => undefined);
					if (image.code !== 0 || image.truncated)
						throw new BrowserToolError(
							image.truncated
								? `The screenshot is over ${limits.maxScreenshotBytes} bytes. Take it without --full, or scroll to what you need first.`
								: "The screenshot could not be read back.",
						);
					const picture = { mimeType: "image/png", data: image.stdout };
					if (!keep) return { text: "Screenshot taken.", images: [picture] };
					const kept = context.keepScreenshot(picture);
					return {
						text: `Screenshot taken and kept for the reply (${kept} of at most ${limits.maxScreenshots}).`,
						images: [picture],
					};
				};
				return {
					prompt: INSTRUCTIONS,
					skills: [skill],
					tools: [
						browserTool({
							...AGENT_BROWSER_TOOL,
							execute: ({ args, stdin, keep }) =>
								serial(async () => {
									const refusal = refuseAgentBrowserCommand(args);
									if (refusal) throw new BrowserToolError(refusal);
									if (args[0] === "screenshot")
										return screenshot(args.slice(1), keep === true);
									const result = await agentBrowser(args, stdin);
									return { text: result || "(no output)" };
								}),
						}),
					],
					dispose: remove,
				};
			}
		},
	};
}
