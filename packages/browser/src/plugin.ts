import {
	definePlugin,
	defineTool,
	PluginError,
	ReplyFileError,
	type ThinkingLevel,
	ToolRefusal,
	WORKER_SESSIONS,
} from "pi-roundtable";
import { Type } from "typebox";
import {
	type AgentBrowserDriverOptions,
	agentBrowserDriver,
} from "./agent-browser-driver.ts";
import {
	type BrowserDriver,
	type BrowserImage,
	type BrowserLimits,
	DEFAULT_BROWSER_LIMITS,
} from "./driver.ts";
import { runBrowserTask } from "./task.ts";

export interface BrowserAgentOptions {
	/** How a task gets a browser. Default: agent-browser in a Docker container, see `agentBrowserDriver`. */
	driver?: BrowserDriver;
	/** Options of the default driver; ignored when `driver` is given. */
	docker?: AgentBrowserDriverOptions;
	/** `<provider>/<model id>` of the worker; default: the host's `delegation.model`. */
	model?: string;
	/** Default: the host's `delegation.thinking`. */
	thinking?: ThinkingLevel;
	/** Task limits; each unset one keeps its default, see `DEFAULT_BROWSER_LIMITS`. */
	limits?: Partial<BrowserLimits>;
	/** Tasks that may run at once; the next call is refused until one ends. Default 2. */
	maxConcurrentTasks?: number;
}

const MAX_TASK_CHARS = 4_000;
const MAX_URL_CHARS = 2_000;

function positive(name: string, value: number, max: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > max)
		throw new PluginError(
			`browserAgent: ${name} must be a whole number from 1 to ${max}; got ${String(value)}.`,
		);
	return value;
}

function resolveLimits(
	given: Partial<BrowserLimits> | undefined,
): BrowserLimits {
	const limits = { ...DEFAULT_BROWSER_LIMITS, ...given };
	positive("limits.timeoutMs", limits.timeoutMs, 60 * 60_000);
	positive("limits.maxSteps", limits.maxSteps, 500);
	positive("limits.maxScreenshots", limits.maxScreenshots, 10);
	// The core attaches at most 10 MiB per file.
	positive(
		"limits.maxScreenshotBytes",
		limits.maxScreenshotBytes,
		10 * 1024 * 1024,
	);
	positive("limits.maxOutputChars", limits.maxOutputChars, 200_000);
	return limits;
}

function startUrl(raw: string | undefined): string | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new ToolRefusal(
			"url must be a full http or https address, such as https://example.com/page.",
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new ToolRefusal("url must start with http:// or https://.");
	return url.href;
}

function extension(image: BrowserImage): string {
	return image.mimeType === "image/jpeg"
		? "jpg"
		: (image.mimeType.split("/")[1] ?? "png");
}

/**
 * Adds `browser_task`: a fresh worker session drives a real browser through the driver's tools and
 * reports back, and the screenshots it keeps are attached to the agent's reply. Owner tier unless
 * the host lowers it with `toolTiers`.
 */
export function browserAgent(options: BrowserAgentOptions = {}) {
	const limits = resolveLimits(options.limits);
	const maxTasks = positive(
		"maxConcurrentTasks",
		options.maxConcurrentTasks ?? 2,
		16,
	);
	if (options.model !== undefined && !/^[^/\s]+\/\S+$/.test(options.model))
		throw new PluginError(
			"browserAgent: model must be provider/model-id, such as anthropic/claude-sonnet-5-5.",
		);
	return definePlugin({
		name: "browser",
		requires: [WORKER_SESSIONS],
		async setup(context) {
			const driver =
				options.driver ??
				agentBrowserDriver({
					...options.docker,
					onRefused: (destination, reason) => {
						context.logger.info(
							{ destination, reason },
							"the browser's request was refused",
						);
						options.docker?.onRefused?.(destination, reason);
					},
				});
			await driver.check?.();
			const sessions = context.services.get(WORKER_SESSIONS);
			const running = new Set<{
				stop: AbortController;
				done: Promise<unknown>;
			}>();
			return {
				tools: [
					defineTool({
						name: "browser_task",
						description:
							"Hand a task that needs a real web browser to a browser worker: it opens pages, reads them, clicks, fills in forms, and takes screenshots, then returns a written report. Use it for pages that web search or a plain fetch cannot get (scripts, forms, dashboards), or when how a page looks matters. The worker starts with no logins and cannot reach private networks, so say what to find out, from where, and what to report; it works alone for a few minutes. Screenshots it keeps are attached to your reply.",
						parameters: Type.Object({
							task: Type.String({
								minLength: 1,
								maxLength: MAX_TASK_CHARS,
								description:
									"What to do in the browser and what to report back. Self-contained: the worker sees nothing of this conversation.",
							}),
							url: Type.Optional(
								Type.String({
									maxLength: MAX_URL_CHARS,
									description:
										"The page to start from, as a full http(s) address.",
								}),
							),
						}),
						minTier: "owner",
						run: async ({ task, url }, turn) => {
							const start = startUrl(url);
							if (running.size >= maxTasks)
								throw new ToolRefusal(
									`${maxTasks} browser tasks are already running. Wait for one to finish, then call again.`,
								);
							const text = start
								? `${task.trim()}\n\nStart from this page: ${start}`
								: task.trim();
							const stop = new AbortController();
							const signal = turn.signal
								? AbortSignal.any([turn.signal, stop.signal])
								: stop.signal;
							const work = runBrowserTask(
								{
									sessions,
									driver,
									limits,
									...(options.model ? { model: options.model } : {}),
									...(options.thinking ? { thinking: options.thinking } : {}),
									task: text,
									signal,
								},
								(message, error) =>
									context.logger.warn({ err: error }, message),
							);
							const entry = { stop, done: work.catch(() => undefined) };
							running.add(entry);
							const result = await work.finally(() => running.delete(entry));
							const notes: string[] = [];
							let attached = 0;
							for (const [index, image] of result.screenshots.entries())
								try {
									turn.attachFile({
										name: `browser-${index + 1}.${extension(image)}`,
										data: image.data,
									});
									attached++;
								} catch (error) {
									if (!(error instanceof ReplyFileError)) throw error;
									notes.push(
										`Screenshot ${index + 1} could not be attached: ${error.message}`,
									);
								}
							if (attached > 0)
								notes.unshift(
									`${attached} screenshot${attached === 1 ? " is" : "s are"} attached to your reply.`,
								);
							if (result.status === "timeout")
								return [
									`The browser task ran out of time (${Math.round(limits.timeoutMs / 1000)} seconds) before the worker reported. Narrow the task, or split it, and try again.`,
									...notes,
								].join("\n\n");
							return [result.report, ...notes].join("\n\n");
						},
					}),
				],
				services: [
					{
						name: "browser-tasks",
						busy: () => [...running].map(() => "browser task"),
						stop: async () => {
							for (const entry of running) entry.stop.abort();
							await Promise.all([...running].map((entry) => entry.done));
						},
					},
				],
			};
		},
	});
}
