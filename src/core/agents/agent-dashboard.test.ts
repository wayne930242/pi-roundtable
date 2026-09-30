import { describe, expect, test } from "bun:test";
import { silentLogger } from "../log.ts";
import { AgentDashboard, dashboardSections } from "./agent-dashboard.ts";
import type { TeamStatus } from "./agent-team.ts";

const NOW = new Date("2026-09-27T06:30:00Z");
const TRACES = "https://example.com/traces/";
const APP = "https://example.com/app/";
/** The plugins' lines: the web app's, then the trace viewer's. */
const LINES = [
	`🧭 [Web app](${APP}) full dashboard, notes, and cleanup`,
	`🔭 [Traces](${TRACES}) each message's model, tools, and tokens`,
];

const status: TeamStatus = {
	agents: [
		{
			name: "infra",
			displayName: "Infra",
			channelId: "11",
			model: "openai-codex/gpt-6-sol",
			thinking: "high",
			workingIn: "12",
			waiting: 2,
			context: { tokens: 42_000, contextWindow: 200_000 },
			lastActive: new Date("2026-09-27T06:03:00Z"),
			schedules: 1,
		},
		{
			name: "doctor",
			displayName: "Bot Doctor",
			channelId: "13",
			model: "claude-bridge/claude-opus-5-5",
			thinking: "medium",
			waiting: 0,
			schedules: 0,
		},
	],
	groups: [
		{
			name: "ops",
			displayName: "Ops group",
			channelId: "12",
			members: ["Coordinator", "Infra"],
			host: "Coordinator",
			busy: 1,
			lastActive: new Date("2026-09-26T06:03:00Z"),
		},
	],
};

describe("dashboardSections", () => {
	test("shows the plugins' links, then each agent's and group's state", () => {
		const [header, agents, groups] = dashboardSections(status, LINES, NOW);
		// The header the links were written into before plugins contributed them, byte for byte.
		expect(header).toBe(
			"## Agent server\n🧭 [Web app](https://example.com/app/) full dashboard, notes, and cleanup\n🔭 [Traces](https://example.com/traces/) each message's model, tools, and tokens\n-# Updated 06:30; refreshed when a turn starts or ends, at most every 10 seconds",
		);
		expect(agents).toContain("**Infra** <#11>");
		expect(agents).toContain("`openai-codex/gpt-6-sol` · thinking `high`");
		expect(agents).toContain(
			"🟠 Working (<#12>), 2 queued · context 42k / 200k (21%)",
		);
		expect(agents).toContain("-# Schedules 1 · Last active 06:03");
		expect(agents).toContain("🟢 Idle · context —");
		expect(agents).toContain("No activity since startup");
		expect(groups).toContain("**Ops group** <#12>");
		expect(groups).toContain("Members: Coordinator, Infra | Host: Coordinator");
		expect(groups).toContain("🟠 1 in progress");
		expect(groups).toContain("-# Last active 09-26 06:03");
	});

	test("stays within Discord's text limit, saying how many were left out", () => {
		const many: TeamStatus = {
			agents: Array.from({ length: 60 }, (_, i) => ({
				...status.agents[1],
				name: `a${i}`,
				displayName: `Agent ${i}`,
			})) as TeamStatus["agents"],
			groups: [],
		};
		const sections = dashboardSections(many, LINES, NOW);
		expect(sections.join("").length).toBeLessThan(4000);
		expect(sections[1]).toMatch(/\d+ more not listed/);
		expect(sections[2]).toContain("None.");
	});
});

describe("AgentDashboard", () => {
	test("updates at once, then at most once per interval, and keeps going after a failure", async () => {
		const shown: string[][] = [];
		let fail = true;
		const dashboard = new AgentDashboard({
			status: async () => status,
			board: {
				show: async (sections) => {
					if (fail) {
						fail = false;
						throw new Error("discord down");
					}
					shown.push(sections);
				},
			},
			lines: () => LINES,
			logger: silentLogger(),
			minIntervalMs: 40,
			refreshMs: 60_000,
		});
		dashboard.start();
		await Bun.sleep(10);
		expect(shown).toHaveLength(0);
		dashboard.changed();
		dashboard.changed();
		await Bun.sleep(15);
		expect(shown).toHaveLength(0);
		await Bun.sleep(50);
		expect(shown).toHaveLength(1);
		dashboard.stop();
	});
});
