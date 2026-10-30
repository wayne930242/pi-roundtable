import { describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { Speaker } from "../speakers.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import {
	agentChannel,
	fx,
	script,
	settle,
	useTeamFixture,
} from "./agent-team-fixture.ts";
import {
	asCoordinator,
	inTurn,
	SCOUT,
	scopeOf,
	turnsOf,
	writeTo,
} from "./helper-test-kit.ts";
import { agentRoomKey, discordKey } from "./team-keys.ts";
import { teamSelection } from "./team-selection.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("temp knights (Discord)", () => {
	useTeamFixture();

	describe("helper_create", () => {
		test("makes a real agent under the parent, in a thread of its channel, and its answer returns to the parent", async () => {
			const said = await asCoordinator((caller) =>
				fx.team.helperCreate(caller, SCOUT),
			);
			await settle();
			expect(said).toContain('Created "Scout One" (coordinator-1)');
			expect(said).toContain("will answer here");
			const helper = fx.store.agent("coordinator-1");
			expect(helper).toMatchObject({
				displayName: "Scout One",
				parent: "coordinator",
				status: "active",
			});
			// A thread under the parent's channel, not a channel of its own.
			expect(fx.channels.created).not.toContain("coordinator-1");
			const thread = fx.channels.threads.get(helper?.channelId ?? "");
			expect(thread).toEqual({
				parent: "1000",
				name: "Scout One",
				archived: false,
			});
			// The task ran in its place, as a message from the parent.
			const ran = turnsOf("coordinator-1");
			expect(ran).toHaveLength(1);
			expect(ran[0]?.text).toContain("Look up the first paper.");
			expect(ran[0]?.text).toContain("Message from the agent");
			expect(ran[0]?.channel).toBe(discordKey(helper?.channelId ?? ""));
			// Its answer woke the parent in the conversation the task came from.
			const back = turnsOf("coordinator").find((turn) =>
				turn.text.includes("answered your message"),
			);
			expect(back?.channel).toBe(agentChannel("coordinator"));
			expect(back?.text).toContain("coordinator-1 ok");
		});

		test("runs the parent's model and thinking unless given its own", async () => {
			await fx.team.update("coordinator", {
				model: "openai-codex/gpt-6-sol",
				thinking: "high",
			});
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await asCoordinator((caller) =>
				fx.team.helperCreate(caller, {
					...SCOUT,
					displayName: "Scout Two",
					model: "claude-bridge/claude-opus-5-5",
					thinking: "low",
				}),
			);
			await settle();
			expect(fx.store.agent("coordinator-1")).toMatchObject({
				model: "openai-codex/gpt-6-sol",
				thinking: "high",
			});
			expect(fx.store.agent("coordinator-2")).toMatchObject({
				model: "claude-bridge/claude-opus-5-5",
				thinking: "low",
			});
		});

		test("takes the next free number for its name, or the name it is given", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await asCoordinator((caller) =>
				fx.team.helperCreate(caller, { ...SCOUT, name: "papers" }),
			);
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			expect(
				fx.store
					.agents()
					.filter((a) => a.parent)
					.map((a) => a.name)
					.sort(),
			).toEqual(["coordinator-1", "coordinator-2", "papers"]);
		});

		test("a temp knight cannot make temp knights, and the tools are not offered to its turns", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			const caller = scopeOf("coordinator");
			const helper = fx.store.agent("coordinator-1");
			const asHelper: AgentTurnScope = {
				name: "coordinator-1",
				session: discordKey(helper?.channelId ?? ""),
				home: discordKey(helper?.channelId ?? ""),
			};
			script.tools = ["schedule_create"];
			const own = fx.team.selection(asHelper).tools;
			const parent = fx.team.selection(caller).tools;
			for (const tool of [
				"agent_create",
				"helper_create",
				"helper_end",
				"group_create",
				"group_update",
				"archive",
				"channel_arrange",
				"schedule_create",
			]) {
				expect(parent).toContain(tool);
				expect(own).not.toContain(tool);
			}
			// What a temp knight keeps: reading, messaging, its own look.
			expect(own).toEqual(
				expect.arrayContaining(["agent_list", "message_agent", "agent_avatar"]),
			);
			// A call that gets through anyway is refused by the team, not only by the tool list.
			await expect(
				inTurn("coordinator-1", (own) => fx.team.helperCreate(own, SCOUT)),
			).rejects.toBeInstanceOf(AgentError);
			expect(asHelper.name).toBe("coordinator-1");
		});

		test("refuses outside a turn and when the host switched temp knights off", async () => {
			await expect(
				fx.team.helperCreate(scopeOf("coordinator"), SCOUT),
			).rejects.toThrow("only be used during an agent turn");
		});

		test("an unusable model is refused before anything is made", async () => {
			await expect(
				asCoordinator((caller) =>
					fx.team.helperCreate(caller, { ...SCOUT, model: "nobody/nothing" }),
				),
			).rejects.toThrow("cannot run");
			expect(fx.store.agents().filter((a) => a.parent)).toEqual([]);
			expect(fx.channels.threads.size).toBe(0);
		});

		test("a task that cannot be handed over leaves no idle temp knight behind", async () => {
			await expect(
				asCoordinator(async (caller) => {
					// The chain is at its cap of 8 messages.
					for (let i = 0; i < 8; i += 1)
						fx.team.message(caller, "doctor", `ping ${i}`);
					return fx.team.helperCreate(caller, SCOUT);
				}),
			).rejects.toThrow("8 messages");
			expect(fx.store.agent("coordinator-1")?.status).toBe("archived");
		});
	});

	describe("working and finished", () => {
		test("a temp knight is finished once its task is answered, and works again when it is written to", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			const first = fx.store.agent("coordinator-1")?.finishedAt;
			expect(first).toBeInstanceOf(Date);
			expect(fx.team.finishedHelpers().map((a) => a.name)).toEqual([
				"coordinator-1",
			]);
			// The owner writes to it: a running turn clears the stamp, and its end sets it again.
			let during: Date | undefined | "unset" = "unset";
			fx.runtime.during = async () => {
				const deadline = Date.now() + 2_000;
				while (
					fx.store.agent("coordinator-1")?.finishedAt &&
					Date.now() < deadline
				)
					await Bun.sleep(5);
				during = fx.store.agent("coordinator-1")?.finishedAt;
			};
			await writeTo("coordinator-1", "one more");
			fx.runtime.during = undefined;
			await settle();
			expect(during).toBeUndefined();
			expect(fx.store.agent("coordinator-1")?.finishedAt).toBeInstanceOf(Date);
		});

		test("an action held for the owner keeps it working", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			const helper = fx.store.agent("coordinator-1");
			const session = discordKey(helper?.channelId ?? "");
			fx.runtime.held.set(session, {
				calls: [],
				speakerId: "1",
			} as never);
			await writeTo("coordinator-1", "deploy");
			await settle();
			expect(fx.store.agent("coordinator-1")?.finishedAt).toBeUndefined();
			fx.runtime.held.delete(session);
			await writeTo("coordinator-1", "done");
			await settle();
			expect(fx.store.agent("coordinator-1")?.finishedAt).toBeInstanceOf(Date);
		});

		test("a permanent knight is never stamped", async () => {
			await writeTo("doctor", "hi");
			await settle();
			expect(fx.store.agent("doctor")?.finishedAt).toBeUndefined();
			expect(fx.team.finishedHelpers()).toEqual([]);
		});

		test("the change signal fires when a temp knight finishes, so the pages redraw", async () => {
			let changes = 0;
			fx.team.onChange(() => {
				changes += 1;
			});
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			expect(changes).toBeGreaterThan(0);
		});
	});

	describe("caps", () => {
		test("at the parent's cap its oldest finished temp knight is archived to make room", async () => {
			const names: string[] = [];
			for (let i = 0; i < 4; i += 1) {
				await asCoordinator((caller) =>
					fx.team.helperCreate(caller, { ...SCOUT, displayName: `Scout ${i}` }),
				);
				await settle();
				names.push(`coordinator-${i + 1}`);
			}
			expect(fx.team.helpersOf("coordinator")).toHaveLength(4);
			const said = await asCoordinator((caller) =>
				fx.team.helperCreate(caller, { ...SCOUT, displayName: "Scout 4" }),
			);
			await settle();
			expect(said).toContain("oldest finished temp knight");
			expect(said).toContain("coordinator-1");
			expect(fx.store.agent("coordinator-1")?.status).toBe("archived");
			expect(fx.team.helpersOf("coordinator")).toHaveLength(4);
			// Its thread was closed.
			expect(
				fx.channels.threads.get(
					fx.store.agent("coordinator-1")?.channelId ?? "",
				)?.archived,
			).toBe(true);
		});

		test("it refuses only when every one is still working", async () => {
			for (let i = 0; i < 4; i += 1)
				await asCoordinator((caller) =>
					fx.team.helperCreate(caller, { ...SCOUT, displayName: `Scout ${i}` }),
				);
			// Each now has an action held for the owner, so none is finished.
			for (const helper of fx.team.helpersOf("coordinator")) {
				fx.runtime.held.set(discordKey(helper.channelId ?? ""), {
					calls: [],
					speakerId: "1",
				} as never);
				await writeTo(helper.name, "deploy");
			}
			await settle();
			expect(fx.team.finishedHelpers()).toEqual([]);
			await expect(
				asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT)),
			).rejects.toThrow("still working");
			expect(fx.team.helpersOf("coordinator")).toHaveLength(4);
		});
	});

	describe("archive, restore and delete", () => {
		const make = async (count: number) => {
			for (let i = 0; i < count; i += 1) {
				await asCoordinator((caller) =>
					fx.team.helperCreate(caller, { ...SCOUT, displayName: `Scout ${i}` }),
				);
				await settle();
			}
		};

		test("helper_end archives the caller's own temp knights, by name or every finished one", async () => {
			await make(3);
			const ended: { parent: string; names: string[] }[] = [];
			fx.team.onHelpersEnded((event) => ended.push(event));
			const some = await asCoordinator((caller) =>
				fx.team.helperEnd(caller, ["coordinator-1"]),
			);
			expect(some).toContain("coordinator-1");
			expect(fx.store.agent("coordinator-1")?.status).toBe("archived");
			const rest = await asCoordinator((caller) =>
				fx.team.helperEnd(caller, "finished"),
			);
			expect(rest).toContain("2 temp knights");
			expect(fx.team.helpersOf("coordinator")).toEqual([]);
			expect(ended).toEqual([
				{ parent: "coordinator", names: ["coordinator-1"] },
				{ parent: "coordinator", names: ["coordinator-2", "coordinator-3"] },
			]);
			// History stays: the rows are archived, not deleted.
			expect(fx.store.agent("coordinator-2")?.status).toBe("archived");
		});

		test("helper_end refuses another knight's temp knight and says whose are yours", async () => {
			await make(1);
			await expect(
				inTurn("doctor", (caller) =>
					fx.team.helperEnd(caller, ["coordinator-1"]),
				),
			).rejects.toThrow("not one of your temp knights");
			expect(fx.store.agent("coordinator-1")?.status).toBe("active");
		});

		test("helper_end 'finished' with none finished archives nothing", async () => {
			expect(
				await fx.team.helperEnd(scopeOf("coordinator"), "finished"),
			).toContain("None of your temp knights is finished");
		});

		test("a parent that is archived takes its active temp knights with it, and deleting it deletes them", async () => {
			// The coordinator cannot be archived, and a seeded knight cannot be deleted: use a made one.
			await fx.team.createAgent(OWNER_SPEAKER, {
				name: "notes",
				displayName: "Notes",
				prompt: "Keep notes.",
			});
			await inTurn("notes", async (caller) => {
				await fx.team.helperCreate(caller, SCOUT);
				await fx.team.helperCreate(caller, {
					...SCOUT,
					displayName: "Scout B",
				});
			});
			expect(fx.team.helpersOf("notes")).toHaveLength(2);
			await fx.team.archive(undefined, "notes");
			expect(fx.store.helpersOf("notes").map((a) => a.status)).toEqual([
				"archived",
				"archived",
			]);
			for (const helper of fx.store.helpersOf("notes"))
				expect(fx.channels.threads.get(helper.channelId ?? "")?.archived).toBe(
					true,
				);
			// Restoring the parent leaves them archived; each is restored by hand.
			await fx.team.restore("notes");
			expect(fx.team.helpersOf("notes")).toEqual([]);
			expect(await fx.team.restoreHelpers(["notes-1"])).toEqual(["notes-1"]);
			expect(fx.store.agent("notes-1")?.status).toBe("active");
			// A temp knight is not restored under a parent that is archived.
			await fx.team.archive(undefined, "notes");
			expect(await fx.team.restoreHelpers(["notes-1"])).toEqual([]);
			await fx.team.remove("notes");
			expect(fx.store.helpersOf("notes")).toEqual([]);
			expect(fx.store.agent("notes-1")).toBeUndefined();
			expect(fx.store.agent("notes-2")).toBeUndefined();
		});

		test("restoring brings back exactly the archived temp knights asked for, with their thread open", async () => {
			await make(2);
			const closed = fx.store.agent("coordinator-1")?.channelId ?? "";
			await fx.team.archiveHelpers(["coordinator-1", "coordinator-2"], "owner");
			expect(fx.channels.threads.get(closed)?.archived).toBe(true);
			const restored = await fx.team.restoreHelpers([
				"coordinator-1",
				// Still active after the first restore, never a temp knight, and unknown: all passed over.
				"coordinator-1",
				"doctor",
				"nobody",
			]);
			expect(restored).toEqual(["coordinator-1"]);
			expect(fx.channels.threads.get(closed)?.archived).toBe(false);
			expect(fx.store.agent("coordinator-1")?.status).toBe("active");
			expect(fx.store.agent("coordinator-2")?.status).toBe("archived");
			// It comes back finished: nothing runs in it.
			expect(fx.store.agent("coordinator-1")?.finishedAt).toBeInstanceOf(Date);
		});

		test("a thread deleted meanwhile is made again on restore", async () => {
			await make(1);
			const old = fx.store.agent("coordinator-1")?.channelId ?? "";
			await fx.team.archiveHelpers(["coordinator-1"], "owner");
			fx.channels.deleted.add(old);
			await fx.team.restoreHelpers(["coordinator-1"]);
			const fresh = fx.store.agent("coordinator-1")?.channelId;
			expect(fresh).toBeDefined();
			expect(fresh).not.toBe(old);
			expect(fx.channels.threads.get(fresh ?? "")?.parent).toBe("1000");
		});

		test("archiving through the agent archive tool treats a temp knight the same way", async () => {
			await make(1);
			const channel = fx.store.agent("coordinator-1")?.channelId ?? "";
			const said = await fx.team.archive(undefined, "coordinator-1");
			expect(said).toContain("Archived");
			expect(fx.channels.threads.get(channel)?.archived).toBe(true);
			// No webhook removal or move under Archive: the thread shares its parent's.
			expect(fx.channels.webhooksRemoved).toEqual([]);
			expect(fx.channels.categoryOf(channel)).toBeUndefined();
			expect(await fx.team.restore("coordinator-1")).toContain("Restored");
		});

		test("the owner deleting a temp knight's thread archives it, like a deleted channel", async () => {
			await make(1);
			const channel = fx.store.agent("coordinator-1")?.channelId ?? "";
			await fx.team.channelDeleted(channel);
			expect(fx.store.agent("coordinator-1")?.status).toBe("archived");
		});
	});

	describe("groups and the list", () => {
		test("a group takes no temp knight, at creation or when a member is added", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			await expect(
				fx.team.createGroup({
					name: "desk",
					displayName: "Desk",
					members: ["coordinator", "coordinator-1"],
				}),
			).rejects.toThrow("temp knight");
			await fx.team.createGroup({
				name: "desk",
				displayName: "Desk",
				members: ["coordinator", "doctor"],
			});
			await expect(
				fx.team.updateGroup("desk", {
					members: ["coordinator", "doctor", "coordinator-1"],
				}),
			).rejects.toThrow("temp knight");
		});

		test("agent_list shows a temp knight under its parent with its state", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			const list = await fx.team.list();
			expect(list).toMatch(
				/- coordinator "Coordinator"[^\n]*\n {2}- coordinator-1 \(temp, of coordinator, finished\) "Scout One"/,
			);
			expect(fx.team.get("coordinator-1")).toContain(
				"Temp knight of: coordinator (finished)",
			);
		});

		test("the status counts a temp knight apart from the permanent ones", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			const status = await fx.team.status();
			expect(
				status.agents.find((a) => a.name === "coordinator-1"),
			).toMatchObject({ parent: "coordinator", finished: true });
			expect(
				status.agents.find((a) => a.name === "coordinator")?.parent,
			).toBeUndefined();
		});

		test("a temp knight's prompt names its parent, and the parent's names the tools", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			const helper = fx.store.agent("coordinator-1");
			const own = fx.team.systemPrompt({
				name: "coordinator-1",
				session: discordKey(helper?.channelId ?? ""),
				home: discordKey(helper?.channelId ?? ""),
			});
			expect(own).toContain('temp knight of "Coordinator"');
			expect(own).not.toContain("helper_create makes");
			const parent = fx.team.systemPrompt(scopeOf("coordinator"));
			expect(parent).toContain("helper_create makes one of yours");
		});
	});

	describe("finished temp knights past their keep", () => {
		test("are archived by the sweep, through the same path, and the rest stay", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await asCoordinator((caller) =>
				fx.team.helperCreate(caller, { ...SCOUT, displayName: "Scout Two" }),
			);
			await settle();
			const [first] = fx.store.helpersOf("coordinator");
			const soon = new Date(Date.now() + 23 * 3_600_000);
			const late = new Date(Date.now() + 25 * 3_600_000);
			expect(await fx.team.sweepFinished(soon)).toEqual([]);
			expect(await fx.team.sweepFinished(late)).toEqual([
				"coordinator-1",
				"coordinator-2",
			]);
			expect(fx.store.agent(first?.name ?? "")?.status).toBe("archived");
			expect(fx.team.helpersOf("coordinator")).toEqual([]);
		});
	});
});

describeDb("temp knights with the sweep off or the tools off", () => {
	describe("archiveFinishedAfterHours false", () => {
		useTeamFixture({
			helpers: { perParent: 4, perHost: 12, archiveFinishedAfterHours: false },
		});
		test("a finished temp knight is kept", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await settle();
			expect(
				await fx.team.sweepFinished(new Date(Date.now() + 1_000 * 3_600_000)),
			).toEqual([]);
		});
	});

	describe("helpers false", () => {
		useTeamFixture({ helpers: false });
		test("the tools are not offered and the prompt does not mention them", async () => {
			const tools = fx.team.selection(scopeOf("coordinator")).tools;
			expect(tools).not.toContain("helper_create");
			expect(tools).not.toContain("helper_end");
			expect(tools).toContain("agent_create");
			expect(fx.team.systemPrompt(scopeOf("coordinator"))).not.toContain(
				"helper_create",
			);
			await expect(
				asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT)),
			).rejects.toThrow("switched off");
		});
	});

	describe("a team with a per-host cap of 2", () => {
		useTeamFixture({
			helpers: { perParent: 2, perHost: 2, archiveFinishedAfterHours: 24 },
		});
		test("the cap holds across parents, and a parent with none finished of its own is refused", async () => {
			await asCoordinator((caller) => fx.team.helperCreate(caller, SCOUT));
			await asCoordinator((caller) =>
				fx.team.helperCreate(caller, { ...SCOUT, displayName: "Two" }),
			);
			// The doctor has none of its own to archive, so the host's full house refuses it.
			await expect(
				inTurn("doctor", (caller) => fx.team.helperCreate(caller, SCOUT)),
			).rejects.toThrow("temp knights are all in use");
			expect(fx.team.helpersOf("coordinator")).toHaveLength(2);
			expect(fx.team.helpersOf("doctor")).toEqual([]);
		});
	});
});

describeDb("temp knights on a host without Discord", () => {
	useTeamFixture({ local: true });

	test("lives in rooms only: no thread, and the task runs in its room on the surface that asked", async () => {
		const caller: AgentTurnScope = {
			name: "coordinator",
			session: agentRoomKey("app", "coordinator"),
			home: agentRoomKey("app", "coordinator"),
		};
		await fx.team.answerOwner(
			agentRoomKey("app", "coordinator"),
			OWNER_SPEAKER,
			"go",
			"go",
			NO_ATTACHMENTS,
		);
		fx.runtime.during = async () => {
			fx.runtime.during = undefined;
			await fx.team.helperCreate(caller, SCOUT);
		};
		await fx.team.answerOwner(
			agentRoomKey("app", "coordinator"),
			OWNER_SPEAKER,
			"go",
			"go",
			NO_ATTACHMENTS,
		);
		await settle();
		const helper = fx.store.agent("coordinator-1");
		expect(helper?.parent).toBe("coordinator");
		expect(helper?.channelId).toBeUndefined();
		const ran = fx.runtime.turns.find((t) => t.agent?.name === "coordinator-1");
		expect(ran?.channel).toBe(agentRoomKey("app", "coordinator-1"));
		// Its answer returns to the parent's room.
		expect(
			fx.runtime.turns.some(
				(t) =>
					t.agent?.name === "coordinator" &&
					t.channel === agentRoomKey("app", "coordinator") &&
					t.text.includes("answered your message"),
			),
		).toBe(true);
		// Archive and restore need no thread.
		await fx.team.archiveHelpers(["coordinator-1"], "owner");
		expect(await fx.team.restoreHelpers(["coordinator-1"])).toEqual([
			"coordinator-1",
		]);
	});
});
