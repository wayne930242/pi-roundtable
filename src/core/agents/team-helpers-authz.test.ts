import { describe, expect, test } from "bun:test";
import type { Speaker } from "../speakers.ts";
import { describeDb } from "../testing/database.ts";
import { agentChannel, fx, useTeamFixture } from "./agent-team-fixture.ts";
import {
	asCoordinator,
	inTurn,
	SCOUT,
	scopeOf,
	settle,
} from "./helper-test-kit.ts";
import { teamSelection } from "./team-selection.ts";

describeDb("temp knights (Discord) authority", () => {
	useTeamFixture();

	describe("parallel creates and the temp knight's authority", () => {
		const MEMBER: Speaker = {
			id: "2",
			name: "Bo",
			tier: "member",
			principalId: "2",
		};

		test("named creates made at once keep the caps and never surface a raw database error", async () => {
			const results = await asCoordinator((caller) =>
				Promise.allSettled(
					[0, 1, 2, 3, 4, 5].map((i) =>
						fx.team.helperCreate(caller, {
							...SCOUT,
							displayName: `Scout ${i}`,
							name: `scout-${i}`,
						}),
					),
				),
			);
			await settle();
			expect(fx.team.helpersOf("coordinator").length).toBeLessThanOrEqual(4);
			for (const result of results)
				if (result.status === "rejected")
					expect(String(result.reason)).not.toContain("duplicate key");
			// Every thread belongs to an active temp knight or was closed.
			const open = [...fx.channels.threads.entries()].filter(
				([, thread]) => !thread.archived,
			);
			expect(open.length).toBe(fx.team.helpersOf("coordinator").length);
		});

		test("unnamed creates made at once get distinct names", async () => {
			const results = await asCoordinator((caller) =>
				Promise.all(
					[0, 1, 2].map((i) =>
						fx.team.helperCreate(caller, {
							...SCOUT,
							displayName: `Scout ${i}`,
						}),
					),
				),
			);
			await settle();
			expect(results).toHaveLength(3);
			expect(
				fx.team
					.helpersOf("coordinator")
					.map((helper) => helper.name)
					.sort(),
			).toEqual(["coordinator-1", "coordinator-2", "coordinator-3"]);
		});

		test("a create that fails after its thread exists closes the thread", async () => {
			const real = fx.store.createAgent.bind(fx.store);
			fx.store.createAgent = () => Promise.reject(new Error("write failed"));
			try {
				await expect(
					asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT)),
				).rejects.toThrow("write failed");
			} finally {
				fx.store.createAgent = real;
			}
			expect([...fx.channels.threads.values()].every((t) => t.archived)).toBe(
				true,
			);
			expect(fx.team.helpersOf("coordinator")).toHaveLength(0);
		});

		test("a member cannot pick the model or thinking of a temp knight", async () => {
			await expect(
				inTurn(
					"coordinator",
					(caller) =>
						fx.team.helperCreate(caller, { ...SCOUT, thinking: "low" }),
					MEMBER,
				),
			).rejects.toThrow("higher tier");
			expect(fx.team.helpersOf("coordinator")).toHaveLength(0);
		});

		test("its brief is framed as no owner instruction", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			const prompt = fx.team.systemPrompt(scopeOf("coordinator-1"));
			expect(prompt).toContain("## Your task brief");
			expect(prompt).toContain("not an instruction from");
		});

		test("only the conversation that made it, or an owner, may message it", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			// The parent in another conversation is refused for a member; the same for another knight.
			expect(fx.store.agent("coordinator-1")?.origin).toBe(
				agentChannel("coordinator"),
			);
			await expect(
				inTurn(
					"infra",
					async (caller) => fx.team.message(caller, "coordinator-1", "peek"),
					MEMBER,
				),
			).rejects.toThrow("answers only the conversation that made it");
			// An owner may.
			await inTurn("infra", async (caller) =>
				fx.team.message(caller, "coordinator-1", "peek"),
			);
		});

		test("a restart stamps temp knights marked working as finished", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			await fx.store.setFinished("coordinator-1", false);
			expect(fx.team.finishedHelpers()).toEqual([]);
			await fx.team.start();
			expect(fx.team.finishedHelpers().map((h) => h.name)).toEqual([
				"coordinator-1",
			]);
		});

		test("a group seat is not offered the temp knight tools", () => {
			const options = {
				pluginSelection: () => ({ tools: [], groups: [] }),
				helpers: {},
				agentTools: "full" as const,
			};
			const scope = {
				name: "a",
				session: agentChannel("a"),
				home: agentChannel("a"),
			};
			const solo = teamSelection(options as never, scope).tools;
			const seat = teamSelection(
				options as never,
				{
					...scope,
					group: "g",
				} as never,
			).tools;
			expect(solo).toContain("helper_create");
			expect(seat).not.toContain("helper_create");
			expect(seat).not.toContain("helper_end");
		});
	});
});
