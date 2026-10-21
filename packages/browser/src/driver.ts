import type { Static, TSchema } from "typebox";

/** What a task may use, each with a safe default. */
export interface BrowserLimits {
	/** The whole task, from the first tool call to the report, in milliseconds; default 5 minutes. */
	timeoutMs: number;
	/** Tool calls the worker may make; the next one is refused. Default 40. */
	maxSteps: number;
	/** Screenshots the worker may keep for the agent's reply; default 4. */
	maxScreenshots: number;
	/** The largest screenshot, kept or only looked at, in bytes; default 4 MiB. */
	maxScreenshotBytes: number;
	/** The longest text one tool call may hand the worker, in characters; default 24,000. */
	maxOutputChars: number;
}

export const DEFAULT_BROWSER_LIMITS: Readonly<BrowserLimits> = Object.freeze({
	timeoutMs: 5 * 60_000,
	maxSteps: 40,
	maxScreenshots: 4,
	maxScreenshotBytes: 4 * 1024 * 1024,
	maxOutputChars: 24_000,
});

/** A screenshot, or any image, as bytes. */
export interface BrowserImage {
	/** `image/png`, `image/jpeg`, `image/gif` or `image/webp`. */
	mimeType: string;
	data: Uint8Array;
}

/** What one tool call returns to the worker: text, and images it can look at. */
export interface BrowserToolResult {
	text: string;
	images?: readonly BrowserImage[];
}

/**
 * A call the worker should correct, such as a command the driver refuses: its message becomes the
 * tool's error result. Any other error also fails the call, with its text scrubbed of secrets.
 */
export class BrowserToolError extends Error {
	override name = "BrowserToolError";
}

/** One tool of the worker. The worker's model reads `description` and fills `parameters`. */
export interface BrowserTool<Schema extends TSchema = TSchema> {
	/** Lowercase words joined by underscores; unique within the task. */
	name: string;
	description: string;
	/** The arguments as a Typebox schema; the call is checked against it before `execute` runs. */
	parameters: Schema;
	/** Aborted when the task is cancelled, times out, or the host stops. */
	execute(
		input: Static<Schema>,
		signal: AbortSignal,
	): Promise<BrowserToolResult>;
}

/** Types a tool's `input` from its schema, and fits it in the list of a kit's tools. */
export function browserTool<Schema extends TSchema>(
	tool: BrowserTool<Schema>,
): BrowserTool {
	// SAFETY: the host checks every call against `parameters` before `execute`, so the input has the schema's type.
	return tool as unknown as BrowserTool;
}

/** Instructions the worker reads as part of its system prompt, such as a tool's usage guide. */
export interface BrowserSkill {
	name: string;
	/** The full text, without front matter. */
	content: string;
}

/** What a driver is told about a task. */
export interface BrowserTaskContext {
	/** Aborted when the turn is cancelled, the time limit passes, or the host stops. */
	signal: AbortSignal;
	limits: Readonly<BrowserLimits>;
	/**
	 * Keeps an image for the agent's reply, once the task ends. Throws a `BrowserToolError` when the
	 * screenshot count or size limit refuses it; the message tells the worker why. Returns how many
	 * images are kept so far.
	 */
	keepScreenshot(image: BrowserImage): number;
}

/** The worker's tools and instructions for one task, and the means to clean up after it. */
export interface BrowserTaskKit {
	tools: readonly BrowserTool[];
	skills?: readonly BrowserSkill[];
	/** Added to the worker's system prompt after the standing rules, for example how to keep a screenshot. */
	prompt?: string;
	/** Closes the task's browser and removes everything it made. Called once, whether the task succeeded, failed or was cancelled. */
	dispose(): Promise<void>;
}

/**
 * The extension point: how a task gets a browser. A driver builds, for one task, the tools and
 * skills the worker may use, and cleans up after it. The package's default drives agent-browser in
 * a Docker container; another driver can drive any browser, as long as it keeps the task's
 * browser from reaching what the host should not expose.
 */
export interface BrowserDriver {
	/** Runs at startup; throws a `PluginError` naming the fix when the driver cannot work. */
	check?(): Promise<void>;
	/** Prepares one task's browser. A rejection leaves nothing behind that `dispose` would remove. */
	start(context: BrowserTaskContext): Promise<BrowserTaskKit>;
}
