import { beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import {
	describeDb,
	TEST_GUILD,
	testDatabaseUrl,
} from "../testing/database.ts";
import { FakePager } from "../testing/fake-pager-places.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { fx, restart, settle, useTeamFixture } from "./agent-team-fixture.ts";
import { agentRoomKey } from "./team-keys.ts";

/**
 * D2, the write half: the team makes, keeps, brings back and closes its places through the
 * provider of a channel type the core has never heard of, `pager`, whose places are pages with ids
 * of its own, and posts in them through the provider. No branch for it in the core.
 */
const PAGE = (id: string): ChannelKey => `pager:${id}`;
const ROOM = agentRoomKey("app", "coordinator");

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("a channel type whose places the team makes", () => {
	useTeamFixture({ local: true });

	let pager: FakePager;
	// The host starts with the pager installed: the team made no page for anyone before it.
	beforeEach(async () => {
		pager = new FakePager();
		fx.stored.push(pager.provider);
		await restart();
	});

	const pageOf = (kind: "agent" | "group", name: string) =>
		fx.store.places.on(kind, name, "pager");
	const page = (kind: "agent" | "group", name: string) => {
		const id = pageOf(kind, name);
		if (id === undefined) throw new Error(`${name} has no page`);
		return { id, key: PAGE(id) };
	};

	/** Runs `action` during the coordinator's turn in its room, as a tool the model calls. */
	async function inTurn<T>(
		action: (caller: AgentTurnScope) => Promise<T>,
	): Promise<T> {
		let outcome: { value: T } | { error: unknown } | undefined;
		const caller: AgentTurnScope = {
			name: "coordinator",
			session: ROOM,
			home: ROOM,
		};
		fx.runtime.during = async (request) => {
			if (request.agent?.name !== "coordinator") return;
			fx.runtime.during = undefined;
			outcome = await action(caller).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
		};
		await fx.queue.run(ROOM, () =>
			fx.team.answerOwner(ROOM, OWNER_SPEAKER, "go", "go", NO_ATTACHMENTS),
		);
		fx.runtime.during = undefined;
		await settle();
		if (!outcome) throw new Error("no coordinator turn ran the action");
		if ("error" in outcome) throw outcome.error;
		return outcome.value;
	}

	/** Runs `action` during the coordinator's turn in its own page, as a tool the model calls. */
	async function inPageTurn<T>(
		action: (caller: AgentTurnScope) => Promise<T>,
	): Promise<T> {
		const { key } = page("agent", "coordinator");
		const caller: AgentTurnScope = {
			name: "coordinator",
			session: key,
			home: key,
		};
		let outcome: { value: T } | { error: unknown } | undefined;
		fx.runtime.during = async (request) => {
			if (request.agent?.name !== "coordinator") return;
			fx.runtime.during = undefined;
			outcome = await action(caller).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
		};
		await fx.queue.run(key, () =>
			fx.team.answerOwner(key, OWNER_SPEAKER, "go", "go", NO_ATTACHMENTS),
		);
		fx.runtime.during = undefined;
		await settle();
		if (!outcome) throw new Error("no coordinator turn ran the action");
		if ("error" in outcome) throw outcome.error;
		return outcome.value;
	}

	test("start makes a page for every active agent without one, once", async () => {
		const active = fx.store
			.agents()
			.filter((agent) => agent.status === "active")
			.map((agent) => agent.name);
		expect(active.length).toBeGreaterThan(0);
		for (const name of active) {
			const { id, key } = page("agent", name);
			expect(pager.pages.get(id)?.name).toBe(name);
			expect(pager.pages.get(id)?.topic).toBe(
				fx.store.agent(name)?.displayName as string,
			);
			expect(fx.team.owns(key)).toBe("agent");
		}
		const made = pager.pages.size;
		await restart();
		expect(pager.pages.size).toBe(made);
	});

	test("an agent and a group made through the team get a page each, and the answer names it", async () => {
		const said = await inTurn((caller) =>
			fx.team.create(caller, {
				name: "scribe",
				displayName: "Scribe",
				prompt: "Write things down.",
				task: "Say hi.",
			}),
		);
		const scribe = page("agent", "scribe");
		expect(pager.pages.get(scribe.id)?.topic).toBe("Scribe");
		expect(said).toContain(`in page ${scribe.id}`);
		const group = await fx.team.createGroup({
			name: "crew",
			displayName: "Crew",
			members: ["infra", "doctor"],
		});
		const crew = page("group", "crew");
		expect(pager.pages.get(crew.id)?.name).toBe("crew");
		expect(pager.pages.get(crew.id)?.topic).toContain("Doctor");
		expect(group).toContain(`in page ${crew.id}`);
		expect(fx.team.owns(crew.key)).toBe("group");
	});

	test("an agent answers in its page through the provider, interim posts included", async () => {
		const { key } = page("agent", "infra");
		fx.runtime.during = async (request) => {
			fx.runtime.during = undefined;
			await request.interim?.post("on it");
		};
		await fx.queue.run(key, () =>
			fx.team.answerOwner(key, OWNER_SPEAKER, "hi", "hi", NO_ATTACHMENTS),
		);
		expect(pager.seen(key)).toEqual([
			{ author: "Infra", text: "on it" },
			{ author: "Infra", text: "infra ok" },
		]);
		// Not the surface's reply path: no surface serves a page.
		expect(fx.surfaces.texts(key)).toEqual([]);
	});

	test("archive keeps the page through remove, and restore brings the same page back through ensure", async () => {
		const { id } = page("agent", "infra");
		const made = pager.pages.size;
		const said = await fx.team.archive(undefined, "infra");
		expect(said).toBe(`Archived "Infra"; its page ${id} is kept.`);
		expect(pager.pages.get(id)?.archived).toBe(true);
		expect(fx.store.agent("infra")?.status).toBe("archived");
		await fx.team.restore("infra");
		expect(fx.store.agent("infra")?.status).toBe("active");
		expect(pager.pages.get(id)?.archived).toBe(false);
		expect(pageOf("agent", "infra")).toBe(id);
		expect(pager.pages.size).toBe(made);
	});

	test("a group's topic follows its members through describe", async () => {
		await fx.team.createGroup({
			name: "crew",
			displayName: "Crew",
			members: ["infra", "doctor"],
		});
		const { id } = page("group", "crew");
		await fx.team.update("doctor", { displayName: "Healer" });
		await settle();
		expect(pager.pages.get(id)?.topic).toContain("Healer");
	});

	test("a temp knight made from a page gets a page under its parent's, closed when it ends and opened again on restore", async () => {
		await inPageTurn((caller) =>
			fx.team.helperCreate(caller, {
				displayName: "Scout One",
				prompt: "You look one thing up.",
				task: "Look up the first paper.",
			}),
		);
		const helper = page("agent", "coordinator-1");
		expect(pager.pages.get(helper.id)?.parent).toBe(
			page("agent", "coordinator").id,
		);
		expect(pager.pages.get(helper.id)?.topic).toBe("Scout One");
		await fx.team.archiveHelpers(["coordinator-1"], "owner");
		expect(pager.pages.get(helper.id)?.archived).toBe(true);
		const made = pager.pages.size;
		await fx.team.restoreHelpers(["coordinator-1"]);
		expect(fx.store.agent("coordinator-1")?.status).toBe("active");
		expect(pager.pages.get(helper.id)?.archived).toBe(false);
		expect(pageOf("agent", "coordinator-1")).toBe(helper.id);
		expect(pager.pages.size).toBe(made);
	});

	test("a page deleted on the network archives its owner", async () => {
		const { id, key } = page("agent", "infra");
		pager.delete(id);
		await settle();
		expect(fx.store.agent("infra")?.status).toBe("archived");
		expect(fx.team.owns(key)).toBeUndefined();
		await fx.team.createGroup({
			name: "crew",
			displayName: "Crew",
			members: ["doctor", "coordinator"],
		});
		const crew = page("group", "crew");
		pager.delete(crew.id);
		await settle();
		expect(fx.store.group("crew")?.status).toBe("archived");
	});

	test("a page that is gone at start archives its owner", async () => {
		const { id } = page("agent", "infra");
		pager.pages.delete(id);
		await restart();
		expect(fx.store.agent("infra")?.status).toBe("archived");
		expect(fx.store.agent("doctor")?.status).toBe("active");
	});

	test("a page of another network at start is dropped, and a new page is made, with no archive", async () => {
		const { id } = page("agent", "infra");
		const sql = new SQL(testDatabaseUrl);
		try {
			await sql`
				UPDATE agent_places SET external_id = 'other-1'
				WHERE team_id = ${TEST_GUILD} AND kind = 'agent' AND name = 'infra' AND surface = 'pager'`;
		} finally {
			await sql.close();
		}
		await fx.store.places.reload();
		expect(pageOf("agent", "infra")).toBe("other-1");
		await restart();
		expect(fx.store.agent("infra")?.status).toBe("active");
		const made = page("agent", "infra");
		expect(made.id).not.toBe("other-1");
		expect(made.id).not.toBe(id);
		expect(pager.pages.get(made.id)?.name).toBe("infra");
		expect(fx.team.owns(PAGE("other-1"))).toBeUndefined();
		expect(fx.team.owns(made.key)).toBe("agent");
	});

	test("deleting an archived agent forgets its page row", async () => {
		await fx.team.createAgent(OWNER_SPEAKER, {
			name: "scribe",
			displayName: "Scribe",
			prompt: "Write things down.",
		});
		expect(pageOf("agent", "scribe")).toBeDefined();
		await fx.team.archive(undefined, "scribe");
		await fx.team.remove("scribe");
		expect(pageOf("agent", "scribe")).toBeUndefined();
	});
});
