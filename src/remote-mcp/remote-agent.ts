import { randomUUID } from "node:crypto";
import type { ChannelKey, Logger, TurnResult } from "pi-roundtable";
import { REMOTE_MCP_MESSAGES, type RemoteMcpMessages } from "./messages.ts";
import type { RemoteSessionStore } from "./remote-session-store.ts";

/** A dispatch the caller should fix rather than retry as is. */
export class RemoteAgentError extends Error {
	constructor(
		readonly code: "SESSION_NOT_FOUND" | "RUN_IN_PROGRESS" | "RUN_NOT_FOUND",
	) {
		super(code);
	}
}

export type RunStatus =
	| { status: "working" }
	| { status: "completed"; text: string }
	| { status: "failed"; error: string };

interface Run {
	sessionId: string;
	state: RunStatus;
	finishedAt?: number;
}

export interface RemoteAgentOptions {
	sessions: Pick<RemoteSessionStore, "create" | "touch">;
	/** Runs one owner turn in the session's channel; never rejects. */
	answer(channel: ChannelKey, text: string): Promise<TurnResult>;
	logger: Logger;
	/** A run still working after this long is reported failed. */
	timeoutMs?: number;
	/** A finished run can be polled for this long. */
	keepMs?: number;
	messages?: Pick<RemoteMcpMessages, "relayNote" | "runFailed">;
}

const SESSION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The session's owner channel; separate from every Discord channel. */
export const remoteChannel = (sessionId: string): ChannelKey =>
	`mcp:${sessionId}`;

/**
 * Turns an outside agent relays for the owner. A dispatch returns at once; the caller polls
 * the run. Runs live in memory: a restart forgets them, but not their sessions.
 */
export class RemoteAgent {
	readonly #options: RemoteAgentOptions;
	readonly #text: Pick<RemoteMcpMessages, "relayNote" | "runFailed">;
	readonly #runs = new Map<string, Run>();

	constructor(options: RemoteAgentOptions) {
		this.#options = options;
		this.#text = options.messages ?? REMOTE_MCP_MESSAGES;
	}

	async dispatch(
		message: string,
		sessionId?: string,
	): Promise<{ runId: string; sessionId: string }> {
		this.#prune();
		const session = await this.#session(sessionId);
		const runId = randomUUID();
		const run: Run = { sessionId: session, state: { status: "working" } };
		this.#runs.set(runId, run);
		void this.#run(run, runId, message);
		return { runId, sessionId: session };
	}

	result(runId: string): RunStatus {
		const run = this.#runs.get(runId);
		if (!run) throw new RemoteAgentError("RUN_NOT_FOUND");
		return run.state;
	}

	/** A new session, or the named one when it exists and has no run working. */
	async #session(sessionId: string | undefined): Promise<string> {
		const { sessions } = this.#options;
		if (sessionId === undefined) return sessions.create();
		if (!SESSION_ID.test(sessionId) || !(await sessions.touch(sessionId)))
			throw new RemoteAgentError("SESSION_NOT_FOUND");
		const working = [...this.#runs.values()].some(
			(run) => run.sessionId === sessionId && run.state.status === "working",
		);
		if (working) throw new RemoteAgentError("RUN_IN_PROGRESS");
		return sessionId;
	}

	async #run(run: Run, runId: string, message: string): Promise<void> {
		const { answer, logger, timeoutMs = 30 * 60_000 } = this.#options;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<TurnResult>((resolve) => {
			timer = setTimeout(
				() => resolve({ ok: false, error: new Error("timed out") }),
				timeoutMs,
			);
		});
		const result = await Promise.race([
			answer(
				remoteChannel(run.sessionId),
				`${this.#text.relayNote}\n${message}`,
			),
			timedOut,
		]);
		clearTimeout(timer);
		if (result.ok) {
			run.state = { status: "completed", text: result.text };
		} else {
			logger.error(
				{ runId, sessionId: run.sessionId, err: result.error },
				"remote run failed",
			);
			run.state = { status: "failed", error: this.#text.runFailed };
		}
		run.finishedAt = Date.now();
	}

	#prune(): void {
		const keepMs = this.#options.keepMs ?? 60 * 60_000;
		for (const [id, run] of this.#runs) {
			if (run.finishedAt !== undefined && Date.now() - run.finishedAt > keepMs)
				this.#runs.delete(id);
		}
	}
}
