import { ACCESS, type Item, t, UPGRADE } from "./acceptance-types.ts";

export const ITEMS_2: readonly Item[] = [
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
				"src/core/runtime/tool-tiers.test.ts",
				"a tool renamed since 0.8 > warns once per host logger when an old name is used in tiers or selections, and never for the new name",
			),
			t(
				"src/core/runtime/tool-tiers.test.ts",
				"a tool renamed since 0.8 > the operator's tier under its old name, such as notify_owner, is the new name's, unless the new name has its own",
			),
		],
		note: "OwnerPrompts and OWNER_TARGET warn through their @deprecated tags, which scripts/public-api.report.json keeps exported.",
	},

	{
		section: "6.2",
		item: "bridge guards use reader records and actual raw private history, while admission only warns; sandbox custom private exchanges are projected in requests and summaries",
		tests: [
			t(
				"src/memory-isolation-runtime.test.ts",
				"bridge reads actual shared history > prompt-only private memory refuses another bridge reader before a provider call; memory-none turns stay public",
			),
			t(
				"src/core/runtime/bridge-guard.test.ts",
				"reader records attribute malformed, truncated and aborted memory calls to their turn",
			),
			t(
				"src/core/runtime/bridge-guard.test.ts",
				"reader records guard prompt-only memory and preserve public multi-reader turns across compaction",
			),
			t(
				"packages/sandbox/worker/pi-tools.test.ts",
				"sandbox bridge reader records refuse prompt-only private memory but allow public party turns",
			),
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
				"src/core/host/define-roundtable-bridge.test.ts",
				"claude-bridge in a host whose shared conversations several people speak in > boots with a warning that says why shared bridge history remains risky",
			),
			t(
				"packages/sandbox/worker/pi-tools.test.ts",
				"sandbox host compactor receives no custom private exchange, including its kept tail",
			),
			t(
				"packages/sandbox/worker/pi-tools.test.ts",
				"sandbox shared prompt blocks keep A to B to A bridge turns public; default private blocks refuse B",
			),
			t(
				"packages/sandbox/worker/pi-tools.test.ts",
				"sandbox real Pi prompt-only bridge turns refuse private cross-reader replay but allow shared party A to B to A",
			),
			t(
				"packages/sandbox/src/pi-runtime.test.ts",
				"Pi memory prompt blocks default private and can explicitly remain shared",
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
		item: "sandbox mixed versions fail closed only when private-history capabilities are needed",
		tests: [
			t(
				"packages/sandbox/src/pi-capabilities.test.ts",
				"sandbox capabilities are demand-driven: legacy public turns and tools still run",
			),
			t(
				"packages/sandbox/src/pi-capabilities.test.ts",
				"sandbox refuses old worker images before sending private prompts or replaying known private history",
			),
			t(
				"packages/sandbox/src/pi-capabilities.test.ts",
				"sandbox capability downgrade invalidates an already queued private turn",
			),
			t(
				"packages/sandbox/src/pi-capabilities.test.ts",
				"sandbox ready handshake validates capability shapes and upgraded workers preserve privateTo",
			),
			t(
				"packages/sandbox/src/pi-runtime.test.ts",
				"runtime names the stale image and sends no private prompt, while shared public hosts stay compatible",
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
		item: "public projection API has no guard-only legacy attribution escape hatch",
		tests: [
			t(
				"src/entries.test.ts",
				"published MemoryView exposes no guard-only legacyOwner attribution",
			),
			t(
				"src/core/runtime/extensions/private-memory.test.ts",
				"public memory projections cannot opt into guard-only legacy ownership",
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
	{
		section: "6.2",
		item: "agent model switches cannot race the per-turn history guard",
		tests: [
			t(
				"src/fail-closed-runtime.test.ts",
				"an agent turn checks and uses one model snapshot when its settings change during selection",
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
