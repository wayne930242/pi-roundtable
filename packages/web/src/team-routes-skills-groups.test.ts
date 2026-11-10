import { describe, expect, test } from "bun:test";
import type {
	AgentSkillsView,
	ArchiveView,
	GroupProfileView,
} from "./api-types.ts";

import {
	actAs,
	call,
	calls,
	carried,
	changes,
	groups,
	lastMessages,
	refusesTheSame,
	setup,
	teamHostPerTest,
} from "./testing/team-routes-host.ts";

teamHostPerTest();

describe("agent skills", () => {
	refusesTheSame(
		"change",
		{ method: "PUT", path: "agents/scout/skills", body: { add: ["kit-do"] } },
		"agents/nobody/skills",
	);

	test("lists the host's skills with what the agent carries; built-in skills are always carried", async () => {
		carried.set("scout", ["kit-do"]);
		const response = await call(setup(), "GET", "agents/scout/skills");
		expect(response.status).toBe(200);
		const view = (await response.json()) as AgentSkillsView;
		expect(view.skills).toEqual([
			{
				name: "writing-skills",
				description: "Use when writing a skill.",
				source: "builtin",
				builtin: true,
				carried: true,
			},
			{
				name: "kit-do",
				description: "Use when changing source.",
				source: "linked",
				builtin: false,
				carried: true,
			},
			{
				name: "broken",
				source: "written",
				builtin: false,
				carried: false,
				missing: "file not found",
			},
		]);
		// Another agent carries none of the registered ones.
		const other = (await (
			await call(setup(), "GET", "agents/infra/skills")
		).json()) as AgentSkillsView;
		expect(other.skills.map((skill) => skill.carried)).toEqual([
			true,
			false,
			false,
		]);
	});

	test("a member may not read them, and an unknown or archived agent is a 404", async () => {
		const server = setup();
		actAs({ id: "member", tier: "member" });
		expect((await call(server, "GET", "agents/scout/skills")).status).toBe(403);
		actAs({ id: "owner", tier: "owner" });
		expect((await call(server, "GET", "agents/nobody/skills")).status).toBe(
			404,
		);
		expect((await call(server, "GET", "agents/old/skills")).status).toBe(404);
	});

	test("adds and removes in one change and answers the list again", async () => {
		carried.set("scout", ["kit-do"]);
		const server = setup();
		const response = await call(server, "PUT", "agents/scout/skills", {
			body: { remove: ["kit-do"] },
		});
		expect(response.status).toBe(200);
		const view = (await response.json()) as AgentSkillsView;
		expect(view.skills.find((skill) => skill.name === "kit-do")?.carried).toBe(
			false,
		);
		await call(server, "PUT", "agents/scout/skills", {
			body: { add: ["kit-do"], remove: [] },
		});
		expect(calls).toEqual(["attach scout + -kit-do", "attach scout +kit-do -"]);
		expect(changes).toBe(2);
	});

	test("an unknown or built-in name refuses the whole change with 400", async () => {
		const server = setup();
		for (const body of [
			{ add: ["kit-do", "nope"] },
			{ remove: ["writing-skills"] },
		]) {
			const response = await call(server, "PUT", "agents/scout/skills", {
				body,
			});
			expect(response.status).toBe(400);
		}
		expect(carried.get("scout")).toBeUndefined();
		expect(changes).toBe(0);
	});

	test("a bad body is a 400", async () => {
		const server = setup();
		for (const body of [{}, { add: [] }, { add: "kit-do" }, { remove: [3] }])
			expect(
				(await call(server, "PUT", "agents/scout/skills", { body })).status,
			).toBe(400);
		expect(calls).toEqual([]);
	});

	test("a host without the skills addon answers 404", async () => {
		const server = setup(false);
		expect((await call(server, "GET", "agents/scout/skills")).status).toBe(404);
		expect(
			(
				await call(server, "PUT", "agents/scout/skills", {
					body: { add: ["kit-do"] },
				})
			).status,
		).toBe(404);
	});
});

describe("groups", () => {
	const body = {
		name: "duo",
		displayName: "Duo",
		members: ["scout", "infra"],
		host: "infra",
	};
	refusesTheSame(
		"create",
		{ method: "POST", path: "groups", body },
		"groups/nobody",
	);
	refusesTheSame(
		"rename",
		{ method: "PATCH", path: "groups/crew", body: { displayName: "Team" } },
		"groups/nobody",
	);
	refusesTheSame(
		"archive",
		{ method: "POST", path: "groups/crew/archive" },
		"groups/nobody/archive",
	);
	refusesTheSame(
		"restore",
		{ method: "POST", path: "groups/past/restore" },
		"groups/nobody/restore",
	);
	refusesTheSame(
		"delete",
		{ method: "DELETE", path: "groups/past" },
		"groups/nobody",
	);

	test("creates a group of active agents and answers it; the host is the first member by default", async () => {
		const server = setup();
		const response = await call(server, "POST", "groups", { body });
		expect(response.status).toBe(201);
		expect((await response.json()) as GroupProfileView).toEqual({
			name: "duo",
			displayName: "Duo",
			members: ["scout", "infra"],
			host: "infra",
			room: "app:group.duo",
		});
		const bare = await call(server, "POST", "groups", {
			body: { name: "trio", displayName: "Trio", members: ["boss", "infra"] },
		});
		expect(((await bare.json()) as GroupProfileView).host).toBe("boss");
		expect(calls).toEqual(["createGroup duo", "createGroup trio"]);
		expect(changes).toBe(2);
	});

	test("refuses a bad body (400) and the team's refusals (400) without making a group", async () => {
		const server = setup();
		for (const one of [
			{},
			{ ...body, name: 3 },
			{ ...body, displayName: "" },
			{ ...body, members: "scout" },
			{ ...body, members: undefined },
			{ ...body, members: [1, 2] },
			{ ...body, host: 4 },
		])
			expect((await call(server, "POST", "groups", { body: one })).status).toBe(
				400,
			);
		// Too few members, and a member that is archived.
		for (const members of [["scout"], ["scout", "old"], ["scout", "ghost"]])
			expect(
				(await call(server, "POST", "groups", { body: { ...body, members } }))
					.status,
			).toBe(400);
		expect(groups.has("duo")).toBe(false);
		expect(calls).toEqual([]);
	});

	test("reads a group; only an owner may, and an archived or unknown one is a 404", async () => {
		const server = setup();
		const view = (await (
			await call(server, "GET", "groups/crew")
		).json()) as GroupProfileView;
		expect(view).toMatchObject({
			name: "crew",
			members: ["boss", "scout"],
			host: "boss",
			room: "app:group.crew",
		});
		actAs({ id: "member", tier: "member" });
		expect((await call(server, "GET", "groups/crew")).status).toBe(403);
		actAs({ id: "owner", tier: "owner" });
		expect((await call(server, "GET", "groups/past")).status).toBe(404);
		expect((await call(server, "GET", "groups/nobody")).status).toBe(404);
	});

	test("renames, changes the members and chooses the host", async () => {
		const server = setup();
		const response = await call(server, "PATCH", "groups/crew", {
			body: {
				displayName: "Team",
				members: ["boss", "scout", "infra"],
				host: "infra",
			},
		});
		expect(response.status).toBe(200);
		expect((await response.json()) as GroupProfileView).toMatchObject({
			displayName: "Team",
			members: ["boss", "scout", "infra"],
			host: "infra",
		});
		expect(changes).toBe(1);
	});

	test("a bad patch is a 400 and changes nothing", async () => {
		const server = setup();
		for (const one of [
			{},
			{ displayName: 1 },
			{ members: "boss" },
			{ members: ["boss"] },
			{ host: 2 },
		])
			expect(
				(await call(server, "PATCH", "groups/crew", { body: one })).status,
			).toBe(400);
		expect(groups.get("crew")?.members).toEqual(["boss", "scout"]);
		expect(changes).toBe(0);
	});

	test("archives, restores and deletes a group like an agent", async () => {
		const server = setup();
		expect((await call(server, "POST", "groups/crew/archive")).status).toBe(
			200,
		);
		expect(groups.get("crew")?.status).toBe("archived");
		// Archived, it is no active group.
		expect((await call(server, "POST", "groups/crew/archive")).status).toBe(
			404,
		);
		const restored = await call(server, "POST", "groups/past/restore");
		expect(restored.status).toBe(200);
		expect(((await restored.json()) as GroupProfileView).name).toBe("past");
		expect((await call(server, "POST", "groups/past/restore")).status).toBe(
			400,
		);
		expect((await call(server, "DELETE", "groups/past")).status).toBe(400);
		const deleted = await call(server, "DELETE", "groups/crew");
		expect(deleted.status).toBe(200);
		expect(groups.has("crew")).toBe(false);
		expect(calls).toEqual([
			"archive crew caller=none",
			"restore past",
			"forget log app:group.crew",
			"forget cards app:group.crew",
			"mute app:group.crew false",
			"forget layout app:group.crew",
			"modes reset app:group.crew",
			"remove crew",
		]);
	});

	test("an agent's name is no group's", async () => {
		const server = setup();
		expect((await call(server, "GET", "groups/scout")).status).toBe(404);
		expect((await call(server, "DELETE", "groups/old")).status).toBe(404);
	});
});

describe("GET api/archive", () => {
	test("lists archived agents and groups, by name, for an owner only", async () => {
		const server = setup();
		const view = (await (
			await call(server, "GET", "archive")
		).json()) as ArchiveView;
		expect(view.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
			"agent:old",
			"group:past",
		]);
		expect(view.entries[0]?.avatar).toBe("/console/avatars/x.png");
		expect(view.entries[1]?.members).toEqual(["scout", "infra"]);
		actAs({ id: "member", tier: "member" });
		expect((await call(server, "GET", "archive")).status).toBe(403);
		actAs({ id: "owner", tier: "owner" });
		expect((await call(server, "POST", "archive")).status).toBe(404);
	});

	test("carries the time of the last message in each entry's room, and none for a room without one", async () => {
		lastMessages.set("app:agent.old", "2026-11-01T08:00:00.000Z");
		const view = (await (
			await call(setup(), "GET", "archive")
		).json()) as ArchiveView;
		expect(view.entries.map((entry) => entry.lastActive)).toEqual([
			"2026-11-01T08:00:00.000Z",
			undefined,
		]);
		lastMessages.set("app:group.past", "2026-10-02T08:00:00.000Z");
		const again = (await (
			await call(setup(), "GET", "archive")
		).json()) as ArchiveView;
		expect(again.entries[1]?.lastActive).toBe("2026-10-02T08:00:00.000Z");
	});
});
