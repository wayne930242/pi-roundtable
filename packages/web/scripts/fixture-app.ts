// A local host for trying the owner app in a browser: a real host over a scratch PostgreSQL
// database, two agents and a group, no Discord, and no authentication (`none`, on a loopback port).
//
//   ROUNDTABLE_TEST_DATABASE_URL  a PostgreSQL URL whose server may create a database; the fixture
//                                 makes `fixture_<time>` there and drops it when it stops
//   PORT                          the app (default 4180); PORT + 1 is the control port below
//   LOOK                          the host's look, `modern` (default) or `camelot`
//   HOME_CHATS                   `1` opens the app on the chat list (`appearance.home: "chats"`)
//   LOCALE                       the presentation locale, for example `zh-TW` (default: none, English)
//   FIXTURE_SKILLS               `registry` lists the host's real skill registry (the built-in skills, plus
//                                 two written ones made at start) so the skill editor works; default: the fake catalog below
//
// The page is built into dist/ at start when dist/ has none.
//   FIXTURE_COMMANDS              `1` declares an extension command ("stats") as safe for chat, so a knight's room lists it after /clear and its skills
//   FIXTURE_HOST                  `1` registers a host room kind ("inbox": an empty room and one with a message,
//                                 both open to notes and turns) and a host page, for trying the host rooms
//   FIXTURE_OWNERS                `2` makes two owners, Ada and Bob, who sign in by the `fixture_owner` cookie (`ada`, the default, or `bob`),
//                                 so the agent rooms have two readers and the composer offers @AI and notes
//   FIXTURE_AGENTS                how many agents the host has, 3 to 12 (default 3)
//   FIXTURE_COUNCIL               how many members the group "crew", the council on the round table, has, 2 to 8
//                                 (default 2): the scripted scout, archivist and guide, then the extra agents
//   FIXTURE_TIER                  `member` (with FIXTURE_HOST=1) admits every request as a member of the host (admission
//                                 access, the panes rooms and table), who lists only the "Support thread" room of the inbox
//
// The agents are scripts: start a message with a keyword and the agent acts it out.
//   approve  a held action with details          timeout  a turn's time-limit card
//   ask      a question with options             quiz     a questionnaire
//   late     a card the turn stops waiting on    stream   streamed text and tool chips, then a reply
//   dispatch a coding job in a thread, with a card there     exchange  the agent asks the scout in a thread
//   helpers  the agent makes four temp knights, one working for a long time, one waiting on a card, two done
//   endhelpers  the agent archives its finished temp knights, as helper_end does
//   blocks   a reply with a block of every kind the app draws, five of them answerable (options, form, checklist, suggest, review)
// During a running turn (try `stream`), a message with "steer" in it is added to the turn; any other waits its own turn (queued).
// Anything else gets a reply in Markdown. The control port sends a message as the owner:
//   curl 'http://127.0.0.1:4181/say?room=app:agent.guide&text=approve'
// `GET /control/mode?room=...&yolo=1&long=1` sets a room's modes. `GET /control/write?path=src/main.ts&text=...`
// writes a file in the agents' workspace the way a partner would, to try the files pane's conflict check. The page is at http://127.0.0.1:PORT/console/.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { buildPage } from "./build-page.ts";
import { fixtureConnectorFeatures } from "./fixture-connectors.ts";
import { SAMPLE } from "./fixture-samples.ts";

import { seedWorkspace } from "./fixture-workspace.ts";

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
const { AGENTS, MODES, SCHEDULES, SKILLS } = await import("pi-roundtable");
const { testHost } = await import("pi-roundtable/testing");
const { webConsole } = await import("../src/web-plugin.ts");
const { admitAs, refuse } = await import("../src/verifier.ts");
type TurnRequest = Parameters<
	import("pi-roundtable").AgentRuntime["runTurn"]
>[0];

const { SKILL_CATALOG, SKILL_DOCUMENTS, registrySkills } = await import(
	"./fixture-skills.ts"
);
const { commandFixture, hostFixture } = await import("./fixture-plugins.ts");
const { fixtureScripts, sleep } = await import("./fixture-scripts.ts");

const realSkills = process.env.FIXTURE_SKILLS === "registry";

const origin = `http://127.0.0.1:${port}`;
const asMember = process.env.FIXTURE_TIER === "member";
const MEMBER_IDENTITY = "discord:300000000000000013";

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
const councilSize = Math.min(
	8,
	Math.max(2, Number(process.env.FIXTURE_COUNCIL ?? 2)),
);
const councilMembers = [
	"scout",
	"archivist",
	"guide",
	...EXTRA.map(([name]) => name),
].slice(0, councilSize);
const dataDir = mkdtempSync(join(tmpdir(), "fixture-app-"));
const workDir = join(dataDir, "work");
seedWorkspace(workDir);

let host: Awaited<ReturnType<typeof testHost>> | undefined;
let teamForScripts: unknown;
const scripts = fixtureScripts({
	host: () => host,
	team: () => teamForScripts,
});

const runtime = {
	runTurn: async (request: TurnRequest) => {
		const text = request.text.toLowerCase().trim();
		// A temp knight acts out its task: one runs for a long while, one waits on a card, the rest finish.
		if (text.includes("survey the harbour slowly")) {
			await sleep(10 * 60_000);
			return { ok: true as const, text: "The survey is done." };
		}
		if (text.includes("approve the permit"))
			return scripts.approve?.(request, new AbortController().signal);
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
	// A message that starts with "steer" is taken into the running turn; any other waits for its own.
	steer: async (_channel: string, text: string) =>
		text.toLowerCase().includes("steer"),
	stop: () => false,
	startFresh: async () => undefined,
	deleteConversation: async () => undefined,
	pendingConfirmation: () => undefined,
	heldActions: async () => undefined,
	recentTranscript: async () => [],
};

// Two owners sign in by a cookie the fixture's verifier reads; one owner is the console's `none`.
const OWNERS = [
	{ name: "Ada", subject: "100000000000000001" },
	{ name: "Bob", subject: "300000000000000003" },
];
const twoOwners = process.env.FIXTURE_OWNERS === "2";
const cookieVerifier = (request: Request) => {
	const chosen = /(?:^|;\s*)fixture_owner=(\w+)/.exec(
		request.headers.get("cookie") ?? "",
	)?.[1];
	const owner =
		OWNERS.find((one) => one.name.toLowerCase() === chosen) ?? OWNERS[0];
	return owner
		? admitAs({ provider: "discord", subject: owner.subject, name: owner.name })
		: refuse("no owner");
};

host = await testHost({
	discord: false,
	runtime: runtime as never,
	config: {
		dataDir,
		http: { port, hostname: "127.0.0.1" },
		...(asMember
			? {
					access: {
						owners: [
							{
								name: "Ada",
								principal: "100000000000000001",
								identities: ["discord:100000000000000001"],
							},
						],
						members: { identities: [MEMBER_IDENTITY] },
					},
				}
			: twoOwners
				? {
						access: {
							owners: OWNERS.map((one) => ({
								name: one.name,
								principal: one.subject,
								identities: [`discord:${one.subject}`],
							})),
						},
					}
				: {}),
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
			...(asMember
				? {
						// Every request is the member's, as a signing proxy would vouch for them.
						verifier: () =>
							admitAs({
								provider: "discord",
								subject: MEMBER_IDENTITY.slice("discord:".length),
								name: "Mel",
							}),
						admission: "access" as const,
					}
				: twoOwners
					? { verifier: cookieVerifier }
					: { auth: { mode: "none" as const } }),
			origin,
			dataDir,
			title: "Roundtable",
			cardGraceSeconds: 5,
			panes: asMember
				? {
						owner: ["rooms", "table"],
						member: ["rooms", "table"],
					}
				: [
						"rooms",
						"table",
						"workspace",
						"overview",
						"schedules",
						"conversations",
						"notes",
						"skills",
						"connectors",
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
				...fixtureConnectorFeatures(),
			}),
			...(process.env.LOOK === "camelot" || process.env.HOME_CHATS === "1"
				? {
						appearance: {
							...(process.env.LOOK === "camelot"
								? { look: "camelot" as const }
								: {}),
							...(process.env.HOME_CHATS === "1"
								? { home: "chats" as const }
								: {}),
						},
					}
				: {}),
		}),
		...(process.env.FIXTURE_HOST === "1" ? [hostFixture] : []),
		...(process.env.FIXTURE_COMMANDS === "1" ? [commandFixture] : []),
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
			members: councilMembers,
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
