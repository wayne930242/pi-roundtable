import {
	type ChannelKey,
	definePlugin,
	defineTool,
	IDENTITY,
	PluginError,
	SKILLS,
	SYSTEM_PRINCIPAL,
	serviceKey,
	ToolRefusal,
} from "pi-roundtable";
import {
	AgentError,
	checkRepoName,
	skillListExtension,
	zonedStamp,
} from "pi-roundtable/kit";
import { Type } from "typebox";
import {
	CodingDesk,
	checkLimit,
	codingReport,
	MAX_CODING_TASK_CHARS,
} from "./coding-desk.ts";
import type { CodingOptions, RepoToolName } from "./coding-options.ts";
import {
	applyStoredLimit,
	CODING_SETTINGS_MIGRATION,
	databaseSettings,
	memorySettings,
	registerSettingsPage,
} from "./coding-settings.ts";
import type { CodingResult } from "./desk-types.ts";
import { checkCount, checkMaxWorkers } from "./limits.ts";
import { PiCodingWorker } from "./pi-coding-worker.ts";
import { RepoShelf, reportPost } from "./repo-shelf.ts";
import { taskTools } from "./task-tools.ts";
import { workerHolds } from "./worker-holds.ts";

export type {
	CodingOptions,
	CodingPresentation,
	CodingRun,
	CodingToolText,
	RepoToolName,
} from "./coding-options.ts";

export interface CodingService {
	readonly shelf: RepoShelf;
	readonly desk: CodingDesk;
}
export const CODING = serviceKey<CodingService>("coding.workbench");
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
	try {
		checkLimit("limits.reportChars", options.limits?.reportChars);
		checkLimit("limits.heldEntries", options.limits?.heldEntries);
		checkLimit("limits.heldChars", options.limits?.heldChars);
		checkLimit("diagnosticChars", options.diagnosticChars);
		if (options.maxWorkers !== undefined) checkMaxWorkers(options.maxWorkers);
		if (options.maxQueued !== undefined)
			checkCount("maxQueued", options.maxQueued, 0);
		const longRunning = options.autonomy?.longRunningMaxMs;
		if (
			longRunning !== undefined &&
			(!Number.isFinite(longRunning) ||
				longRunning <= 0 ||
				longRunning > 2_147_483_647)
		)
			throw new Error(
				"autonomy.longRunningMaxMs must be positive, finite and at most 2147483647.",
			);
	} catch (error) {
		throw new PluginError(
			error instanceof Error ? error.message : String(error),
		);
	}
	const ownerRepos = new Set(options.ownerRepos ?? []);
	for (const repo of ownerRepos) checkRepoName(repo);
	const ownerOwned = (repo: string): boolean => {
		checkRepoName(repo);
		return ownerRepos.has(repo) || options.isOwnerRepo?.(repo) === true;
	};
	return definePlugin({
		name: "coding",
		// Its workers run shells and edit files on the host's machine.
		hostAccess: true,
		provides: [CODING],
		...(options.settingsInDatabase
			? { migrations: [CODING_SETTINGS_MIGRATION] }
			: {}),
		async setup(context) {
			const shelf = new RepoShelf(options.shelfDir, options.clone, {
				diagnosticChars: options.diagnosticChars,
				...(options.githubToken !== undefined
					? { githubToken: options.githubToken }
					: {}),
			});
			for (const adoption of options.adoptClones ?? [])
				shelf.adopt(adoption.from, adoption.repo);
			const skills = context.services.find(SKILLS);
			const worker =
				options.worker ??
				new PiCodingWorker({
					packages: options.workerPackages,
					agentDir: options.agentDir,
					workspace: options.workerWorkspace,
					...(context.env.scratchDir
						? { scratchDir: context.env.scratchDir }
						: {}),
					...(options.workerEnv ? { workerEnv: options.workerEnv } : {}),
					...(context.env.shellEnv ? { shellEnv: context.env.shellEnv } : {}),
					prompt: options.workerPrompt,
					blockText: options.workerBlockText,
					diagnosticChars: options.diagnosticChars,
					holds: workerHolds(options.holds, () => context.sessions().holds),
				});
			const deliverReport =
				options.onResult ??
				(async (result: CodingResult) => {
					await context.surfaces.sendReply(result.job.channel, {
						chunks: [
							codingReport(
								result,
								zonedStamp(result.job.startedAt, context.env.timeZone),
							),
						],
					});
				});
			const desk = new CodingDesk({
				shelf,
				worker,
				timeoutMs: options.timeoutMs,
				...(options.maxWorkers !== undefined
					? { maxWorkers: options.maxWorkers }
					: {}),
				...(options.maxQueued !== undefined
					? { maxQueued: options.maxQueued }
					: {}),
				...(options.modes ? { modes: options.modes } : {}),
				...(options.autonomy ? { autonomy: options.autonomy } : {}),
				limits: options.limits,
				logger: context.logger,
				threads: options.threads,
				threadText: options.threadText,
				...(options.interimText ? { interimText: options.interimText } : {}),
				...(options.interimPrimaryChars
					? { interimPrimaryChars: options.interimPrimaryChars }
					: {}),
				prompts: (channel) => context.surfaces.prompts(channel),
				// A report of work that ends while the host drains still gets through the closed queue.
				deliver: (result) =>
					context.queue.finishing(() => deliverReport(result)),
			});
			const ship = <T>(repo: string, operation: () => Promise<T>) =>
				desk.ship(repo, operation);
			context.services.provide(CODING, { shelf, desk });
			const store = options.settingsInDatabase
				? databaseSettings(context.database())
				: memorySettings();
			registerSettingsPage(
				context,
				desk,
				store,
				options.presentation?.messages,
			);
			// Whether the principal holds the owner role; no identity service, or a failed lookup,
			// tells of no one holding it.
			const holdsOwnerRole = async (
				principalId: string,
				session: { homeChannel: ChannelKey },
			): Promise<boolean> => {
				try {
					const identity = context.services.find(IDENTITY);
					return (await identity?.tierOf(principalId)) === "owner";
				} catch (error) {
					context.logger.warn(
						{ channel: session.homeChannel, err: error },
						"could not tell whether the conversation's person holds the owner role; no extra skill list",
					);
					return false;
				}
			};
			const textOf = (tool: RepoToolName) => options.toolText?.[tool];
			const describe = (tool: RepoToolName, fallback: string) =>
				textOf(tool)?.description ?? fallback;
			const about = (tool: RepoToolName, name: string, fallback?: string) => {
				const description = textOf(tool)?.parameters?.[name] ?? fallback;
				return description ? { description } : {};
			};
			const repoSchema = (tool: RepoToolName) =>
				Type.String(about(tool, "repo", "A managed repository, owner/repo."));
			return {
				services: [
					{
						name: "coding-desk",
						// The stored limit is read at start: setup must not query the database.
						start: () => applyStoredLimit(store, desk, context.logger),
						// The host names the channels whose work a shutdown waits for or aborts: running and
						// queued tasks, and reports still going out.
						busy: () => desk.busyChannels(),
						// At the drain limit workers are told to stop, and their reports go out, before stop.
						abort: () => desk.interrupt(),
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
										// Whom the conversation serves decides, not its persona's kind: an owner's own
										// conversation. An agent's keeps the core's skill_list, and a shared one
										// serves whoever speaks.
										const { conversation } = session;
										if (session.agent || conversation.visibility !== "private")
											return null;
										const list = skillListExtension(skills);
										return async (pi) => {
											if (
												!(await holdsOwnerRole(
													conversation.principalId,
													session,
												))
											)
												return;
											await list({
												...pi,
												registerTool: (tool) =>
													pi.registerTool({
														...tool,
														execute: async (...args) => {
															// A cached session must not retain a removed owner role.
															const current = session.conversation;
															if (
																session.agent ||
																current.visibility !== "private" ||
																!(await holdsOwnerRole(
																	current.principalId,
																	session,
																))
															)
																throw new ToolRefusal(
																	"The extra skill list requires a private conversation whose principal currently holds the owner role.",
																);
															return tool.execute(...args);
														},
													}),
											});
										};
									},
								}),
							},
						]
					: [],
				tools: [
					defineTool({
						name: "repo_list",
						minTier: "owner",
						description: describe(
							"repo_list",
							"List managed clones, branch, upstream counts, dirty files, last commit, summary, CI hints and linked skills. Fetch first only when requested.",
						),
						parameters: Type.Object({
							fetch: Type.Optional(Type.Boolean(about("repo_list", "fetch"))),
						}),
						run: ({ fetch }) =>
							refusal(async () => {
								const repos = (await shelf.list(fetch === true)).map(
									(repo) => ({
										...repo,
										skills: skills?.linkedFrom(repo.repo) ?? [],
									}),
								);
								if (options.presentation?.list)
									return options.presentation.list(repos, {
										shelfDir: shelf.dir,
										fetched: fetch === true,
									});
								return repos.length
									? JSON.stringify(repos, null, 2)
									: `No managed repositories in ${shelf.dir}; use repo_add.`;
							}),
					}),
					defineTool({
						name: "repo_add",
						minTier: "owner",
						description: describe(
							"repo_add",
							"Clone owner/repo into the shelf using the host's Git login (GitHub CLI by default).",
						),
						parameters: Type.Object({ repo: repoSchema("repo_add") }),
						run: ({ repo }) =>
							refusal(
								async () => `Cloned ${repo} into ${await shelf.add(repo)}.`,
							),
					}),
					defineTool({
						name: "repo_change_report",
						minTier: "owner",
						description: describe(
							"repo_change_report",
							"Fetch and report commits and changed files for the default branch. Requires a clean, ahead-only clone. Review checks before requesting this report.",
						),
						parameters: Type.Object({
							repo: repoSchema("repo_change_report"),
						}),
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
						description: describe(
							"repo_push",
							"Push the SHA from the latest change report to its default branch, without force. Held for owner approval unless the trusted host policy explicitly marks the clone owner-owned.",
						),
						parameters: Type.Object({
							repo: repoSchema("repo_push"),
							sha: Type.String({
								pattern: "^[0-9a-f]{7,40}$",
								...about("repo_push", "sha"),
							}),
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
						description: describe(
							"repo_task",
							"Start a background Pi coding worker on a clone. Each worker has its own worktree and branch, so several may work on one repository; when it finishes, its commits are rebased onto the clone and fast-forwarded, and a conflict keeps the branch and is reported. When every worker slot is taken the task waits in a queue. The worker reads repository instructions, edits, checks and commits; shipping uses a separate report and approval. Report returns to this channel.",
						),
						parameters: Type.Object({
							repo: repoSchema("repo_task"),
							task: Type.String({
								minLength: 1,
								maxLength: MAX_CODING_TASK_CHARS,
								...about("repo_task", "task"),
							}),
							skills: Type.Optional(
								Type.Array(Type.String(), about("repo_task", "skills")),
							),
						}),
						run: ({ repo, task, skills: names }, turn) =>
							refusal(async () => {
								// A report's turn reads text no one vouches for; it hands no worker a task.
								if (turn.speaker?.principalId === SYSTEM_PRINCIPAL)
									throw new AgentError(
										"the host's own turns, such as a report's, start no coding tasks; ask the owner to start it",
									);
								if (desk.shipping(repo))
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
								if (desk.shipping(repo))
									throw new AgentError(
										"A report or push is in progress for this repository.",
									);
								const { speaker } = turn;
								const job = await desk.start({
									...run,
									...(turn.agent ? { agent: turn.agent.name } : {}),
									// Its modes follow the conversation this turn runs in, as the turn's own would.
									...(speaker
										? {
												starter: {
													channel: turn.channel,
													speaker: {
														id: speaker.id,
														principalId: speaker.principalId,
														...(speaker.name ? { name: speaker.name } : {}),
														tier: speaker.tier,
													},
												},
											}
										: {}),
									repo,
									task,
									skillFiles: set?.skills.map((skill) => skill.file) ?? [],
									skillNames: set?.skills.map((skill) => skill.name) ?? [],
								});
								const skipped = set?.missing.map((item) => item.name) ?? [];
								const skippedText = skipped.length
									? ` Unavailable implicit skills skipped: ${skipped.join(", ")}.`
									: "";
								if (job.queuePosition !== undefined)
									return (
										options.presentation?.taskQueued?.(
											job,
											job.queuePosition,
											skipped,
										) ??
										`Queued coding task #${job.id} in ${repo} at position ${job.queuePosition}: every worker slot is taken, and it starts on ${job.model} when one frees. Its report returns to ${job.channel}; repo_task_cancel cancels it.${skippedText}`
									);
								return (
									options.presentation?.taskStarted?.(job, skipped) ??
									`Started coding task #${job.id} in ${repo} on ${job.model}; its report returns to ${job.channel}, and repo_task_cancel cancels it.${skippedText}`
								);
							}),
					}),
					...taskTools(desk, refusal, describe, about, repoSchema),
				],
			};
		},
	});
}
