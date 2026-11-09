import { describe, expect, test } from "bun:test";
import type {
	AgentProfileView,
	ApiError,
	CharacterRefusal,
} from "./api-types.ts";

import {
	actAs,
	agents,
	call,
	calls,
	changes,
	refusesTheSame,
	setCleanupFails,
	setup,
	speakers,
	teamHostPerTest,
	threadsOf,
} from "./testing/team-routes-host.ts";

teamHostPerTest();

describe("a member learns nothing of the team from a write", () => {
	test("the owner check comes before any lookup, so a state or name that would be a 400 or 404 is a 403", async () => {
		const server = setup();
		actAs({ id: "member", tier: "member" });
		const writes: [string, string][] = [
			["DELETE", "agents/nobody"],
			["DELETE", "agents/scout"],
			["POST", "agents/scout/restore"],
			["POST", "agents/nobody/restore"],
			["DELETE", "groups/nobody"],
			["DELETE", "groups/crew"],
			["POST", "groups/crew/restore"],
			["PATCH", "groups/past"],
		];
		for (const [method, path] of writes) {
			const response = await call(server, method, path, { body: {} });
			expect([method, path, response.status]).toEqual([method, path, 403]);
		}
		expect(calls).toEqual([]);
		// The same requests as the owner are the 400s and 404s the state calls for.
		actAs({ id: "owner", tier: "owner" });
		expect((await call(server, "DELETE", "agents/nobody")).status).toBe(404);
		expect((await call(server, "POST", "agents/scout/restore")).status).toBe(
			400,
		);
	});
});

describe("POST api/agents", () => {
	const body = {
		name: "notes",
		displayName: "Notes",
		prompt: "Keep notes.",
		model: "m/two",
		task: "  Say hi.  ",
		skills: ["kit-do"],
		character: { class: "scribe" },
	};

	test("a member and a request from elsewhere are refused", async () => {
		const server = setup();
		actAs({ id: "member", tier: "member" });
		expect((await call(server, "POST", "agents", { body })).status).toBe(403);
		actAs({ id: "owner", tier: "owner" });
		expect(
			(await call(server, "POST", "agents", { body, origin: null })).status,
		).toBe(403);
		expect(agents.has("notes")).toBe(false);
		expect(changes).toBe(0);
	});

	test("makes the agent as the owner, with the trimmed task, and answers its profile", async () => {
		const response = await call(setup(), "POST", "agents", { body });
		expect(response.status).toBe(201);
		const profile = (await response.json()) as AgentProfileView;
		expect(profile).toMatchObject({
			name: "notes",
			displayName: "Notes",
			room: "app:agent.notes",
			model: "m/two",
		});
		expect(calls).toEqual([
			"createAgent notes task=Say hi. in=app skills=kit-do",
		]);
		expect(speakers[0]).toMatchObject({ tier: "owner", principalId: "owner" });
		expect(changes).toBe(1);
	});

	test("an empty task and no skills are left out", async () => {
		const response = await call(setup(), "POST", "agents", {
			body: {
				name: "bare",
				displayName: "Bare",
				prompt: "Be.",
				task: "  ",
				skills: [],
			},
		});
		expect(response.status).toBe(201);
		expect(calls).toEqual(["createAgent bare task=- in=app skills=-"]);
	});

	test("refuses a bad body with 400 and makes nothing", async () => {
		const server = setup();
		const bads: unknown[] = [
			{},
			{ ...body, name: 7 },
			{ ...body, displayName: "" },
			{ ...body, prompt: undefined },
			{ ...body, model: 1 },
			{ ...body, task: ["x"] },
			{ ...body, skills: "kit-do" },
			{ ...body, skills: [1] },
			{ ...body, character: "knight" },
			{ ...body, character: [] },
		];
		for (const one of bads)
			expect((await call(server, "POST", "agents", { body: one })).status).toBe(
				400,
			);
		expect(
			(await call(server, "POST", "agents", { raw: "{not json" })).status,
		).toBe(400);
		expect((await call(server, "POST", "agents", { raw: "[1]" })).status).toBe(
			400,
		);
		expect(calls).toEqual([]);
	});

	test("names the field of a look that is not usable", async () => {
		const response = await call(setup(), "POST", "agents", {
			body: { ...body, character: { class: "nope" } },
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as CharacterRefusal).field).toBe("class");
		const unknown = await call(setup(), "POST", "agents", {
			body: { ...body, character: { wings: 2 } },
		});
		expect(((await unknown.json()) as CharacterRefusal).field).toBe("wings");
		expect(calls).toEqual([]);
	});

	test("the agent server's refusals are 400s with its words", async () => {
		const server = setup();
		const taken = await call(server, "POST", "agents", {
			body: { ...body, name: "scout" },
		});
		expect(taken.status).toBe(400);
		expect(((await taken.json()) as ApiError).error).toContain("taken");
		const model = await call(server, "POST", "agents", {
			body: { ...body, model: "other/model" },
		});
		expect(model.status).toBe(400);
		expect(agents.has("notes")).toBe(false);
		expect(changes).toBe(0);
	});

	test("other methods on the collection are 405", async () => {
		expect((await call(setup(), "DELETE", "agents")).status).toBe(405);
	});
});

describe("agent archive, restore and delete", () => {
	refusesTheSame(
		"archive",
		{ method: "POST", path: "agents/scout/archive" },
		"agents/nobody/archive",
	);
	refusesTheSame(
		"restore",
		{ method: "POST", path: "agents/old/restore" },
		"agents/nobody/restore",
	);
	refusesTheSame(
		"delete",
		{ method: "DELETE", path: "agents/old" },
		"agents/nobody",
	);

	test("archives an agent through the team with no calling agent, and the room leaves the list", async () => {
		const response = await call(setup(), "POST", "agents/scout/archive");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(calls).toEqual(["archive scout caller=none"]);
		expect(agents.get("scout")?.status).toBe("archived");
		expect(changes).toBe(1);
		// An archived agent is no active agent: it cannot be archived again, nor read or edited.
		const again = await call(setup(), "POST", "agents/scout/archive");
		expect(again.status).toBe(404);
		expect((await call(setup(), "GET", "agents/scout")).status).toBe(404);
		expect(
			(await call(setup(), "PATCH", "agents/scout", { body: { prompt: "x" } }))
				.status,
		).toBe(404);
	});

	test("the coordinator's refusal is a 400", async () => {
		const response = await call(setup(), "POST", "agents/boss/archive");
		expect(response.status).toBe(400);
		expect(((await response.json()) as ApiError).error).toBe(
			"The coordinator cannot be archived.",
		);
		expect(agents.get("boss")?.status).toBe("active");
		expect(changes).toBe(0);
	});

	test("restores an archived agent and answers its profile; an active one is a 400", async () => {
		const response = await call(setup(), "POST", "agents/old/restore");
		expect(response.status).toBe(200);
		expect(((await response.json()) as AgentProfileView).name).toBe("old");
		expect(agents.get("old")?.status).toBe("active");
		expect(changes).toBe(1);
		const active = await call(setup(), "POST", "agents/scout/restore");
		expect(active.status).toBe(400);
		expect(calls).toEqual(["restore old"]);
	});

	test("deletes only an archived agent, and clears what the app kept of its room, its pin and folder place included", async () => {
		const server = setup();
		const active = await call(server, "DELETE", "agents/scout");
		expect(active.status).toBe(400);
		expect(agents.has("scout")).toBe(true);
		expect(calls).toEqual([]);
		const response = await call(server, "DELETE", "agents/old");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(agents.has("old")).toBe(false);
		expect(calls).toEqual([
			"forget log app:agent.old",
			"forget cards app:agent.old",
			"mute app:agent.old false",
			"forget layout app:agent.old",
			"modes reset app:agent.old",
			"remove old",
		]);
		expect(changes).toBe(1);
	});

	test("deleting an agent also deletes its dispatch threads, with their messages and cards", async () => {
		const server = setup();
		threadsOf.set("app:agent.old", ["thread.a", "thread.b"]);
		const response = await call(server, "DELETE", "agents/old");
		expect(response.status).toBe(200);
		expect(calls).toEqual([
			"forget log app:thread.a",
			"forget cards app:thread.a",
			"forget log app:thread.b",
			"forget cards app:thread.b",
			"forget threads app:agent.old",
			"forget log app:agent.old",
			"forget cards app:agent.old",
			"mute app:agent.old false",
			"forget layout app:agent.old",
			"modes reset app:agent.old",
			"remove old",
		]);
		expect(threadsOf.has("app:agent.old")).toBe(false);
	});

	test("a cleanup that fails halfway leaves the agent deletable, and the retry finishes", async () => {
		const server = setup();
		setCleanupFails(true);
		const failed = await call(server, "DELETE", "agents/old");
		expect(failed.status).toBe(500);
		expect(agents.has("old")).toBe(true);
		expect(calls).toEqual([]);
		setCleanupFails(false);
		const retried = await call(server, "DELETE", "agents/old");
		expect(retried.status).toBe(200);
		expect(agents.has("old")).toBe(false);
		expect(calls.at(-1)).toBe("remove old");
	});

	test("a group's name is no agent's", async () => {
		const server = setup();
		expect((await call(server, "POST", "agents/crew/archive")).status).toBe(
			404,
		);
		expect((await call(server, "DELETE", "agents/past")).status).toBe(404);
		expect(calls).toEqual([]);
	});
});
