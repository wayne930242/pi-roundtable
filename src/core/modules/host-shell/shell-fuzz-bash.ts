import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs a generated line with real bash on a PATH that holds only stubs. The one stub that matters
 * is `sudo`, which creates a marker file; the others only run the program they are given, so a
 * wrapper such as `env` or `xargs` runs the stub and nothing real is on the PATH. Each worker has a
 * scratch directory of its own to run in.
 */

/** The bash programs available: the system one (3.2 on macOS) and the first on the PATH. */
export const BASHES: readonly string[] = [
	...new Set(
		[Bun.which("bash"), "/bin/bash"].filter(
			(path): path is string => path !== null && existsSync(path),
		),
	),
];

/**
 * The stub programs, by name: `sudo` creates the marker, the wrappers (`env`, `nice`, `timeout`,
 * `xargs`, ...) skip their own options and run the rest as a command, and `bash` and `sh` run the
 * bash being tested. Nothing else is on the PATH.
 */
export const STUBS: Readonly<Record<string, string>> = {
	env: `while [ $# -gt 0 ]; do case "$1" in -u|-P) shift 2;; -*) shift;; *=*) shift;; *) break;; esac; done; exec "$@"`,
	nice: `while [ $# -gt 0 ]; do case "$1" in -n) shift 2;; -*) shift;; *) break;; esac; done; exec "$@"`,
	ionice: `while [ $# -gt 0 ]; do case "$1" in -c|-n|-p|-t|-u) shift 2;; -*) shift;; *) break;; esac; done; exec "$@"`,
	timeout: `while [ $# -gt 0 ]; do case "$1" in -s|-k) shift 2;; -*) shift;; *) break;; esac; done; shift; exec "$@"`,
	xargs: `repl=; while [ $# -gt 0 ]; do case "$1" in -I|-J) repl=$2; shift 2;; -I?*|-J?*) repl=\${1#-?}; shift;; -n|-P|-L|-s|-d|-E|-a) shift 2;; -*) shift;; *) break;; esac; done; if [ -n "$repl" ]; then IFS= read -r input; for a; do case "$a" in "$repl") set -- "$@" "$input";; *) set -- "$@" "$a";; esac; shift; done; else input=$(while IFS= read -r line; do printf '%s\\n' "$line"; done); set -- "$@" $input; fi; [ $# -gt 0 ] || set -- echo; exec "$@"`,
	nohup: `while [ $# -gt 0 ]; do case "$1" in -*) shift;; *) break;; esac; done; exec "$@"`,
	stdbuf: `while [ $# -gt 0 ]; do case "$1" in -i|-o|-e) shift 2;; -*) shift;; *) break;; esac; done; exec "$@"`,
	setsid: `while [ $# -gt 0 ]; do case "$1" in -*) shift;; *) break;; esac; done; exec "$@"`,
	unbuffer: `while [ $# -gt 0 ]; do case "$1" in -*) shift;; *) break;; esac; done; exec "$@"`,
	caffeinate: `while [ $# -gt 0 ]; do case "$1" in -*) shift;; *) break;; esac; done; exec "$@"`,
	find: `while [ "$#" -gt 0 ] && [ "$1" != "-exec" ]; do shift; done; shift; exec "$@"`,
	bash: `exec "$REAL_BASH" "$@"`,
	sh: `exec "$REAL_BASH" "$@"`,
	// Only a run of the program counts: `bash sudo` and `. sudo` read this script from the PATH, which the real binary does not allow.
	sudo: `case "$0" in */sudo) : >> "$MARKER";; esac`,
	// With files it reads them to the end, which waits for a process substitution to finish.
	cat: `if [ "$#" -gt 0 ]; then for f; do while IFS= read -r line; do printf '%s\\n' "$line"; done < "$f"; done 2>/dev/null; exit 0; fi; while IFS= read -r line; do echo "$line"; done`,
};

/** Kills the process group of `pid` (the leader of a session of its own) with everything in it. */
function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The group has already gone.
	}
}

/** Kills a group and waits until it has no process left; false when something outlived the kills. */
async function killGroupAndWait(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 20; attempt++) {
		killGroup(pid);
		try {
			process.kill(-pid, 0);
		} catch {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
}

interface Worker {
	cwd: string;
}

/** A pool of workers that run lines in parallel; `close` removes everything it made. */
export class BashRunner {
	readonly #root = realpathSync(mkdtempSync(join(tmpdir(), "shell-fuzz-")));
	readonly #stubs = join(this.#root, "bin");
	readonly #idle: Worker[] = [];
	/** The process groups of the lines now running, which the runner kills whatever ends it. */
	readonly #groups = new Set<number>();
	#runs = 0;
	readonly #waiting: Array<(worker: Worker) => void> = [];
	readonly size: number;
	/** The most processes the user may have while a line runs: now, and room for the line's own. */
	readonly #processCap: number;

	/** `size` workers, by default what `ROUNDTABLE_SHELL_FUZZ_JOBS` says, else up to six. */
	constructor(
		size = Number.parseInt(process.env.ROUNDTABLE_SHELL_FUZZ_JOBS ?? "", 10) ||
			Math.min(6, Math.max(2, availableParallelism() - 1)),
	) {
		this.size = size;
		// A run that is stopped (a signal, a closed pipe) must not leave a line's processes behind.
		process.once("exit", () => this.#killAll());
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
			process.once(signal, () => {
				this.#killAll();
				process.exit(1);
			});
		const running = Number(
			execFileSync("/bin/sh", ["-c", "ps -A | wc -l"], { encoding: "utf8" }),
		);
		this.#processCap = Math.min(7_900, (running || 3_000) + 500);
		mkdirSync(this.#stubs);
		for (const [name, body] of Object.entries(STUBS)) {
			const file = join(this.#stubs, name);
			writeFileSync(file, `#!/bin/sh\n${body}\n`);
			chmodSync(file, 0o755);
		}
		for (let i = 0; i < size; i++) {
			const cwd = join(this.#root, `cwd${i}`);
			mkdirSync(cwd);
			this.#idle.push({ cwd });
		}
	}

	async #acquire(): Promise<Worker> {
		const worker = this.#idle.pop();
		if (worker) return worker;
		return new Promise((resolve) => this.#waiting.push(resolve));
	}

	#release(worker: Worker): void {
		const next = this.#waiting.shift();
		if (next) next(worker);
		else this.#idle.push(worker);
	}

	/**
	 * Whether `bash` ran the stub `sudo` for the line, within `timeoutMs`. The line runs in a process
	 * group of its own that is killed as a whole, and with a cap on the user's processes (the count when the runner started, and 500 more), so a line
	 * that loops or forks cannot outlive its run.
	 */
	async runs(bash: string, line: string, timeoutMs = 5_000): Promise<boolean> {
		const worker = await this.#acquire();
		try {
			// A line starts in an empty directory: a file an earlier line wrote (`tee f; bash f`) is no part of this one.
			rmSync(worker.cwd, { recursive: true, force: true });
			mkdirSync(worker.cwd);
			// A marker of its own for every run: a job a line left behind may still write after the next line has started.
			const marker = join(this.#root, `marker${this.#runs++}`);
			// A NUL byte cannot be an argument, so such a line is the script on standard input.
			const viaInput = line.includes("\u0000");
			const child = spawn(
				"/bin/sh",
				[
					"-c",
					`ulimit -S -u ${this.#processCap} 2>/dev/null; exec "$0" "$@"`,
					bash,
					"--norc",
					"--noprofile",
					...(viaInput ? [] : ["-c", line]),
				],
				{
					cwd: worker.cwd,
					env: {
						PATH: this.#stubs,
						MARKER: marker,
						HOME: worker.cwd,
						REAL_BASH: bash,
					},
					stdio: [viaInput ? "pipe" : "ignore", "ignore", "ignore"],
					detached: true,
				},
			);
			if (viaInput) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(line);
			}
			const pid = child.pid;
			if (pid !== undefined) this.#groups.add(pid);
			const timer = setTimeout(() => {
				if (pid !== undefined) killGroup(pid);
			}, timeoutMs);
			await new Promise<void>((resolve) => {
				child.on("error", () => resolve());
				child.on("close", () => resolve());
			});
			clearTimeout(timer);
			// What the line left behind in the group (a background job, a coprocess) goes with it.
			if (pid !== undefined && (await killGroupAndWait(pid)))
				this.#groups.delete(pid);
			else if (pid !== undefined) this.leaked.push(line);
			return existsSync(marker);
		} finally {
			this.#release(worker);
		}
	}

	/** Lines whose processes were still alive after their group was killed, for a report. */
	readonly leaked: string[] = [];

	/** The scratch directory a line judged by the rule is given as its workspace. */
	get workspace(): string {
		return join(this.#root, "workspace");
	}

	#killAll(): void {
		for (const pid of this.#groups) killGroup(pid);
		this.#groups.clear();
	}

	close(): void {
		this.#killAll();
		rmSync(this.#root, { recursive: true, force: true });
	}
}
