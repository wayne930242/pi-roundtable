import { promptScope, THREADS } from "pi-roundtable";
import type { TestHost } from "pi-roundtable/testing";
import { BLOCKS_REPLY } from "./fixture-samples.ts";

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export type Script = (
	request: TurnRequest,
	signal: AbortSignal,
) => Promise<{ ok: true; text: string }>;

type TurnProgress = import("pi-roundtable").TurnProgress;
type TurnRequest = Parameters<
	import("pi-roundtable").AgentRuntime["runTurn"]
>[0];

/** What the scripts reach of the running fixture: the host and its team, which exist once the scripts are in use. */
export interface ScriptEnv {
	host(): TestHost | undefined;
	team(): unknown;
}

/** The agents' scripts, by the keyword a message starts with. */
export function fixtureScripts(env: ScriptEnv): Record<string, Script> {
	const promptsOf = (request: TurnRequest) => {
		const prompts = env
			.host()
			?.context.surfaces.prompts(request.channel, promptScope(request.speaker));
		if (!prompts) throw new Error("the room has no prompts");
		return prompts;
	};

	return {
		blocks: async () => ({ ok: true, text: BLOCKS_REPLY }),
		approve: async (request, signal) => {
			const result = await promptsOf(request).confirm(
				"Run the deploy?",
				"I want to deploy **v1.4.2** to production.\n\n- 3 services restart\n- no migrations",
				signal,
				"owner",
				undefined,
				{
					action: "deploy to production",
					tool: "bash",
					input: {
						command: "bun run deploy --env production",
						cwd: "/srv/app",
					},
					files: [{ path: "/srv/app/deploy.lock", bytes: 12 }],
					copy: { label: "command", text: "bun run deploy --env production" },
				},
			);
			return {
				ok: true,
				text:
					result === "approved"
						? "Deployed **v1.4.2**. All checks are green."
						: "Okay, I did not deploy.",
			};
		},
		timeout: async (request, signal) => {
			const result = await promptsOf(request).confirm(
				"Time limit reached",
				"This turn has run for **10 minutes**. Let it go on?",
				signal,
				"owner",
				undefined,
				undefined,
				{
					purpose: "turn-timeout",
					wording: {
						approve: "Continue",
						decline: "Stop",
						footer: "Stopping ends the turn where it is.",
						approved: "Continuing",
						declined: "Stopped",
					},
				},
			);
			return {
				ok: true,
				text: result === "approved" ? "Carrying on." : "Stopped there.",
			};
		},
		ask: async (request, signal) => {
			const answer = await promptsOf(request).ask(
				"Which region?",
				{
					question: "Which region should I deploy to?",
					options: [
						{ label: "eu-west", description: "Frankfurt, closest to the team" },
						{
							label: "us-east",
							description: "Virginia",
							preview: "latency 38 ms\ncost $$\nfailover: us-west",
						},
						{ label: "ap-south", description: "Mumbai" },
					],
					multi: false,
					allowOther: true,
				},
				signal,
			);
			return { ok: true, text: `You said: ${JSON.stringify(answer)}.` };
		},
		quiz: async (request, signal) => {
			const prompts = promptsOf(request);
			const answer = await prompts.questionnaire?.(
				"A few questions",
				{
					questions: [
						{
							question: "Which environments?",
							header: "Targets",
							options: [
								{ label: "staging" },
								{ label: "production" },
								{ label: "canary" },
							],
							multi: true,
							allowOther: false,
						},
						{
							question: "Anything I should know first?",
							options: [],
							multi: false,
							allowOther: false,
						},
					],
				},
				signal,
			);
			return { ok: true, text: `Noted: ${JSON.stringify(answer)}.` };
		},
		late: async (request, signal) => {
			const result = await promptsOf(request).confirm(
				"Publish the post?",
				"The draft is ready. Publish it to the blog?",
				signal,
				"owner",
				{ late: () => "Publish the post, go ahead." },
			);
			return { ok: true, text: `The card ended ${result}.` };
		},
		dispatch: async (request) => {
			const thread = await env
				.host()
				?.context.services.get(THREADS)
				.open(
					request.channel,
					"Coding #12 · tidy imports",
					"📋 Task: tidy the imports in `src/`",
				);
			if (!thread) return { ok: true, text: "No thread could open here." };
			// The job goes on in its thread after the turn has answered.
			void (async () => {
				await sleep(800);
				await thread.post(
					"Reading `src/` …\n\nFound **14** files with unused imports.",
				);
				const prompts = env
					.host()
					?.context.surfaces.prompts(
						thread.channel,
						promptScope(request.speaker),
					);
				const result = await prompts?.confirm(
					"Commit the changes?",
					"The worker wants to commit **31 removed imports** on `tidy-imports`.",
					undefined,
					"owner",
					undefined,
					{
						action: "git commit",
						tool: "bash",
						input: { command: "git commit -am 'chore: remove unused imports'" },
					},
				);
				await thread.close(
					result === "approved"
						? "✅ Done\n\nRemoved 31 unused imports and committed them on `tidy-imports`."
						: "❌ Stopped; nothing was committed.",
				);
			})();
			return {
				ok: true,
				text: `Started ${thread.mention}. I will report when it is done.`,
			};
		},
		exchange: async (request) => {
			if (request.agent?.name === "guide")
				(
					env.team() as {
						message(
							caller: NonNullable<TurnRequest["agent"]>,
							to: string,
							text: string,
						): string;
					}
				).message(request.agent, "scout", "How large is the repository?");
			return {
				ok: true,
				text: "Asked the scout; the exchange is in a thread.",
			};
		},
		helpers: async (request) => {
			const team = env.team() as {
				helperCreate(
					caller: NonNullable<TurnRequest["agent"]>,
					input: { display_name?: string; displayName?: string } & Record<
						string,
						unknown
					>,
				): Promise<string>;
			};
			const agent = request.agent;
			if (!agent) return { ok: true, text: "I am not an agent." };
			const made: string[] = [];
			for (const [displayName, task] of [
				["Reconnaissance, southern harbour", "survey the harbour slowly"],
				["Permit check", "approve the permit"],
				["Tide table", "read the tide table"],
				["Chart notes", "read the chart notes"],
			] as const)
				made.push(
					await team.helperCreate(agent, {
						displayName,
						prompt: `You do one small task: ${task}.`,
						task,
					}),
				);
			return { ok: true, text: made.join("\n") };
		},
		endhelpers: async (request) => {
			const team = env.team() as {
				helperEnd(
					caller: NonNullable<TurnRequest["agent"]>,
					names: "finished",
				): Promise<string>;
			};
			if (!request.agent) return { ok: true, text: "I am not an agent." };
			return {
				ok: true,
				text: await team.helperEnd(request.agent, "finished"),
			};
		},
		stream: async (request) => {
			const progress = async (event: TurnProgress) => {
				await env.host()?.context.surfaces.progress?.(request.channel, event);
			};
			const words =
				"Reading the repository first, then I will compare the lockfile with the last release and list what changed. ".split(
					" ",
				);
			await progress({
				type: "tool_start",
				id: "t1",
				tool: "read",
				preview: "package.json",
			});
			for (const word of words.slice(0, 8)) {
				await progress({ type: "text", delta: `${word} ` });
				await sleep(260);
			}
			await progress({ type: "tool_end", id: "t1", tool: "read", ok: true });
			await progress({
				type: "tool_start",
				id: "t2",
				tool: "bash",
				preview: "git log --oneline -5",
			});
			for (const word of words.slice(8)) {
				await progress({ type: "text", delta: `${word} ` });
				await sleep(260);
			}
			await sleep(2200);
			await progress({ type: "tool_end", id: "t2", tool: "bash", ok: true });
			await progress({
				type: "tool_start",
				id: "t3",
				tool: "grep",
				preview: "TODO src/",
			});
			await sleep(6000);
			await progress({ type: "tool_end", id: "t3", tool: "grep", ok: false });
			return {
				ok: true,
				text: "Done. Three packages changed since the last release; details below.\n\n1. `web` — owner app\n2. `core` — modes\n3. `docs`",
			};
		},
	};
}
