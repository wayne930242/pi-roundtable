import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	AGENT_SERVER_PLUGIN,
	AGENT_TEAM_SERVICE,
	AGENTS,
	type AgentServer,
	definePlugin,
} from "pi-roundtable";

/**
 * What a deploy writes as `release.json`: the commit the running release was built from, and
 * the subjects of the commits it added since the release that ran before, newest first.
 */
export interface ReleaseInfo {
	sha: string;
	commits: string[];
}

export interface ReleaseNoticeOptions {
	/** The file a deploy writes with the release's description; default `release.json` in the working directory. A start with no such file announces nothing. */
	releaseFile?: string;
	/** Where the plugin keeps what it has announced and what a shutdown cut short; default `./data`, the data directory a new project's config names. */
	dataDir?: string;
	/** Posts the announcement; default the coordinator's channel, through the agent server. It throws to say the post failed, and the announcement is then tried again at the next start. */
	announce?: (text: string) => Promise<void>;
}

const ANNOUNCED = "announced-release";
const ABORTED = "aborted-on-shutdown.json";

async function readText(path: string): Promise<string | undefined> {
	return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
}

/** A list of strings from JSON, such as the aborted channels; anything else fails with the file's path. */
function parseStrings(text: string, path: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not a JSON list`, { cause: error });
	}
	if (!isStrings(parsed)) throw new Error(`${path} is not a list of strings`);
	return parsed;
}

const isStrings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/** `release.json`'s content; anything but a non-empty `sha` and a list of commit subjects fails with the file's path. */
function parseRelease(text: string, path: string): ReleaseInfo {
	const invalid = (reason: string, cause?: unknown) =>
		new Error(`${path} is not a valid release description: ${reason}`, {
			cause,
		});
	let parsed: Partial<ReleaseInfo> | null;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw invalid("not JSON", error);
	}
	if (typeof parsed?.sha !== "string" || parsed.sha === "")
		throw invalid("needs a non-empty sha");
	if (!isStrings(parsed.commits))
		throw invalid("commits is not a list of strings");
	return { sha: parsed.sha, commits: parsed.commits };
}

/** `discord:<id>` and `agentgroup:<id>.<agent>` as a Discord channel mention; any other key as it is. */
function channelMention(key: string): string {
	const id =
		/^discord:(\d+)$/.exec(key)?.[1] ?? /^agentgroup:(\d+)\./.exec(key)?.[1];
	return id ? `<#${id}>` : key;
}

/** The announcement: the new version and its commits, or a plain restart, then any channels the previous shutdown cut short. */
export function noticeText(
	release: ReleaseInfo,
	updated: boolean,
	aborted: string[],
): string {
	const lines = updated
		? [
				`🔄 Updated to \`${release.sha}\``,
				...release.commits.map((subject) => `- ${subject}`),
			]
		: [`🔄 Restarted (\`${release.sha}\`)`];
	if (aborted.length > 0)
		lines.push(
			`-# Cut short by the restart, still running when the shutdown wait ended: ${[...new Set(aborted.map(channelMention))].join(", ")}`,
		);
	return lines.join("\n");
}

/** Posts through the agent server's team, read when the first notice is due, since the server is linked after setup. */
function throughTeam(agents: () => AgentServer) {
	return (text: string) => agents().team.announce(text);
}

/**
 * The plugin, with where the release is described, where its state is kept, and where the
 * announcement goes replaceable. After the agent server is up it announces once when the
 * running release differs from the one last announced, or when the previous shutdown cut work
 * short; at shutdown it records the channels whose work the drain gave up on.
 */
export function createReleaseNotice(options: ReleaseNoticeOptions = {}) {
	const releaseFile = options.releaseFile ?? "release.json";
	const dataDir = options.dataDir ?? "./data";
	const announcedPath = join(dataDir, ANNOUNCED);
	const abortedPath = join(dataDir, ABORTED);

	// The shutdown's record and an announcement's acknowledgement both rewrite the state files, and
	// the host does not wait for a start's handlers before it shuts down, so they take turns.
	let turn: Promise<unknown> = Promise.resolve();
	const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
		const run = turn.then(work);
		turn = run.catch(() => undefined);
		return run;
	};

	async function readAborted(): Promise<string[]> {
		const text = await readText(abortedPath);
		return text === undefined ? [] : parseStrings(text, abortedPath);
	}

	/** The announcement due now and what acknowledges it, or undefined when nothing is due. */
	function pending() {
		return exclusive(async () => {
			const text = await readText(releaseFile);
			if (text === undefined) return undefined;
			const release = parseRelease(text, releaseFile);
			const announced = (await readText(announcedPath))?.trim();
			const aborted = await readAborted();
			const updated = announced !== release.sha;
			if (!updated && aborted.length === 0) return undefined;
			return {
				text: noticeText(release, updated, aborted),
				// A shutdown may add channels while the post is in flight: only the ones it named are cleared.
				done: () =>
					exclusive(async () => {
						await mkdir(dataDir, { recursive: true });
						await writeFile(announcedPath, release.sha);
						const rest = (await readAborted()).slice(aborted.length);
						if (rest.length > 0)
							await writeFile(abortedPath, JSON.stringify(rest));
						else await rm(abortedPath, { force: true });
					}),
			};
		});
	}

	return definePlugin({
		name: "release-notice",
		setup: ({ logger, services }) => {
			const announce = options.announce ?? throughTeam(services.lazy(AGENTS));
			return {
				events: {
					// The agent server's team service is ready once its channels are up, so the notice posts after it.
					serviceStarted: async ({ plugin, service, outcome }) => {
						if (
							plugin !== AGENT_SERVER_PLUGIN ||
							service !== AGENT_TEAM_SERVICE ||
							outcome !== "ready"
						)
							return;
						const notice = await pending();
						if (!notice) return;
						await announce(notice.text);
						await notice.done();
						logger.info("release announced");
					},
					// The drain ended with work still running: the next start says it was cut short.
					shutdown: (left) =>
						left.length === 0
							? undefined
							: exclusive(async () => {
									const earlier = await readAborted();
									await mkdir(dataDir, { recursive: true });
									await writeFile(
										abortedPath,
										JSON.stringify([...earlier, ...left]),
									);
								}),
				},
			};
		},
	});
}

export const releaseNotice = createReleaseNotice();
