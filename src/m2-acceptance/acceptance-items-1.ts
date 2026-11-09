import {
	BACKFILL,
	BACKGROUND,
	BACKGROUND_CHECKS,
	CARDS,
	ISOLATION,
	type Item,
	MEMORY_PERSONA,
	MIGRATION,
	NOTIFY,
	t,
	WEBCHAT_AB,
	WEBCHAT_E2E,
} from "./acceptance-types.ts";

export const ITEMS_1: readonly Item[] = [
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
				"packages/webchat/src/chat-conversations.test.ts",
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
				"packages/webchat/src/chat-prompts.test.ts",
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
];
