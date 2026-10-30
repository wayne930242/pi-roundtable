// A local host for trying the owner app in a browser: a real host over a scratch PostgreSQL
// database, two agents and a group, no Discord, and no authentication (`none`, on a loopback port).
//
//   ROUNDTABLE_TEST_DATABASE_URL  a PostgreSQL URL whose server may create a database; the fixture
//                                 makes `fixture_<time>` there and drops it when it stops
//   PORT                          the app (default 4180); PORT + 1 is the control port below
//   LOOK                          the host's look, `modern` (default) or `camelot`
//   LOCALE                       the presentation locale, for example `zh-TW` (default: none, English)
//   FIXTURE_SKILLS               `registry` lists the host's real skill registry (the built-in skills, plus
//                                 two written ones made at start) so the skill editor works; default: the fake catalog below
//
// The page is built into dist/ at start when dist/ has none.
//   FIXTURE_HOST                  `1` registers a host room kind ("inbox": an empty room and one with a message,
//                                 both open to notes and turns) and a host page, for trying the host rooms
//   FIXTURE_AGENTS                how many agents sit at the round table, 3 to 12 (default 3)
//
// The agents are scripts: start a message with a keyword and the agent acts it out.
//   approve  a held action with details          timeout  a turn's time-limit card
//   ask      a question with options             quiz     a questionnaire
//   late     a card the turn stops waiting on    stream   streamed text and tool chips, then a reply
//   dispatch a coding job in a thread, with a card there     exchange  the agent asks the scout in a thread
// Anything else gets a reply in Markdown. The control port sends a message as the owner:
//   curl 'http://127.0.0.1:4181/say?room=app:agent.guide&text=approve'
// `GET /control/mode?room=...&yolo=1&long=1` sets a room's modes. `GET /control/write?path=src/main.ts&text=...`
// writes a file in the agents' workspace the way a partner would, to try the files pane's conflict check. The page is at http://127.0.0.1:PORT/console/.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { SQL } from "bun";
import { buildPage } from "./build-page.ts";

// The host serves the built page and stops at start-up without one: build it here when it is missing.
const pageDir = fileURLToPath(new URL("../dist/", import.meta.url));
if (!existsSync(join(pageDir, "index.html"))) {
	console.log("the console page is not built: building it into dist/ first");
	await buildPage(pageDir);
}

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
const { AGENTS, MODES, promptScope, SCHEDULES, SKILLS, THREADS } = await import(
	"pi-roundtable"
);
const { testHost } = await import("pi-roundtable/testing");
const { webConsole } = await import("../src/web-plugin.ts");
const { WEB_APP } = await import("../src/web-app.ts");
const { definePlugin } = await import("pi-roundtable");
type SkillRegistry = import("pi-roundtable").SkillRegistry;
type TurnProgress = import("pi-roundtable").TurnProgress;
type TurnRequest = Parameters<
	import("pi-roundtable").AgentRuntime["runTurn"]
>[0];

// Skills for the Skills page: one with long values, a long line, and a long code line, so a
// document dialog can be checked for wrapping and for scrolling inside the code block.
const SKILL_CATALOG = [
	{
		name: "code-review",
		source: { kind: "builtin" as const },
		description: "Review a change set for correctness, security and style.",
		groups: [],
		carriers: [],
	},
	{
		name: "deploy-notes",
		source: { kind: "written" as const },
		description: "Write release notes from merged changes.",
		groups: ["release"],
		carriers: ["guide"],
	},
];
const SKILL_DOCUMENTS: Record<
	string,
	{ frontmatter: Record<string, unknown>; body: string }
> = {
	"code-review": {
		frontmatter: {
			name: "code-review",
			description:
				"Use when reviewing a diff, a pull request or a commit range: read the change, run its tests, and report findings by severity with the file and line each one points to, rather than a general impression of the whole change.",
			license: "MIT",
			metadata: { version: "1.4.0", tags: ["review", "quality", "security"] },
		},
		body: `# Code review

Read the change before reading the code around it. A review answers one question: **is this change safe to merge?**

## Steps

1. List the files the change touches and group them by purpose.
2. Run the tests the change claims to cover, and the ones it forgot.
3. Read each hunk. For every finding note the file, the line, and why it matters.

## Severity

- **P0** breaks the build or loses data.
- **P1** a defect a user can reach.
- **P2** style, naming, a missing test.

> A finding without a line number is an opinion, not a finding.

\`\`\`ts
// A long line, to see the block scroll sideways rather than the dialog: the review reports every finding it makes with its file, line and severity.
export function report(findings: Finding[]): string { return findings.map((f) => \`\${f.severity} \${f.file}:\${f.line} \${f.text}\`).join("\\n"); }
\`\`\`

| Severity | Blocks merge |
| --- | --- |
| P0 | yes |
| P1 | yes |
| P2 | no |

Finish with a one-line verdict.`,
	},
	"deploy-notes": {
		frontmatter: {
			name: "deploy-notes",
			description:
				"Use when writing release notes from the changes merged since the last release.",
		},
		body: "Group the merged changes by area, then write one line for each.\n\n- Fixes first\n- Then features",
	},
};

const realSkills = process.env.FIXTURE_SKILLS === "registry";

/** The Skills pane's feature port over the host's own registry, so what the pane lists is what the editor opens and saves. */
const registrySkills = (registry: SkillRegistry) => ({
	catalog: () => registry.catalog().map(({ file: _file, ...entry }) => entry),
	read: async (name: string) => {
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
			(await registry.document(name)).text,
		);
		return { frontmatter, body };
	},
});

const origin = `http://127.0.0.1:${port}`;

/** A host room kind and a page, as a plugin that sits on the web app would register them. */
const hostFixture = definePlugin({
	name: "fixture-host",
	requires: [WEB_APP],
	setup: (context) => {
		const web = context.services.get(WEB_APP);
		const rooms = [
			{ id: "inbox-empty", title: "Empty thread" },
			{ id: "inbox-busy", title: "Support thread" },
		];
		web.registerRoomKind({
			kind: "inbox",
			label: "Inbox",
			icon: "users",
			list: async () => ({
				rooms: rooms.map((room) => ({
					...room,
					subtitle: "Support",
					picture: { initials: "IN", color: "#336699" },
				})),
			}),
			access: async (_viewer, id) =>
				rooms.some((room) => room.id === id)
					? { read: true, send: ["note", "turn"], act: true }
					: undefined,
			header: async (_viewer, id) => ({
				title: rooms.find((room) => room.id === id)?.title ?? id,
				fields: [{ label: "Status", value: "Open" }],
				actions: [],
			}),
			send: async () => "accepted",
		});
		web.registerPage({
			id: "mailboxes",
			label: "Mailboxes",
			icon: "megaphone",
			place: "main",
			visible: () => true,
			view: async () => ({
				title: "Mailboxes",
				sections: [{ kind: "markdown", text: "Two mailboxes." }],
			}),
		});
		return {};
	},
});
const seats = Math.min(
	12,
	Math.max(3, Number(process.env.FIXTURE_AGENTS ?? 3)),
);
// The first three are the scripted agents; the rest only sit, so the table can be seen full.
const EXTRA = [
	["mason", "Mason", "A patient stonemason"],
	["cook", "Cook", "A cheerful cook"],
	["nurse", "Nurse", "A calm nurse"],
	["pilot", "Pilot", "A steady pilot"],
	["smith", "Smith", "A strong smith"],
	["baker", "Baker", "A warm baker"],
	["clerk", "Clerk", "A careful clerk"],
	["diver", "Diver", "A brave diver"],
	["actor", "Actor", "A dramatic actor"],
].slice(0, seats - 3);
const dataDir = mkdtempSync(join(tmpdir(), "fixture-app-"));
const workDir = join(dataDir, "work");
// What the agents left in their workspace, for the files pane: code in several languages, a file with
// Windows line endings, a binary one, a large one, a repository's `.git`, and a link out of the workspace.
function seedWorkspace(): void {
	const put = (path: string, text: string) => {
		mkdirSync(join(workDir, path, ".."), { recursive: true });
		writeFileSync(join(workDir, path), text);
	};
	put(
		"README.md",
		"# Field notes\n\nThe agents keep their work here.\n\n- `src/` the scout's code\n- `notes/` what the archivist wrote down\n\n```ts\nconst answer = 42;\n```\n",
	);
	put(
		"src/main.ts",
		`import { readFile } from "node:fs/promises";

/** Counts the words of a file, ignoring blank lines. */
export async function words(path: string): Promise<number> {
	const text = await readFile(path, "utf8");
	return text.split(/\\s+/).filter(Boolean).length; // "quoted" 12_000
}

export const GREETING = \`hello \${"world"}\`;
`,
	);
	put(
		"src/report.py",
		`from dataclasses import dataclass


@dataclass
class Finding:
    title: str
    severity: int = 3  # 1 is worst


def worst(findings: list[Finding]) -> Finding | None:
    """The most severe finding, or None."""
    return min(findings, key=lambda f: f.severity, default=None)
`,
	);
	put(
		"deploy/stack.yml",
		'services:\n  web:\n    image: ghcr.io/example/web:1.4.0\n    ports: ["8080:80"]\n    environment:\n      MODE: production # not a secret\n',
	);
	put("notes/windows.txt", "line one\r\nline two\r\nno final newline");
	put(
		"config/settings.json",
		'{\n  "retries": 3,\n  "tags": ["a", "b"],\n  "debug": false\n}\n',
	);
	put("data/blob.bin", "\u0000\u0001binary\u0000");
	put("logs/big.log", "x".repeat(100));
	truncateSync(join(workDir, "logs/big.log"), 3 * 1024 * 1024);
	put("repo/.git/config", "[core]\n\trepositoryformatversion = 0\n");
	put("repo/readme.txt", "a repository");
	symlinkSync("/etc/hosts", join(workDir, "outside-link"));
}
seedWorkspace();
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
let teamForScripts: unknown;
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
			{ late: () => "Publish the post, go ahead." },
		);
		return { ok: true, text: `The card ended ${result}.` };
	},
	dispatch: async (request) => {
		const thread = await host?.context.services
			.get(THREADS)
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
			const prompts = host?.context.surfaces.prompts(
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
				teamForScripts as {
					message(
						caller: NonNullable<TurnRequest["agent"]>,
						to: string,
						text: string,
					): string;
				}
			).message(request.agent, "scout", "How large is the repository?");
		return { ok: true, text: "Asked the scout; the exchange is in a thread." };
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
		const text = request.text.toLowerCase().trim();
		// A group round hands each member the chat as `[Name] message` lines; the keyword is the newest line's.
		const said =
			[...text.matchAll(/^\[[^\]\n]+\] (.*)$/gm)].at(-1)?.[1] ?? text;
		const key = Object.keys(scripts).find(
			(marker) => text.startsWith(marker) || said.startsWith(marker),
		);
		const script = key ? scripts[key] : undefined;
		if (script) return script(request, new AbortController().signal);
		// A member of a group round shows an interim line, which names it the speaker, and takes its
		// time, so the round table can be seen with the speaker lit.
		if (request.agent?.group && request.interim) {
			await request.interim.post("Looking into it…");
			await sleep(7000);
		} else await sleep(400);
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
			...EXTRA.map(([name, displayName, avatarPrompt]) => ({
				name,
				displayName,
				prompt: `You are the ${name}.`,
				avatarPrompt,
			})),
		],
	} as never,
	plugins: [
		webConsole({
			auth: { mode: "none" },
			origin,
			dataDir,
			title: "Roundtable",
			cardGraceSeconds: 5,
			panes: [
				"rooms",
				"table",
				"workspace",
				"overview",
				"schedules",
				"conversations",
				"notes",
				"skills",
			],
			...(process.env.LOCALE
				? { presentation: { locale: process.env.LOCALE } }
				: {}),
			features: (context) => ({
				...(realSkills
					? { skills: registrySkills(context.services.get(SKILLS)) }
					: {
							skills: {
								catalog: () => SKILL_CATALOG,
								read: async (name: string) => {
									const skill = SKILL_DOCUMENTS[name];
									if (!skill) throw new Error("There is no such skill.");
									return skill;
								},
							},
						}),
				cleanup: {
					startFresh: async () => "archived",
					deleteConversation: async () => "deleted",
				},
			}),
			...(process.env.LOOK === "camelot"
				? { appearance: { look: "camelot" as const } }
				: {}),
		}),
		...(process.env.FIXTURE_HOST === "1" ? [hostFixture] : []),
	],
});

const services = host.context.services;
const { team } = services.get(AGENTS);
teamForScripts = team;
const deadline = Date.now() + 15_000;
while (team.coordinator() === undefined && Date.now() < deadline)
	await sleep(50);
// The seed agents are made one after another; the group needs all of them.
for (let attempt = 0; ; attempt += 1) {
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
		break;
	} catch (error) {
		if (attempt >= 40) throw error;
		await sleep(250);
	}
}
if (realSkills) {
	// Written skills in the real registry, so the editor has something to open and save.
	const registry = services.get(SKILLS);
	for (const [name, skill] of Object.entries(SKILL_DOCUMENTS)) {
		const description = String(skill.frontmatter.description ?? name);
		await registry.createDocument(
			`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${skill.body}\n`,
			"Ada",
		);
	}
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
		if (path === "/control/write") {
			const file = params.get("path") ?? "";
			if (!file || file.includes(".."))
				return new Response("bad path", { status: 400 });
			writeFileSync(join(workDir, file), params.get("text") ?? "");
			return new Response("written");
		}
		return new Response("say, control/mode, control/write", { status: 404 });
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
	// A host that is slow to stop must not keep the database: the process is killed soon after SIGTERM.
	await Promise.race([host?.stop(), sleep(2500)]);
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
	} catch (error) {
		console.warn("database not dropped:", error);
	}
	process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
