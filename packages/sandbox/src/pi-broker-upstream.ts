import type { ChannelKey, Logger } from "pi-roundtable";
import { scrubDiagnostic } from "pi-roundtable/kit";
import { PI_MEDIA_LIMITS } from "./pi-protocol.ts";
import { isRecord } from "./protocol.ts";

const RESPONSE_HEADERS = ["content-type", "request-id", "x-should-retry"];
/** Headers the worker's client uses to back off or recover; each value is short and checked. */
function passthroughHeader(name: string): boolean {
	return (
		name === "retry-after" ||
		name.startsWith("anthropic-ratelimit-") ||
		RESPONSE_HEADERS.includes(name)
	);
}
/** An error's name, message and cause chain, for a log line. */
export function errorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const text = `${error.name}: ${error.message}`;
	return error.cause === undefined
		? text
		: `${text} (cause: ${errorText(error.cause)})`;
}
/**
 * Watches a server-sent event stream as it passes and reports its first `error` event: an
 * upstream can fail mid-answer after a 200, which the status alone never shows.
 */
function sseErrorWatcher(
	onError: (data: string) => void,
): (chunk: Uint8Array, done: boolean) => void {
	const decoder = new TextDecoder();
	let pending = "";
	let reported = false;
	const scan = (event: string) => {
		const lines = event.split(/\r?\n/);
		const type = lines
			.find((line) => line.startsWith("event:"))
			?.slice(6)
			.trim();
		const data = lines
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		let typed: unknown;
		try {
			typed = JSON.parse(data);
		} catch {
			typed = undefined;
		}
		if (type === "error" || (isRecord(typed) && typed.type === "error")) {
			reported = true;
			onError(data);
		}
	};
	return (chunk, done) => {
		if (reported) return;
		pending += decoder.decode(chunk, { stream: !done });
		const events = pending.split(/\r?\n\r?\n/);
		pending = done ? "" : (events.pop() ?? "");
		// An event this long is no error report; keep scanning without holding it.
		if (pending.length > 64 * 1024) pending = "";
		for (const event of events) if (!reported) scan(event);
	};
}

function streamBounded(
	response: Response,
	signal: AbortSignal,
	maxBytes: number,
	secret: string,
	onFailure: (error: unknown) => void,
	watch?: (chunk: Uint8Array, done: boolean) => void,
): ReadableStream<Uint8Array> {
	const reader = response.body?.getReader();
	let total = 0;
	let carry = Buffer.alloc(0);
	const variants = [
		secret,
		encodeURIComponent(secret),
		Buffer.from(secret).toString("base64"),
		Buffer.from(secret).toString("base64url"),
		Buffer.from(secret).toString("hex"),
	]
		.filter(Boolean)
		.map((s) => Buffer.from(s));
	const tail = Math.max(0, ...variants.map((s) => s.length)) - 1;
	return new ReadableStream({
		async pull(controller) {
			try {
				signal.throwIfAborted();
				const result = await reader?.read();
				const data = Buffer.concat([carry, result?.value ?? new Uint8Array()]);
				if (variants.some((s) => data.includes(s)))
					throw new Error("Credential reflected");
				total += result?.value?.byteLength ?? 0;
				if (total > maxBytes) throw new Error("Response too large");
				watch?.(result?.value ?? new Uint8Array(), !result || result.done);
				if (!result || result.done) {
					if (data.length) controller.enqueue(data);
					controller.close();
					return;
				}
				const cut = Math.max(0, data.length - tail);
				if (cut) controller.enqueue(data.subarray(0, cut));
				carry = data.subarray(cut);
			} catch (error) {
				onFailure(error);
				await reader?.cancel().catch(() => {});
				controller.error(new Error("Broker response failed"));
			}
		},
		cancel: () => reader?.cancel(),
	});
}

/** At most `limit` bytes of a body as text; the rest is cancelled, never read. */
async function bodyHead(
	body: ReadableStream<Uint8Array>,
	limit: number,
): Promise<string> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} catch {
		// The worker's branch reports a broken stream; the log keeps what arrived.
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}
/** A credential as it may appear in text: raw, URL-encoded, base64 and hex. */
function secretForms(secret: string): string[] {
	if (!secret) return [];
	return [
		secret,
		encodeURIComponent(secret),
		Buffer.from(secret).toString("base64"),
		Buffer.from(secret).toString("base64url"),
		Buffer.from(secret).toString("hex"),
	];
}
/** A compactor's answer, or a rejection once the signal aborts, even if the compactor ignores it. */
export function abortableCompact<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
/** Logs a failed upstream call; the secret is masked wherever it shows. */
export type FailureLog = (
	secret: string,
	failure: { status?: number; body?: string; error?: unknown },
) => void;

/** Logs a failed upstream call with its latency; the body and error lose any credential. */
export function failureLog(
	logger: Logger | undefined,
	channel: ChannelKey,
	upstream: string,
): FailureLog {
	const started = Date.now();
	return (secret, failure) => {
		const clean = (text: string) =>
			scrubDiagnostic(
				secretForms(secret).reduce(
					(masked, form) => masked.replaceAll(form, "[redacted]"),
					text,
				),
				2000,
			);
		logger?.warn(
			{
				channel,
				upstream,
				...(failure.status === undefined ? {} : { status: failure.status }),
				latencyMs: Date.now() - started,
				...(failure.body === undefined ? {} : { body: clean(failure.body) }),
				...(failure.error === undefined
					? {}
					: { error: clean(errorText(failure.error)) }),
			},
			"sandbox upstream call failed",
		);
	};
}
/** The upstream call a broker request becomes, and what the worker is told of its answer. */
export async function forwardUpstream(call: {
	fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
	target: string;
	headers: Headers;
	body: Record<string, unknown>;
	signal: AbortSignal;
	secret: string;
	/** An MCP server's answer also carries its session id. */
	isMcp: boolean;
	failed: FailureLog;
}): Promise<Response> {
	const { fetchImpl, target, headers, body, signal, secret, isMcp, failed } =
		call;
	const upstream = await fetchImpl(target, {
		method: "POST",
		redirect: "error",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	// Errors keep their status, body and back-off headers so the worker can recognize an
	// oversized context, a rate limit or an expired MCP session; the same scans apply.
	const outgoing = new Headers();
	for (const [name, value] of upstream.headers) {
		if (
			passthroughHeader(name) &&
			value.length <= 256 &&
			!value.includes(secret)
		)
			outgoing.set(name, value);
	}
	if (isMcp) {
		const id = upstream.headers.get("mcp-session-id");
		if (id && !id.includes(secret) && id.length <= 256)
			outgoing.set("mcp-session-id", id);
	}
	if (upstream.status < 200 || upstream.status > 599) {
		failed(secret, { status: upstream.status });
		return new Response("Upstream refused", { status: 502 });
	}
	let answer = upstream;
	if (upstream.status >= 400 && upstream.body) {
		// The log reads the error body's head from one branch; the worker gets all of it from the other.
		const [logged, sent] = upstream.body.tee();
		void bodyHead(logged, 64 * 1024).then((body) =>
			failed(secret, { status: upstream.status, body }),
		);
		answer = new Response(sent, { status: upstream.status });
	} else if (upstream.status >= 400)
		failed(secret, { status: upstream.status });
	return new Response(
		upstream.status === 204 || upstream.status === 205
			? null
			: streamBounded(
					answer,
					signal,
					PI_MEDIA_LIMITS.totalFileBytes,
					secret,
					(error) => failed(secret, { status: upstream.status, error }),
					upstream.status < 400 &&
						(upstream.headers.get("content-type") ?? "").includes(
							"text/event-stream",
						)
						? sseErrorWatcher((body) =>
								failed(secret, {
									status: upstream.status,
									body: `stream error event: ${body}`,
								}),
							)
						: undefined,
				),
		{ headers: outgoing, status: upstream.status },
	);
}
