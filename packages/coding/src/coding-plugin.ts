import {
	type ChannelKey,
	definePlugin,
	defineTool,
	type HoldCheck,
	PluginError,
	SKILLS,
	serviceKey,
	type ThinkingLevel,
	ToolRefusal,
	type ToolTurn,
} from "pi-roundtable";
import {
	AgentError,
	checkRepoName,
	type DispatchThreads,
	skillListExtension,
	zonedStamp,
} from "pi-roundtable/kit";
import { Type } from "typebox";
import {
	CodingDesk,
	type CodingJob,
	type CodingResult,
	type CodingThreadText,
	type CodingWorker,
	codingReport,
	MAX_CODING_TASK_CHARS,
} from "./coding-desk.ts";
import { PiCodingWorker } from "./pi-coding-worker.ts";
import {
	type ChangeReport,
	type CloneCommand,
	RepoShelf,
	reportPost,
} from "./repo-shelf.ts";

export interface CodingService {
	readonly shelf: RepoShelf;
	readonly desk: CodingDesk;
}
export const CODING = serviceKey<CodingService>("coding.workbench");
export interface CodingRun {
	model: string;
	thinking: ThinkingLevel;
	channel: ChannelKey;
	origin?: ChannelKey;
}
export interface CodingPresentation {
	/** Separate the owner's posted record from the model's shipping instructions. */
	changeReport?(
		report: ChangeReport,
		direct: boolean,
	): { post: string; result: string };
	taskStarted?(job: CodingJob, skippedSkills: string[]): string;
}
export interface CodingOptions {
	shelfDir: string;
	/** Provider/model-id, resolved with the worker's Pi host login. */
	model: string;
	thinking?: ThinkingLevel;
	/** Exact owner/repo names allowed to use repo_push without a hold. Default: none. */
	ownerRepos?: string[];
	/** Trusted host policy for additional owner-owned repositories, including future clones.
	 * Only literal true grants an exemption. This never bypasses linked host hold rules. */
	isOwnerRepo?: (repo: string) => boolean;
	/** Trusted wording for the approval card of a held `repo_push`. Default: names the repository, sha, target and branch. */
	pushHoldText?: (repo: string, sha: string) => string;
	/** Moves legacy standalone clones before the host reads shelf-linked skills. */
	adoptClones?: { from: string; repo: string }[];
	/** Resolve the calling agent/owner's run identity, independently of report posting. */
	resolveRun?: (turn: ToolTurn) => CodingRun | Promise<CodingRun>;
	/** Post change reports in the caller's identity/channel rather than the default surface. */
	postChangeReport?: (turn: ToolTurn, text: string) => Promise<void>;
	presentation?: CodingPresentation;
	threads?: Pick<DispatchThreads, "open">;
	threadText?: CodingThreadText;
	workerWorkspace?: string;
	workerPrompt?: (dir: string) => string;
	/** Opt in to skipping unavailable implicit skills; explicit requests always fail closed. */
	skipUnavailableCarriedSkills?: boolean;
	/** Absolute installed extension package paths. Default: none. */
	workerPackages?: string[];
	agentDir?: string;
	timeoutMs?: number;
	/** Optional additional worker rules; linked host rules also apply. */
	holds?: HoldCheck;
	/** A different Git host or an offline clone implementation. */
	clone?: CloneCommand;
	/** Replace the process runner for deterministic tests. */
	worker?: CodingWorker;
	/** Override report delivery, for example to schedule a background conversation turn. */
	onResult?: (result: CodingResult) => Promise<void>;
}
async function refusal<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof AgentError) throw new ToolRefusal(error.message);
		throw error;
	}
}

/** Repository tools for agent and owner sessions, with coding work outside the host process. */
export function coding(options: CodingOptions) {
	if (!options.shelfDir.trim()) throw new PluginError("shelfDir is required.");
	if (!/^[^/\s]+\/\S+$/.test(options.model))
		throw new PluginError("model must be provider/model-id.");
	const ownerRepos = new Set(options.ownerRepos ?? []);
	for (const repo of ownerRepos) checkRepoName(repo);
	const ownerOwned = (repo: string): boolean => {
		checkRepoName(repo);
		return ownerRepos.has(repo) || options.isOwnerRepo?.(repo) === true;
	};
	return definePlugin({
		name: "coding",
		provides: [CODING],
		setup(context) {
			const shelf = new RepoShelf(options.shelfDir, options.clone);
			for (const adoption of options.adoptClones ?? [])
				shelf.adopt(adoption.from, adoption.repo);
			const skills = context.services.find(SKILLS);
			const worker =
				options.worker ??
				new PiCodingWorker({
					packages: options.workerPackages,
					agentDir: options.agentDir,
					workspace: options.workerWorkspace,
					prompt: options.workerPrompt,
					holds: (tool, input, scope) =>
						options.holds?.(tool, input, scope) ??
						context.sessions().holds(tool, input, scope),
				});
			const desk = new CodingDesk({
				shelf,
				worker,
				timeoutMs: options.timeoutMs,
				logger: context.logger,
				threads: options.threads,
				threadText: options.threadText,
				prompts: (channel) => context.surfaces.prompts(channel),
				deliver:
					options.onResult ??
					(async (result) => {
						await context.surfaces.sendReply(result.job.channel, {
							chunks: [
								codingReport(
									result,
									zonedStamp(result.job.startedAt, context.env.timeZone),
								),
							],
						});
					}),
			});
			const shipping = new Set<string>();
			async function ship<T>(
				repo: string,
				operation: () => Promise<T>,
			): Promise<T> {
				desk.checkIdle(repo);
				if (shipping.has(repo))
					throw new AgentError(
						"A report or push is already in progress for this repository.",
					);
				shipping.add(repo);
				try {
					return await operation();
				} finally {
					shipping.delete(repo);
				}
			}
			context.services.provide(CODING, { shelf, desk });
			const repoSchema = Type.String({
				description: "A managed repository, owner/repo.",
			});
			return {
				services: [
					{
						name: "coding-desk",
						busy: () => desk.busy(),
						stop: () => desk.stop(),
					},
				],
				sessionTools: skills
					? [
							{
								name: "coding-owner-skill-list",
								phase: "tools" as const,
								snapshot: () => ({
									revision: 0,
									factory: (session) => {
										if (session.kind !== "owner") return null;
										return skillListExtension(skills);
									},
								}),
							},
						]
					: [],
				tools: [
					defineTool({
						name: "repo_list",
						minTier: "owner",
						description:
							"List managed clones, branch, upstream counts, dirty files, last commit, summary, CI hints and linked skills. Fetch first only when requested.",
						parameters: Type.Object({ fetch: Type.Optional(Type.Boolean()) }),
						run: ({ fetch }) =>
							refusal(async () => {
								const repos = await shelf.list(fetch === true);
								return repos.length
									? JSON.stringify(
											repos.map((repo) => ({
												...repo,
												skills: skills?.linkedFrom(repo.repo) ?? [],
											})),
											null,
											2,
										)
									: `No managed repositories in ${shelf.dir}; use repo_add.`;
							}),
					}),
					defineTool({
						name: "repo_add",
						minTier: "owner",
						description:
							"Clone owner/repo into the shelf using the host's Git login (GitHub CLI by default).",
						parameters: Type.Object({ repo: repoSchema }),
						run: ({ repo }) =>
							refusal(
								async () => `Cloned ${repo} into ${await shelf.add(repo)}.`,
							),
					}),
					defineTool({
						name: "repo_change_report",
						minTier: "owner",
						description:
							"Fetch and report commits and changed files for the default branch. Requires a clean, ahead-only clone. Review checks before requesting this report.",
						parameters: Type.Object({ repo: repoSchema }),
						run: ({ repo }, turn) =>
							refusal(() =>
								ship(repo, async () => {
									const report = await shelf.report(repo);
									const direct = ownerOwned(repo);
									const text = options.presentation?.changeReport?.(
										report,
										direct,
									) ?? {
										post: reportPost(report, direct),
										result: reportPost(report, direct),
									};
									if (options.postChangeReport)
										await options.postChangeReport(turn, text.post);
									else
										await context.surfaces.sendReply(turn.channel, {
											chunks: [text.post],
										});
									return text.result;
								}),
							),
					}),
					defineTool({
						name: "repo_push",
						minTier: "owner",
						description:
							"Push the exact full SHA from the latest change report to its default branch, without force. Held for owner approval unless the trusted host policy explicitly marks the clone owner-owned.",
						parameters: Type.Object({
							repo: repoSchema,
							sha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
						}),
						hold: ({ repo, sha }) =>
							ownerOwned(repo)
								? undefined
								: (options.pushHoldText?.(repo, sha) ??
									shelf.pushDescription(repo, sha)),
						run: ({ repo, sha }) =>
							refusal(() =>
								ship(
									repo,
									async () =>
										`Pushed ${sha} to ${repo} ${await shelf.push(repo, sha)}.`,
								),
							),
					}),
					defineTool({
						name: "repo_task",
						minTier: "owner",
						description:
							"Start one background Pi coding worker in a clone. The worker reads repository instructions, edits, checks and commits; shipping uses a separate report and approval. Report returns to this channel.",
						parameters: Type.Object({
							repo: repoSchema,
							task: Type.String({
								minLength: 1,
								maxLength: MAX_CODING_TASK_CHARS,
							}),
							skills: Type.Optional(Type.Array(Type.String())),
						}),
						run: ({ repo, task, skills: names }, turn) =>
							refusal(async () => {
								if (shipping.has(repo))
									throw new AgentError(
										"A report or push is in progress for this repository.",
									);
								if (names?.length && !skills)
									throw new AgentError("The host's skills addon is off.");
								const carried =
									names ??
									(turn.agent ? skills?.carriedNames(turn.agent.name) : []) ??
									[];
								if (names || !options.skipUnavailableCarriedSkills)
									skills?.checkRegistered(carried);
								const set = skills?.resolve(carried);
								if (
									set?.missing.length &&
									(names || !options.skipUnavailableCarriedSkills)
								)
									throw new AgentError(
										`These skills cannot load: ${set.missing.map((item) => `${item.name} (${item.reason})`).join(", ")}`,
									);
								const run = (await options.resolveRun?.(turn)) ?? {
									channel: turn.channel,
									model: options.model,
									thinking: options.thinking ?? "medium",
								};
								if (shipping.has(repo))
									throw new AgentError(
										"A report or push is in progress for this repository.",
									);
								const job = await desk.start({
									...run,
									repo,
									task,
									skillFiles: set?.skills.map((skill) => skill.file) ?? [],
									skillNames: set?.skills.map((skill) => skill.name) ?? [],
								});
								return (
									options.presentation?.taskStarted?.(
										job,
										set?.missing.map((item) => item.name) ?? [],
									) ??
									`Started coding task #${job.id} in ${repo} on ${job.model}; its report returns to ${job.channel}.${set?.missing.length ? ` Unavailable implicit skills skipped: ${set.missing.map((item) => item.name).join(", ")}.` : ""}`
								);
							}),
					}),
				],
			};
		},
	});
}
