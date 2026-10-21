import { PluginError } from "pi-roundtable";

export interface ExecResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
	/** Output was cut at `maxBytes`. */
	truncated: boolean;
}

async function readBounded(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	onFull: () => void,
): Promise<{ data: Uint8Array; truncated: boolean }> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	for await (const chunk of stream) {
		if (truncated) continue;
		const room = maxBytes - size;
		if (chunk.byteLength > room) {
			chunks.push(chunk.subarray(0, room));
			size = maxBytes;
			truncated = true;
			onFull();
		} else {
			chunks.push(chunk);
			size += chunk.byteLength;
		}
	}
	return { data: Buffer.concat(chunks), truncated };
}

/**
 * Runs `docker <args>` and returns its bounded output. Aborting, or running past `timeoutMs`,
 * kills the Docker client at once (SIGKILL: SIGTERM can be proxied into a container's PID 1 and
 * ignored) and rejects with the signal's reason, or a timeout error, without waiting for output
 * that something else still holds open.
 */
export async function docker(
	binary: string,
	args: readonly string[],
	options: {
		signal?: AbortSignal;
		stdin?: string;
		maxBytes?: number;
		timeoutMs?: number;
	} = {},
): Promise<ExecResult> {
	options.signal?.throwIfAborted();
	const child = Bun.spawn([binary, ...args], {
		stdin: options.stdin === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const kill = () => child.kill("SIGKILL");
	const stop = new AbortController();
	stop.signal.addEventListener("abort", kill, { once: true });
	const forward = () => stop.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", forward, { once: true });
	const timer = options.timeoutMs
		? setTimeout(
				() =>
					stop.abort(
						new Error(
							`\`${binary} ${args[0] ?? ""}\` did not finish within ${options.timeoutMs} ms`,
						),
					),
				options.timeoutMs,
			)
		: undefined;
	const gone = new Promise<never>((_resolve, reject) =>
		stop.signal.addEventListener("abort", () => reject(stop.signal.reason), {
			once: true,
		}),
	);
	try {
		if (options.stdin !== undefined && child.stdin) {
			child.stdin.write(options.stdin);
			await child.stdin.end();
		}
		const maxBytes = options.maxBytes ?? 1024 * 1024;
		const work = Promise.all([
			readBounded(child.stdout, maxBytes, kill),
			readBounded(child.stderr, 64 * 1024, () => undefined),
			child.exited,
		]);
		work.catch(() => undefined);
		const [out, err, code] = await Promise.race([work, gone]);
		return {
			code,
			stdout: out.data,
			stderr: new TextDecoder().decode(err.data),
			truncated: out.truncated,
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", forward);
		kill();
		await child.exited;
	}
}

/** The first line of Docker's complaint, short enough for a message. */
export function firstLine(text: string): string {
	return (text.trim().split("\n")[0] ?? "").slice(0, 300);
}

/** Throws a PluginError naming the fix unless a Docker daemon answers. */
export async function requireDocker(binary: string): Promise<void> {
	let result: ExecResult | undefined;
	let failure = "";
	try {
		result = await docker(
			binary,
			["version", "--format", "{{.Server.Version}}"],
			{ timeoutMs: 15_000 },
		);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	if (result?.code !== 0)
		throw new PluginError(
			`the browser worker needs Docker, and ${
				result
					? `the daemon did not answer (${firstLine(result.stderr)})`
					: `\`${binary}\` could not run (${firstLine(failure)})`
			}. Install Docker and start its daemon (\`${binary} info\` must work), or pass docker: { binary } with the path of its CLI.`,
		);
}
