import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The M2 acceptance index (T2.16): each item of the plan's test strategy (§6, principals and
// identity), with the tests that check it. A test is named as `bun test` prints it, its describe
// blocks and its name joined by " > "; `source` gives the text the file writes instead, for a
// name built from a template. The test below reads every listed file and fails when a listed name
// is no longer in it, so the index cannot point at a test that was renamed or removed. The tests
// this directory adds for items no other test covered are migration.test.ts (§6.1),
// isolation.test.ts (§6.2), and compatibility.test.ts (§6.4).

const ROOT = resolve(import.meta.dir, "../..");

interface Listed {
	/** The test file, from the repository root. */
	file: string;
	/** The test as `bun test` prints it: its describe blocks and its name, joined by " > ". */
	test: string;
	/** What the file writes, when the printed name is built from a template. */
	source?: readonly string[];
}

interface Item {
	section: "6.1" | "6.2" | "6.3" | "6.4" | "6.5";
	item: string;
	tests: readonly Listed[];
	/** Where an item no test of this repository can check is checked, or why part of it does not apply. */
	note?: string;
}

const t = (file: string, test: string, source?: string[]): Listed => ({
	file,
	test,
	...(source ? { source } : {}),
});

const BACKFILL = "src/core/identity/identity-backfill.test.ts";
const MIGRATION = "src/m2-acceptance/migration.test.ts";
const ISOLATION = "src/m2-acceptance/isolation.test.ts";
const WEBCHAT_E2E = "packages/webchat/src/principals.e2e.test.ts";
const WEBCHAT_AB =
	"webchat core principals with a self-built JWKS > A/B have separate memory, schedules and inboxes, and scheduled replies reach only their owner";
const UPGRADE = "src/cli/upgrade.test.ts";
const ACCESS = "src/core/config/access.test.ts";
const CARDS = "src/core/discord/owner-cards-scope.test.ts";
const BACKGROUND = "src/core/identity/background-identity.test.ts";
const BACKGROUND_CHECKS = "src/core/routing/background-checks.test.ts";
const MEMORY_PERSONA = "src/memory-persona-runtime.test.ts";
const NOTIFY = "src/core/builtin/modules-notify.test.ts";

const ACCEPTANCE: readonly Item[] = [
	// 6.1 Identity migration, on the 0.8.0 fixture database.
	{
		section: "6.1",
		item: "every id in owner_memory, schedules, conversations, and held_actions, and the old owner.id, has a principal of the same id",
		tests: [
			t(
				BACKFILL,
				"the principal backfill > on a 0.8.0 database, every stored id becomes a principal of the same id and no row changes",
			),
			t(
				BACKFILL,
				"the principal backfill > 0.8's remote-mcp speaker is the primary owner: its schedules run at the owner tier through the owner's principal",
			),
			t(
				"src/memory-upgrade.test.ts",
				"memory after an upgrade from 0.8 > the primary owner's 0.8 memory loads in their own conversation and in a remote turn of theirs, and a member reads only theirs",
			),
		],
	},
	{
		section: "6.1",
		item: "the existing rows are compared row by row: none is rewritten",
		tests: [
			t(
				BACKFILL,
				"the principal backfill > on a 0.8.0 database, every stored id becomes a principal of the same id and no row changes",
			),
			t(
				MIGRATION,
				"upgrading a 0.8.0 database > a second start writes nothing: the principals, their identities and roles, and every 0.8 row stay as the first start left them",
			),
		],
	},
	{
		section: "6.1",
		item: "a second start adds nothing (idempotent)",
		tests: [
			t(
				MIGRATION,
				"upgrading a 0.8.0 database > a second start writes nothing: the principals, their identities and roles, and every 0.8 row stay as the first start left them",
			),
			t(
				BACKFILL,
				"the principal backfill > the actor id of someone this version admitted, in the rows it writes, makes no principal at the next boot",
			),
		],
	},
	{
		section: "6.1",
		item: "rows an older build writes after the upgrade (a downgrade) converge: the next start makes their principals",
		tests: [
			t(
				MIGRATION,
				"upgrading a 0.8.0 database > what an older build writes after the upgrade, in each table 0.8 names people in, gets its principal at the next start, and no row is rewritten",
			),
			t(
				BACKFILL,
				"the principal backfill > a row an older build writes after the upgrade gets its principal at the next boot",
			),
			t(
				BACKFILL,
				"the principal backfill > a held action 0.8 wrote over this version's is 0.8's: the principal left from the hold before makes its actor id no less a 0.8 speaker",
			),
			t(
				"src/core/agents/agent-team-groups.test.ts",
				"PostgreSQL > groups > held actions 0.8 held over another's after a rollback are its speaker's: the principal of the hold before approves nothing",
			),
		],
	},
	{
		section: "6.1",
		item: "legacy claim: a Discord user and an M1 web chat user each claim the principal of their old id at first contact; none is claimed when the principal already has a link of that provider",
		tests: [
			t(
				MIGRATION,
				"upgrading a 0.8.0 database > the people of 0.8 come back as their principals at first contact, on Discord and on the web; an identity of a provider the principal already has claims nothing",
			),
			t(
				"src/core/identity/router-identity.test.ts",
				"the router resolving authors through the identity service > a Discord user carried over from 0.8 is their old principal, before and after the claim",
			),
			t(
				"src/core/identity/identity-service.test.ts",
				"the identity service > no claim when the principal already has an identity of that provider, nor of a new or the system id",
			),
			t(
				WEBCHAT_E2E,
				"webchat core principals with a self-built JWKS > M1's backfilled oidc owner keeps their conversation without rewriting it; CLI linking Discord then web shares memory",
			),
		],
	},
	{
		section: "6.1",
		item: "the doctor's dry run gives the numbers the start's backfill logs",
		tests: [
			t(
				"src/cli/checks/identity.test.ts",
				"the principals check > on a 0.8.0 database, prints the backfill the next start logs, word for word",
			),
			t(
				BACKFILL,
				"the principal backfill > the summary counts the ids of each table, and a dry run writes nothing",
			),
		],
	},
	{
		section: "6.1",
		item: "a real 0.8 deployment's backup copy starts on 0.9",
		tests: [],
		note: "T2.18, in that deployment's own repository on a backup copy of its database; nothing in this repository can run it.",
	},

	// 6.2 Two principals, A and B, kept apart: on the web chat (end to end) and on Discord.
	{
		section: "6.2",
		item: "conversation: B cannot list, read, write in, or delete A's private conversation",
		tests: [
			t(WEBCHAT_E2E, WEBCHAT_AB),
			t(
				"packages/webchat/src/chat.test.ts",
				"nobody else may write in, stop, or read a person's conversation",
			),
			t(
				"src/fail-closed-runtime.test.ts",
				"in a private conversation, another principal's turn is refused before the model is asked; its person's and the host's run",
			),
			t(
				"packages/mcp/src/remote-mcp/remote-mcp-principal.test.ts",
				"remote MCP bound to a principal on a host > bound to a member, the turns are theirs at the member tier, and the owner's sessions are not",
			),
			t(
				"packages/web/src/web-plugin.test.ts",
				"several owners > a member the verifier vouches for is refused everywhere",
			),
			t(
				"src/core/routing/channel-router.test.ts",
				"ChannelRouter > deletes only through a claim that deletes, and never while the channel is busy",
			),
		],
		note: "The web chat has no delete; a conversation is deleted only through the claim that owns it, and Discord's owner command that deletes an agent's channel is the owners'.",
	},
	{
		section: "6.2",
		item: "memory: B's system prompt and memory_search hold none of A's facts; memory_add writes A's own",
		tests: [
			t(WEBCHAT_E2E, WEBCHAT_AB),
			t(
				MEMORY_PERSONA,
				"memory in a persona conversation > two people's private conversations each carry only their own memory, and memory_add writes their own",
			),
			t(
				"src/memory-isolation-runtime.test.ts",
				"memory in a shared conversation's history > another speaker's and the host's requests carry none of Ann's memory; Ann's own next turn still does",
			),
		],
	},
	{
		section: "6.2",
		item: "approval: B's press or text cannot approve A's held turn; in a shared conversation an owner may approve the escalation",
		tests: [
			t(
				ISOLATION,
				"two members of one tier on Discord > B's press on the card of A's held call in a shared conversation is refused; A's approves it",
			),
			t(
				CARDS,
				"cards by the prompt scope > in a private conversation only its person answers: an owner may not approve or answer for them",
			),
			t(
				CARDS,
				"cards by the prompt scope > a shared conversation's call above the speaker's tier goes to every owner: the card mentions them, and the second owner approves it",
			),
			t(
				"src/core/agents/agent-team-groups.test.ts",
				"PostgreSQL > groups > a held call is its principal's: the same person on another identity approves it, another principal of the same tier does not",
			),
			t(
				"packages/webchat/src/surface.test.ts",
				"the web chat surface keeps the chat surface contract > another principal cannot answer for the person in their private conversation, even an owner",
				["describeSurfaceContract", "the web chat surface"],
			),
			t(
				"src/core/testing/surface-contract.ts",
				"another principal cannot answer for the person in their private conversation, even an owner",
			),
			t(
				"packages/webchat/src/chat.test.ts",
				"an approval goes to the conversation's person, only they answer it, and only at its tier",
			),
		],
	},
	{
		section: "6.2",
		item: "schedules: B's schedule_list neither shows nor removes A's; a run is A's principal and tier, its reply only A's",
		tests: [
			t(WEBCHAT_E2E, WEBCHAT_AB),
			t(
				"src/core/modules/schedules/schedule-principals.test.ts",
				"whose schedules a conversation lists > in a private conversation a person lists, reads, changes, and cancels only their own",
			),
			t(
				"src/core/personal-target.test.ts",
				"the personal background target on a host without Discord > a conversation whose claim takes background turns schedules, and the run is its creator's, at their tier",
			),
			t(
				BACKGROUND_CHECKS,
				"ChannelRouter checking whom a background turn runs as > a turn runs as its author's principal, at its tier or theirs, whichever is lower, under the name and id it carries",
			),
			t(
				"src/core/builtin/modules.test.ts",
				"modulesPlugin > from a conversation without a chat channel, another person's schedules and reports go to their own direct messages, never the owner's",
			),
			t(
				"packages/webchat/src/background.test.ts",
				"a background turn after restart runs privately and pushes only to its principal",
			),
		],
	},
	{
		section: "6.2",
		item: "notify: A's notice reaches only A's private channel",
		tests: [
			t(WEBCHAT_E2E, WEBCHAT_AB),
			t(
				"packages/webchat/src/notices.test.ts",
				"webchat's persistent private inbox > notices survive reattach and another principal cannot list or mark them read",
			),
			t(
				NOTIFY,
				"notify > each person's notice goes to their own direct channel, in their conversation or as the speaker of a shared one",
			),
			t(
				NOTIFY,
				"notify > in someone else's private conversation, a speaker's notice is refused and nothing is sent to either",
			),
			t(
				"src/core/discord/direct-channel.test.ts",
				"the Discord direct channel > reaches another principal through a Discord identity of theirs, the primary owner's first among several",
			),
		],
	},
	{
		section: "6.2",
		item: "a second owner C uses the owner's commands and approves shared escalations, but reads none of the primary owner's memory",
		tests: [
			t(
				"src/core/discord/owner-command.test.ts",
				"the owner's commands with more than one owner > a second owner uses the owner's commands and their autocomplete; a member is refused as before",
			),
			t(
				CARDS,
				"cards by the prompt scope > a shared conversation's call above the speaker's tier goes to every owner: the card mentions them, and the second owner approves it",
			),
			t(
				MEMORY_PERSONA,
				"memory in a persona conversation > a second owner, and a web user at the owner tier, read and change their own memory, never the primary owner's",
			),
			t(
				"packages/web/src/web-plugin.test.ts",
				"several owners > the notes pane shows the visitor's own notes, and switches to another principal's",
			),
		],
		note: "The web chat has no owner commands; its owner-tier person's memory is the memory-persona test's web user.",
	},
	{
		section: "6.2",
		item: "A disabled: A's next message gets no answer, and A's schedules are skipped",
		tests: [
			t(
				ISOLATION,
				"a Discord person disabled between two messages > is served, then their next message reaches no turn, and once enabled they are served again; B is served throughout",
			),
			t(
				"packages/webchat/src/authorization.test.ts",
				"a disabled or relinked core identity cannot keep acting on its old connection",
			),
			t(
				BACKGROUND,
				"background turns as the identity service sees their principal > a disabled principal's schedule is skipped, saying so, and runs again once they are enabled",
			),
			t(
				"src/cli/principal.test.ts",
				"roundtable principal > disable stops a principal being served, enable brings them back",
			),
			t(
				"src/core/identity/identity-service.test.ts",
				"the identity service > a change another process makes, such as the CLI disabling someone, is seen within the cache's lifetime",
			),
		],
	},
	{
		section: "6.2",
		item: "A's tier only from an IdP role, unseen past backgroundStaleDays: A's schedules are skipped, the reason recorded",
		tests: [
			t(
				BACKGROUND,
				"background turns as the identity service sees their principal > the schedule of someone whose tier comes only from the identity provider is skipped once backgroundStaleDays pass unseen",
			),
			t(
				BACKGROUND,
				"background turns as the identity service sees their principal > the precheck of someone unseen past backgroundStaleDays does not run",
			),
			t(
				BACKGROUND_CHECKS,
				"ChannelRouter checking whom a background turn runs as > a turn of a disabled principal, of one unseen past backgroundStaleDays, or of no principal is skipped, saying why",
			),
		],
		note: "The reason is the schedule's recorded status (the precheck test reads it) and the scheduler's 'schedule finished' log line, which carries the outcome.",
	},
	{
		section: "6.2",
		item: "M0's memory leak stays fixed, and no source makes anyone the owner by a default",
		tests: [
			t(
				"src/core/runtime/extensions/session-prompt.test.ts",
				"appended system prompt > a speaker other than the owner gets their own memory, not the owner's",
			),
			t(
				MEMORY_PERSONA,
				"memory in a persona conversation > a member's turn carries the member's memory, never the owner's, and the tools change only the member's",
			),
			t(
				"src/core/fail-closed.test.ts",
				"no source makes anyone the owner by a default, except where the scan lists why",
			),
		],
	},

	// 6.3 A single-owner Discord host tells the model what 0.8.0 did.
	{
		section: "6.3",
		item: "the system prompt and tool definitions of sessions (a) to (g) match the snapshot recorded on 0.8.0, its only changes the ones listed in prompt-text.test.ts",
		tests: [
			t(
				"src/prompt-text.test.ts",
				"the prompt text of a single-owner host > every session kind sends the model the recorded prompt and tool definitions",
			),
			t(
				"src/prompt-text.test.ts",
				"the prompt text of a single-owner host > the same owner written in access sends the model the same text",
			),
			t(
				"src/fail-closed-runtime.test.ts",
				"a turn without a speaker is refused before the model is asked, naming the fix",
			),
			t(
				NOTIFY,
				"notify > is named notify, and with only Discord's direct messages reads word for word as notify_owner did",
			),
		],
		note: "T2.18 compares a real deployment's own owner and agent conversations the same way, in its repository.",
	},
	{
		section: "6.3",
		item: "the tool set and its tiers match tool-set.snapshot.json",
		tests: [
			t(
				"src/core/tool-set.test.ts",
				"the tool set under the default configuration > the owner's session, an agent's session, and a group seat offer the recorded tools at the recorded tiers",
			),
		],
	},

	// 6.4 Configuration compatibility.
	{
		section: "6.4",
		item: "one actor-to-tier table gives the same tier, row by row, under the 0.8 form, hand-written access, and the upgrade's output",
		tests: [
			t(
				UPGRADE,
				"the 0.8 form, hand-written access, and the upgrade's output > give every actor the same tier, row by row",
			),
			t(
				ACCESS,
				"the access configuration > a 0.8 owner and speakers and the same people written with access give every author the same tier",
			),
		],
	},
	{
		section: "6.4",
		item: "the 0.8 form warns once; owner or speakers beside access is a ConfigError",
		tests: [
			t(
				ACCESS,
				"the access configuration > the 0.8 form warns once per host logger, however often the host is defined",
			),
			t(
				ACCESS,
				"the access configuration > access together with owner or speakers, neither, a primary owner without a principal, or Discord without the primary owner's Discord identity is refused",
			),
			t(
				UPGRADE,
				"upgradeSource > refuses access written beside owner, changing nothing and saying where",
				[
					"upgradeSource",
					'"access written beside owner": [',
					"test(`refuses ",
					", changing nothing and saying where`",
				],
			),
		],
	},
	{
		section: "6.4",
		item: "roundtable upgrade is idempotent",
		tests: [
			t(
				UPGRADE,
				"roundtable upgrade on a 0.8 project > shows the diff and writes nothing without --write, then writes, then has nothing left",
			),
			t(
				UPGRADE,
				"upgradeSource > leaves a configuration already in the 0.9 form as it is",
			),
		],
	},
	{
		section: "6.4",
		item: "both init templates start",
		tests: [
			t(
				"src/cli/init-preflight.test.ts",
				"a fresh discord project loads the Pi package that registers compact_session, which the runtime's preflight requires",
				[
					'for (const adapter of ["discord", "web"] as const)',
					"project loads the Pi package that registers",
					"which the runtime's preflight requires",
					"expect(report.started).toBe(true);",
				],
			),
			t(
				"src/cli/init-web.test.ts",
				"a project init --adapter web made passes the doctor's offline checks and starts",
			),
		],
	},
	{
		section: "6.4",
		item: "0.8's API keeps working in 0.9, with a warning: a surface without actor, prompts(channel, speaker), OwnerPrompts, OWNER_TARGET, and notify_owner in selections and toolTiers",
		tests: [
			t(
				"src/core/routing/channel-router-identity.test.ts",
				"ChannelRouter resolving who wrote a message > a surface that reports no actor has its author read from the author fields, warned once",
			),
			t(
				"src/core/routing/surface-port.test.ts",
				"prompts take a scope as given, and 0.8's speaker as theirs in a shared conversation, with a deprecation",
			),
			t(
				"src/m2-acceptance/compatibility.test.ts",
				"OWNER_TARGET is PERSONAL_TARGET, and OwnerPrompts is Prompts, from the public entry",
			),
			t(
				"src/core/tool-tiers.test.ts",
				"a tool renamed since 0.8 > warns once per host logger when an old name is used in tiers or selections, and never for the new name",
			),
			t(
				"src/core/tool-tiers.test.ts",
				"a tool renamed since 0.8 > the operator's tier under its old name, such as notify_owner, is the new name's, unless the new name has its own",
			),
		],
		note: "OwnerPrompts and OWNER_TARGET warn through their @deprecated tags, which scripts/public-api.report.json keeps exported.",
	},

	{
		section: "6.2",
		item: "bridge guards use actual raw private history, while admission only warns; sandbox custom private exchanges are projected in requests and summaries",
		tests: [
			t(
				"src/memory-isolation-runtime.test.ts",
				"bridge reads actual shared history > owner and SYSTEM run over owner memory; guest is refused without a provider call, including after restart",
			),
			t(
				"src/memory-isolation-runtime.test.ts",
				"bridge reads actual shared history > only the guest's own memory admits the guest and refuses the owner and SYSTEM",
			),
			t(
				"src/core/runtime/bridge-guard.test.ts",
				"bridge refuses unowned outstanding memory calls but ignores public history and other providers",
			),
			t(
				"src/core/runtime/bridge-guard.test.ts",
				"bridge agent-model switch checks the same raw history",
			),
			t(
				"src/core/runtime/runtime-plugin.test.ts",
				"the runtime plugin's preflight of claude-bridge with memory > warns without stopping boot when stored roles admit someone besides the owner",
			),
			t(
				"src/core/define-roundtable.test.ts",
				"claude-bridge in a host whose shared conversations several people speak in > boots with a warning that says why shared bridge history remains risky",
			),
			t(
				"packages/sandbox/worker/pi-tools.test.ts",
				"sandbox host compactor receives no custom private exchange, including its kept tail",
			),
			t(
				"packages/sandbox/worker/pi-tools.test.ts",
				"sandbox built-in Pi summary contains no custom private exchange or prompt memory",
			),
			t(
				"src/core/runtime/extensions/private-memory.test.ts",
				"custom private results hide their call arguments, including across split compaction boundaries",
			),
		],
	},
	{
		section: "6.2",
		item: "core compaction redacts private custom call arguments even when their tagged result stays in the kept branch",
		tests: [
			t(
				"src/core/runtime/extensions/private-memory.test.ts",
				"core compaction hook pairs a custom private result in the kept branch with summarized arguments",
			),
		],
	},
	{
		section: "6.2",
		item: "the bridge's owner legacy exception never adopts modern unowned memory results",
		tests: [
			t(
				"src/core/runtime/bridge-guard.test.ts",
				"legacy owner compatibility stops at the first 0.9 scope record; modern unowned memory refuses even owner and SYSTEM",
			),
		],
	},
	// 6.5 The gates of the parent plan's §6.1, unchanged.
	{
		section: "6.5",
		item: "typecheck, lint, test with PostgreSQL, check:packages, the sandbox Docker integration, guide.test.ts, the public API report, scan-public, and CI on the commit",
		tests: [
			t(
				"examples/guide.test.ts",
				"every block in the guide is exactly the file it names",
			),
			t(
				"src/entries.test.ts",
				"published declarations match the signature report and the remaining leak baseline",
			),
		],
		note: "The rest are the gate's commands and .github/workflows/ci.yml, run on every pushed commit.",
	},
];

/** A listed test's describe blocks and name, as the file writes them. */
const partsOf = (listed: Listed): readonly string[] =>
	listed.source ?? listed.test.split(" > ");

describe("the M2 acceptance index", () => {
	test("lists every section of §6, each item with its tests or a note saying where it is checked", () => {
		expect(new Set(ACCEPTANCE.map((item) => item.section))).toEqual(
			new Set(["6.1", "6.2", "6.3", "6.4", "6.5"]),
		);
		for (const item of ACCEPTANCE)
			expect({
				item: item.item,
				checked: item.tests.length > 0 || !!item.note,
			}).toEqual({ item: item.item, checked: true });
	});

	test("names only tests that are in their files", () => {
		const missing: string[] = [];
		for (const item of ACCEPTANCE)
			for (const listed of item.tests) {
				const path = join(ROOT, listed.file);
				if (!existsSync(path)) {
					missing.push(`${listed.file}: no such file`);
					continue;
				}
				const text = readFileSync(path, "utf8");
				for (const part of partsOf(listed))
					if (!text.includes(part))
						missing.push(`${listed.file}: ${JSON.stringify(part)}`);
			}
		expect(missing).toEqual([]);
	});
});
