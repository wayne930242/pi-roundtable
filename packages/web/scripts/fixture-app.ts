// A local host for trying the owner app in a browser: a real host over a scratch PostgreSQL
// database, two agents and a group, no Discord, and no authentication (`none`, on a loopback port).
//
//   ROUNDTABLE_TEST_DATABASE_URL  a PostgreSQL URL whose server may create a database; the fixture
//                                 makes `fixture_<time>` there and drops it when it stops
//   PORT                          the app (default 4180); PORT + 1 is the control port below
//
// The agents are scripts: write a keyword in a room and the agent acts it out.
//   approve  a held action with details          timeout  a turn's time-limit card
//   ask      a question with options             quiz     a questionnaire
//   late     a card the turn stops waiting on    stream   streamed text and tool chips, then a reply
// Anything else gets a reply in Markdown. The control port sends a message as the owner:
//   curl 'http://127.0.0.1:4181/say?room=app:agent.guide&text=approve'
// `GET /control/mode?room=...&yolo=1&long=1` sets a room's modes. The page is at http://127.0.0.1:PORT/console/.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";

const port = Number(process.env.PORT ?? 4180);
const base = process.env.ROUNDTABLE_TEST_DATABASE_URL;
if (!base) throw new Error("set ROUNDTABLE_TEST_DATABASE_URL");
const databaseName = `fixture_${Date.now()}`;
const admin = new SQL(base);
await admin.unsafe(`CREATE DATABASE ${databaseName}`);
const url = new URL(base);
url.pathname = `/${databaseName}`;
process.env.ROUNDTABLE_TEST_DATABASE_URL = url.toString();

// Loaded after the variable is set: the test host reads the database address when it is imported.
const { AGENTS, MODES, promptScope, SCHEDULES } = await import("pi-roundtable");
const { testHost } = await import("pi-roundtable/testing");
const { webConsole } = await import("../src/web-plugin.ts");
type TurnProgress = import("pi-roundtable").TurnProgress;
type TurnRequest = Parameters<
	import("pi-roundtable").AgentRuntime["runTurn"]
>[0];

const origin = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "fixture-app-"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SAMPLE = `Here is a quick look at what I can do for you today:

- **Plan the week.** I keep your calendar and the notes you share with me.
- **Run things for you.** Anything that changes a system asks first.
- **Answer questions** with sources.

\`\`\`bash
bun run deploy --env staging
\`\`\`

| Task | Status |
| --- | --- |
| Backups | done |
| Release notes | drafting |

Ask me for a *demo* with \`approve\`, \`ask\`, \`quiz\`, \`timeout\`, \`late\` or \`stream\`.`;

type Script = (
	request: TurnRequest,
	signal: AbortSignal,
) => Promise<{ ok: true; text: string }>;

let host: Awaited<ReturnType<typeof testHost>> | undefined;
const promptsOf = (request: TurnRequest) => {
	const prompts = host?.context.surfaces.prompts(
		request.channel,
		promptScope(request.speaker),
	);
	if (!prompts) throw new Error("the room has no prompts");
	return prompts;
};

const scripts: Record<string, Script> = {
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
				input: { command: "bun run deploy --env production", cwd: "/srv/app" },
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
			{ late: () => "Publish the post, I approve." },
		);
		return { ok: true, text: `The card ended ${result}.` };
	},
	stream: async (request) => {
		const progress = async (event: TurnProgress) => {
			await host?.context.surfaces.progress?.(request.channel, event);
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

const runtime = {
	runTurn: async (request: TurnRequest) => {
		const text = request.text.toLowerCase();
		const key = Object.keys(scripts).find((marker) => text.includes(marker));
		const script = key ? scripts[key] : undefined;
		if (script) return script(request, new AbortController().signal);
		await sleep(400);
		return { ok: true as const, text: SAMPLE };
	},
	steer: async () => false,
	stop: () => false,
	startFresh: async () => undefined,
	deleteConversation: async () => undefined,
	pendingConfirmation: () => undefined,
	heldActions: async () => undefined,
	recentTranscript: async () => [],
};

host = await testHost({
	discord: false,
	runtime: runtime as never,
	config: {
		dataDir,
		http: { port, hostname: "127.0.0.1" },
		agents: [
			{
				name: "guide",
				displayName: "Atlas",
				prompt: "You are the owner's main assistant.",
				avatarPrompt: "A calm navigator",
			},
			{
				name: "scout",
				displayName: "Scout",
				prompt: "You research and report.",
				avatarPrompt: "An eager scout",
			},
			{
				name: "archivist",
				displayName: "Archivist",
				prompt: "You keep the notes.",
				avatarPrompt: "A quiet archivist",
			},
		],
	} as never,
	plugins: [
		webConsole({
			auth: { mode: "none" },
			origin,
			dataDir,
			title: "Roundtable",
			cardGraceSeconds: 5,
			panes: ["rooms", "overview", "schedules", "conversations"],
		}),
	],
});

const services = host.context.services;
const { team } = services.get(AGENTS);
const deadline = Date.now() + 15_000;
while (team.coordinator() === undefined && Date.now() < deadline)
	await sleep(50);
try {
	// SAFETY: the agent team behind the service is the class that has createGroup; the service type leaves it out.
	await (
		team as unknown as {
			createGroup(input: Record<string, unknown>): Promise<string>;
		}
	).createGroup({
		name: "crew",
		displayName: "Crew",
		members: ["scout", "archivist"],
		host: "scout",
	});
} catch (error) {
	console.warn("no group:", error instanceof Error ? error.message : error);
}
const nextWeek = new Date(Date.now() + 86_400_000);
await services.get(SCHEDULES).create({
	channel: "app:agent.guide",
	target: "guide",
	title: "Morning briefing",
	prompt: "Summarize overnight alerts and today's calendar.",
	recurrence: {
		kind: "every",
		time: "07:30",
		everyDays: 1,
		startDate: new Date().toISOString().slice(0, 10),
	},
	nextRun: nextWeek,
	createdById: "100000000000000001",
	createdByName: "Ada",
	createdTier: "owner",
});
await services.get(SCHEDULES).create({
	channel: "app:agent.scout",
	target: "scout",
	title: "Weekly dependency check",
	prompt: "Check the lockfile for outdated or vulnerable packages and report.",
	recurrence: { kind: "weekly", time: "09:00", weekdays: ["mon"] },
	nextRun: new Date(Date.now() + 3 * 86_400_000),
	createdById: "100000000000000001",
	createdByName: "Ada",
	createdTier: "owner",
});

/** Sends a message to a room as the owner, over the app's own socket. */
async function say(room: string, text: string): Promise<void> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/console/api/socket`, {
		protocols: ["roundtable.app.v1"],
		headers: { origin },
	} as never);
	await new Promise<void>((resolve, reject) => {
		socket.onopen = () => resolve();
		socket.onerror = () => reject(new Error("the socket did not open"));
	});
	socket.send(
		JSON.stringify({ type: "send", id: crypto.randomUUID(), room, text }),
	);
	await sleep(300);
	socket.close();
}

async function setMode(
	room: string,
	change: Record<string, unknown>,
): Promise<void> {
	const response = await fetch(
		`${origin}/console/api/rooms/${encodeURIComponent(room)}/mode`,
		{
			method: "PUT",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify(change),
		},
	);
	if (!response.ok) throw new Error(`mode: ${response.status}`);
}

// History to look at: a short talk in the home room and the scout's.
await say("app:agent.guide", "Hello! What can you do for me?");
await sleep(1200);
await say("app:agent.scout", "Give me a short status.");
await sleep(1200);

const control = Bun.serve({
	port: port + 1,
	hostname: "127.0.0.1",
	async fetch(request) {
		const params = new URL(request.url).searchParams;
		const path = new URL(request.url).pathname;
		const room = params.get("room") ?? "app:agent.guide";
		if (path === "/say") {
			await say(room, params.get("text") ?? "hello");
			return new Response("sent");
		}
		if (path === "/control/mode") {
			await setMode(room, {
				...(params.has("yolo") ? { yolo: params.get("yolo") === "1" } : {}),
				...(params.has("long")
					? { longRunning: params.get("long") === "1" }
					: {}),
			});
			return new Response("set");
		}
		return new Response("say, control/mode", { status: 404 });
	},
});
void MODES;

console.log(
	JSON.stringify({
		app: `${origin}/console/`,
		control: `http://127.0.0.1:${port + 1}/`,
		database: databaseName,
		pid: process.pid,
	}),
);

let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	control.stop(true);
	await host?.stop();
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
	} catch (error) {
		console.warn("database not dropped:", error);
	}
	process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
