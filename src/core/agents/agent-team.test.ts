import { describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import {
	agentChannel,
	duringTurn,
	ENTRY,
	eventLog,
	fx,
	script,
	settle,
	useTeamFixture,
} from "./agent-team-fixture.ts";
import { discordKey } from "./team-keys.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	useTeamFixture();

	describe("startup", () => {
		test("seeds the team, gives each agent a channel, and draws avatars", () => {
			expect(fx.store.agent("coordinator")?.channelId).toBe(ENTRY);
			expect(fx.channels.created).toEqual(["doctor", "infra"]);
			expect(fx.store.agent("infra")?.avatarHash).toBe("a".repeat(64));
		});

		test("agent turns have the plugins' tools, the shell, and the agent tools", () => {
			const selection = fx.team.selection();
			expect(selection.id).toBe("agent");
			expect(selection.tools).toContain("bash");
			expect(selection.tools).toContain("message_agent");
			expect(selection.tools).toContain("memory_add");
			expect(selection.groups).toEqual(["workspace"]);
		});

		test("a group seat has the agent tools but not message_agent, which it cannot register", () => {
			const seat = {
				name: "infra",
				session: discordKey("discord:group:1"),
				home: discordKey(ENTRY),
				group: "crew",
			};
			const tools = fx.team.selection(seat).tools;
			expect(tools).toContain("agent_list");
			expect(tools).not.toContain("message_agent");
		});
	});

	describe("skills", () => {
		const coordinator = {
			name: "coordinator",
			session: discordKey(ENTRY),
			home: discordKey(ENTRY),
		};
		const notes = (skillNames: string[]) =>
			duringTurn(() =>
				fx.team.create(coordinator, {
					name: "notes",
					displayName: "Notes",
					prompt: "Keep notes.",
					avatarPrompt: "A scribe.",
					task: "Say hi.",
					skills: skillNames,
				}),
			);

		test("a new agent carries the chosen skills, shown by agent_get", async () => {
			await notes(["kit-do"]);
			await settle();
			expect(fx.team.get("notes")).toContain(
				"Skills: writing-skills (built in), kit-do",
			);
			expect(fx.team.skillsOf("notes").map((s) => s.name)).toEqual([
				"writing-skills",
				"kit-do",
			]);
		});

		test("an unknown skill refuses creation before a channel is made", async () => {
			const before = fx.channels.created.length;
			await expect(notes(["nope"])).rejects.toThrow(/Unknown skills: nope/);
			expect(fx.channels.created.length).toBe(before);
			expect(fx.store.agent("notes")).toBeUndefined();
		});

		test("an agent without chosen skills carries the built-in one", () => {
			expect(fx.team.get("infra")).toContain(
				"Skills: writing-skills (built in)",
			);
			expect(fx.team.skillsOf("infra").map((s) => s.name)).toEqual([
				"writing-skills",
			]);
		});
	});

	describe("agent channels", () => {
		test("the owner's message is answered by the channel's agent under its name", async () => {
			const infra = agentChannel("infra");
			await fx.team.answerOwner(
				infra,
				OWNER_SPEAKER,
				"disk?",
				"disk?",
				NO_ATTACHMENTS,
			);
			expect(fx.runtime.turns[0]?.agent).toEqual({
				name: "infra",
				session: infra,
				home: infra,
			});
			expect(fx.channels.posts.at(-1)?.post.name).toBe("Infra");
			expect(fx.channels.posts.at(-1)?.post.avatarUrl).toContain("/avatars/");
		});

		test("a confirming reply approves the agent's held actions", async () => {
			const infra = agentChannel("infra");
			fx.runtime.held.set(infra, {
				selectionId: "agent",
				heldAt: new Date(),
				calls: [{ tool: "bash", input: "{}", action: "restart" }],
			});
			await fx.team.answerOwner(
				infra,
				OWNER_SPEAKER,
				"yes",
				"yes",
				NO_ATTACHMENTS,
			);
			expect(fx.runtime.turns[0]?.confirmed).toBe(true);
		});

		test("the system prompt carries the agent's current prompt", async () => {
			await fx.store.updateAgent("infra", { prompt: "Be terse." });
			const prompt = fx.team.systemPrompt({
				name: "infra",
				session: agentChannel("infra"),
				home: agentChannel("infra"),
			});
			expect(prompt.startsWith("Shared rules.")).toBe(true);
			expect(prompt).toContain("Be terse.");
			expect(prompt).toContain("message_agent");
		});

		test("a plugin's prompt sections follow the agent's prompt, and its tools join the agent's selection", () => {
			script.prompt = [
				{ name: "rules", build: (turn) => `Rules for ${turn.agent.name}.` },
				{ name: "silent", build: () => undefined },
			];
			script.tools = ["note_add"];
			const prompt = fx.team.systemPrompt({
				name: "infra",
				session: agentChannel("infra"),
				home: agentChannel("infra"),
			});
			expect(prompt.endsWith("\n\nRules for infra.")).toBe(true);
			expect(fx.team.selection().tools).toContain("note_add");
		});

		test("the team reports each turn's start and end, and a change of the team", async () => {
			fx.runtime.stopNext = false;
			await fx.team.answerOwner(
				agentChannel("infra"),
				OWNER_SPEAKER,
				"hi",
				"hi",
				NO_ATTACHMENTS,
			);
			expect(eventLog.filter((e) => e.startsWith("turn"))).toEqual([
				"turnStarted infra",
				"turnEnded infra ok",
			]);
			eventLog.length = 0;
			fx.runtime.stopNext = true;
			await fx.team.answerOwner(
				agentChannel("infra"),
				OWNER_SPEAKER,
				"again",
				"again",
				NO_ATTACHMENTS,
			);
			expect(eventLog).toContain("turnEnded infra stopped");
			eventLog.length = 0;
			await fx.team.update("infra", { displayName: "Infra 2" });
			expect(eventLog).toEqual(["changed"]);
		});

		test("a specialist's prompt names the coordinator; the coordinator's names itself", () => {
			const prompt = (name: string) =>
				fx.team.systemPrompt({
					name,
					session: agentChannel(name),
					home: agentChannel(name),
				});
			const infra = prompt("infra");
			expect(infra).toContain(
				`The team's coordinator is "Coordinator" (\`coordinator\`) in <#${ENTRY}>.`,
			);
			expect(infra).toContain(
				'speak of yourself only as "Infra", never as the coordinator',
			);
			const coordinator = prompt("coordinator");
			expect(coordinator).toContain("You are the team's coordinator");
			expect(coordinator).not.toContain("You are a specialist");
		});
	});

	describe("model settings", () => {
		test("an agent follows the assistant's model until set, and returns with default", async () => {
			expect(fx.team.modelOf("infra")).toEqual({
				model: "claude-bridge/claude-opus-5-5",
				thinking: "medium",
			});
			const answer = await fx.team.update("infra", {
				model: "openai-codex/gpt-6-sol",
				thinking: "high",
			});
			expect(answer).toContain(
				"runs openai-codex/gpt-6-sol with thinking high",
			);
			expect(fx.team.modelOf("infra")).toEqual({
				model: "openai-codex/gpt-6-sol",
				thinking: "high",
			});
			expect(fx.team.get("infra")).toContain("Model: openai-codex/gpt-6-sol");
			await fx.team.update("infra", { model: "default", thinking: "default" });
			expect(fx.team.modelOf("infra").model).toBe(
				"claude-bridge/claude-opus-5-5",
			);
			expect(fx.team.get("infra")).toContain("Model: Roundtable's");
		});

		test("a model the host cannot run is refused with the usable list", async () => {
			await expect(
				fx.team.update("doctor", { model: "openai-codex/gpt-9" }),
			).rejects.toThrow(
				/Usable models: claude-bridge\/claude-opus-5-5, openai-codex\/gpt-6-sol/,
			);
			expect(fx.store.agent("doctor")?.model).toBeUndefined();
		});

		test("the usable list puts the current model first", async () => {
			expect(await fx.team.usableModels("openai-codex/gpt-6-sol")).toEqual([
				"openai-codex/gpt-6-sol",
				"claude-bridge/claude-opus-5-5",
			]);
		});
	});

	describe("message_agent", () => {
		test("delivers, answers in both channels, and wakes the sender", async () => {
			const coordinator = discordKey(ENTRY);
			const infra = agentChannel("infra");
			fx.runtime.during = (request) => {
				if (
					request.agent?.name === "coordinator" &&
					fx.runtime.turns.length === 1
				)
					fx.team.message(request.agent, "infra", "check the disk");
			};
			fx.runtime.reply = (r) =>
				r.agent?.name === "infra" ? "disk 40%" : "asked infra";
			await fx.team.answerOwner(
				coordinator,
				OWNER_SPEAKER,
				"check disk",
				"check disk",
				NO_ATTACHMENTS,
			);
			await settle();
			expect(fx.runtime.turns.map((t) => t.agent?.name)).toEqual([
				"coordinator",
				"infra",
				"coordinator",
			]);
			expect(fx.runtime.turns[1]?.text).toContain("check the disk");
			expect(fx.runtime.turns[2]?.text).toContain("disk 40%");
			expect(fx.channels.texts(infra.slice(8))).toEqual([
				"Coordinator: 📨 To **Infra**:\ncheck the disk",
				"Infra: disk 40%",
			]);
			expect(fx.channels.texts(ENTRY)).toEqual([
				"Coordinator: asked infra",
				"Infra: ↩️ Reply:\ndisk 40%",
				"Coordinator: asked infra",
			]);
		});

		test("refuses itself and unknown agents", async () => {
			const scope = {
				name: "infra",
				session: agentChannel("infra"),
				home: agentChannel("infra"),
			};
			expect(() => fx.team.message(scope, "infra", "x")).toThrow(/yourself/);
			expect(() => fx.team.message(scope, "nobody", "x")).toThrow(
				/Active agents/,
			);
		});

		test("a chain stops after 8 agent messages", async () => {
			let refused = "";
			fx.runtime.during = (request) => {
				const to = request.agent?.name === "infra" ? "doctor" : "infra";
				try {
					if (request.agent) fx.team.message(request.agent, to, "continue");
				} catch (error) {
					refused = String(error);
				}
			};
			await fx.team.answerOwner(
				agentChannel("infra"),
				OWNER_SPEAKER,
				"go talk",
				"go talk",
				NO_ATTACHMENTS,
			);
			for (let i = 0; i < 20; i++) await settle();
			expect(refused).toContain("8 messages");
			const agentTurns = fx.runtime.turns.filter((t) =>
				t.text.startsWith("(Message from"),
			);
			expect(agentTurns).toHaveLength(8);
		});

		test("messages fanned out from one turn share the chain's count", async () => {
			const sent: string[] = [];
			let refused = "";
			fx.runtime.during = (request) => {
				if (request.agent?.name !== "coordinator") return;
				for (let i = 0; i < 9; i++) {
					try {
						fx.team.message(
							request.agent,
							i % 2 ? "infra" : "doctor",
							`task ${i}`,
						);
						sent.push(String(i));
					} catch (error) {
						refused = String(error);
					}
				}
			};
			await fx.team.answerOwner(
				agentChannel("coordinator"),
				OWNER_SPEAKER,
				"assign",
				"assign",
				NO_ATTACHMENTS,
			);
			expect(sent).toHaveLength(8);
			expect(refused).toContain("8 messages");
		});

		test("a message outside an agent turn is refused", () => {
			const scope = {
				name: "infra",
				session: agentChannel("infra"),
				home: agentChannel("infra"),
			};
			expect(() => fx.team.message(scope, "doctor", "x")).toThrow(
				/during an agent turn/,
			);
		});
	});
});
