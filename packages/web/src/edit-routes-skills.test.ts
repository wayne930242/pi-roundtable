import { describe, expect, test } from "bun:test";
import type {
	ApiError,
	SkillConflict,
	SkillDeleted,
	SkillDocView,
	SkillGroupApplied,
	SkillGroupChanged,
	SkillGroupsView,
	SkillHistoryView,
} from "./api-types.ts";

// The routes that edit the main prompts and the skills' SKILL.md files: the owner-only rules every
// write shares, the 409 of a stale save, and the words of a refusal. The core's own behavior (the
// frontmatter rules, the history) has its tests in the core; here the registry is a stand-in.
import {
	AT,
	actAs,
	call,
	calls,
	editHostPerTest,
	HASH,
	ownerOnly,
	setSkillGroups,
	setup,
	skillGroups,
	skillText,
} from "./testing/edit-routes-host.ts";

editHostPerTest();

describe("api/skill-docs", () => {
	test("reads a skill's whole SKILL.md with its hash and whether it can be edited", async () => {
		const server = setup();
		const written = (await (
			await call(server, "GET", "skill-docs/daily-notes")
		).json()) as SkillDocView;
		expect(written).toMatchObject({
			name: "daily-notes",
			source: { kind: "written" },
			writable: true,
		});
		expect(written.text).toBe(skillText("One."));
		const linked = (await (
			await call(server, "GET", "skill-docs/kit-do")
		).json()) as SkillDocView;
		expect(linked).toMatchObject({
			writable: false,
			source: { kind: "linked", repo: "acme/kit" },
		});
	});

	test("a save names the hash it was edited from and is kept under the owner's name", async () => {
		const server = setup();
		const read = (await (
			await call(server, "GET", "skill-docs/daily-notes")
		).json()) as SkillDocView;
		const response = await call(server, "PUT", "skill-docs/daily-notes", {
			body: { text: skillText("Two."), baseHash: read.hash },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as SkillDocView).text).toBe(
			skillText("Two."),
		);
		expect(calls).toEqual(["save daily-notes by Riley"]);
	});

	test("a save from an older hash is a 409 that carries what is there now", async () => {
		const server = setup();
		const response = await call(server, "PUT", "skill-docs/daily-notes", {
			body: { text: skillText("Mine."), baseHash: HASH(9) },
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as SkillConflict;
		expect(body.conflict).toBe("changed");
		expect(body.current.text).toBe(skillText("One."));
		expect(calls).toEqual([]);
	});

	test("a read-only skill's save is refused with the core's words", async () => {
		const server = setup();
		const read = (await (
			await call(server, "GET", "skill-docs/kit-do")
		).json()) as SkillDocView;
		const response = await call(server, "PUT", "skill-docs/kit-do", {
			body: { text: read.text, baseHash: read.hash },
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as ApiError).error).toContain("read-only");
	});

	test("a bad body is a 400, and a bad hash is named", async () => {
		const server = setup();
		for (const body of [{ text: 1, baseHash: HASH(1) }, { text: "x" }]) {
			expect(
				(await call(server, "PUT", "skill-docs/daily-notes", { body })).status,
			).toBe(400);
		}
		const response = await call(server, "PUT", "skill-docs/daily-notes", {
			body: { text: "x", baseHash: "nope" },
		});
		expect(((await response.json()) as ApiError).error).toContain("baseHash");
	});

	test("makes a skill from a whole SKILL.md and answers 201 with it", async () => {
		const server = setup();
		const response = await call(server, "POST", "skill-docs", {
			body: { text: skillText("New.") },
		});
		expect(response.status).toBe(201);
		expect(((await response.json()) as SkillDocView).name).toBe("fresh");
		expect(calls).toEqual(["create by Riley"]);
		const refused = await call(server, "POST", "skill-docs", {
			body: { text: "no frontmatter" },
		});
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as ApiError).error).toContain("frontmatter");
	});

	test("the history lists the versions kept, with who saved each", async () => {
		const view = (await (
			await call(setup(), "GET", "skill-docs/daily-notes/history")
		).json()) as SkillHistoryView;
		expect(view.versions.map((v) => [v.id, v.by, v.at])).toEqual([
			[1, "Riley", AT.toISOString()],
		]);
	});

	test("deletes an agent-written skill and answers with the registry's words", async () => {
		const server = setup();
		const response = await call(server, "DELETE", "skill-docs/daily-notes");
		expect(response.status).toBe(200);
		expect(((await response.json()) as SkillDeleted).message).toBe(
			"Removed skill daily-notes; detached from agents scout.",
		);
		expect(calls).toEqual(["delete daily-notes"]);
	});

	test("a skill an agent did not write is not deleted, and the refusal is a 400 in the registry's words", async () => {
		const server = setup();
		const response = await call(server, "DELETE", "skill-docs/kit-do");
		expect(response.status).toBe(400);
		expect(((await response.json()) as ApiError).error).toBe(
			"kit-do is linked and is read-only here.",
		);
		expect(calls).toEqual([]);
	});

	test("a skill the catalog does not list is a 404", async () => {
		const server = setup();
		expect((await call(server, "GET", "skill-docs/ghost")).status).toBe(404);
		expect(
			(
				await call(server, "PUT", "skill-docs/ghost", {
					body: { text: "x", baseHash: HASH(1) },
				})
			).status,
		).toBe(404);
	});

	test("a host without the skills addon answers 404", async () => {
		const server = setup({ prompts: true });
		expect((await call(server, "GET", "skill-docs/daily-notes")).status).toBe(
			404,
		);
		expect(
			(await call(server, "POST", "skill-docs", { body: { text: "x" } }))
				.status,
		).toBe(404);
	});

	ownerOnly("a save", {
		method: "PUT",
		path: "skill-docs/daily-notes",
		body: { text: "x", baseHash: HASH(1) },
		unknown: "skill-docs/ghost",
	});
	ownerOnly("a read", {
		method: "GET",
		path: "skill-docs/daily-notes",
		unknown: "skill-docs/ghost",
	});
	ownerOnly("a delete", {
		method: "DELETE",
		path: "skill-docs/daily-notes",
		unknown: "skill-docs/ghost",
	});
	ownerOnly("the history", {
		method: "GET",
		path: "skill-docs/daily-notes/history",
		unknown: "skill-docs/ghost/history",
	});
	test("creating: a member and a foreign Origin are refused, and nothing is made", async () => {
		const server = setup();
		actAs({ id: "member", name: "Mel", tier: "member" });
		expect(
			(await call(server, "POST", "skill-docs", { body: { text: "x" } }))
				.status,
		).toBe(403);
		actAs({ id: "owner", name: "Riley", tier: "owner" });
		expect(
			(
				await call(server, "POST", "skill-docs", {
					body: { text: "x" },
					origin: "https://evil.example.test",
				})
			).status,
		).toBe(403);
		expect(calls).toEqual([]);
	});
});

describe("api/skill-groups", () => {
	test("lists the groups with their skills", async () => {
		const response = await call(setup(), "GET", "skill-groups");
		expect(response.status).toBe(200);
		expect(((await response.json()) as SkillGroupsView).groups).toEqual([
			{
				name: "coding",
				description: "Coding workflow.",
				skills: ["kit-do", "writing-skills", "tidy", "daily-notes"],
			},
		]);
	});

	test("creates and replaces a group, and a rename deletes the old name", async () => {
		const server = setup();
		const made = await call(server, "PUT", "skill-groups/notes", {
			body: { description: "Notes.", skills: ["daily-notes"] },
		});
		expect(made.status).toBe(201);
		expect(((await made.json()) as SkillGroupChanged).message).toBe(
			"Created skill group notes.",
		);
		const replaced = await call(server, "PUT", "skill-groups/notes", {
			body: { description: "Notes.", skills: [] },
		});
		expect(replaced.status).toBe(200);
		const renamed = await call(server, "PUT", "skill-groups/build", {
			body: { description: "Build.", skills: ["kit-do"], from: "coding" },
		});
		expect(renamed.status).toBe(201);
		expect(skillGroups.map((group) => group.name)).toEqual(["notes", "build"]);
		expect(calls).toEqual([
			"set group notes: daily-notes",
			"set group notes: ",
			"set group build: kit-do",
			"delete group coding",
		]);
	});

	test("refusals: a bad body, an unknown skill, a rename onto a taken name or from a missing group", async () => {
		const server = setup();
		for (const body of [
			{ skills: [] },
			{ description: "x", skills: "kit-do" },
			{ description: "x", skills: [1] },
		])
			expect(
				(await call(server, "PUT", "skill-groups/notes", { body })).status,
			).toBe(400);
		const unknown = await call(server, "PUT", "skill-groups/notes", {
			body: { description: "x", skills: ["ghost"] },
		});
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as ApiError).error).toContain("ghost");
		await call(server, "PUT", "skill-groups/notes", {
			body: { description: "x", skills: [] },
		});
		calls.length = 0;
		expect(
			(
				await call(server, "PUT", "skill-groups/notes", {
					body: { description: "x", skills: [], from: "coding" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await call(server, "PUT", "skill-groups/other", {
					body: { description: "x", skills: [], from: "ghost" },
				})
			).status,
		).toBe(404);
		expect(calls).toEqual([]);
	});

	test("deletes a group and leaves its skills alone", async () => {
		const server = setup();
		const response = await call(server, "DELETE", "skill-groups/coding");
		expect(response.status).toBe(200);
		expect(skillGroups).toEqual([]);
		expect(calls).toEqual(["delete group coding"]);
	});

	test("applying switches on only the skills the knight lacks, through the toggle's attach, and names them", async () => {
		const server = setup();
		const response = await call(server, "POST", "skill-groups/coding/apply", {
			body: { agent: "scout" },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as SkillGroupApplied).added).toEqual([
			"tidy",
			"daily-notes",
		]);
		expect(calls).toEqual(["attach scout +tidy,daily-notes -"]);
	});

	test("applying a group off switches off the group's skills the knight carries, built-in ones excepted", async () => {
		const response = await call(setup(), "POST", "skill-groups/coding/apply", {
			body: { agent: "scout", on: false },
		});
		expect(response.status).toBe(200);
		expect((await response.json()) as SkillGroupApplied).toEqual({
			added: [],
			removed: ["kit-do"],
		});
		expect(calls).toEqual(["attach scout + -kit-do"]);
	});

	test("applying a group the knight already carries changes nothing", async () => {
		setSkillGroups([
			{
				name: "kit",
				description: "Kit.",
				skills: ["kit-do", "writing-skills"],
			},
		]);
		const response = await call(setup(), "POST", "skill-groups/kit/apply", {
			body: { agent: "scout" },
		});
		expect(((await response.json()) as SkillGroupApplied).added).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("applying to an unknown knight is a 404 and to no knight a 400", async () => {
		const server = setup();
		expect(
			(
				await call(server, "POST", "skill-groups/coding/apply", {
					body: { agent: "ghost" },
				})
			).status,
		).toBe(404);
		expect(
			(await call(server, "POST", "skill-groups/coding/apply", { body: {} }))
				.status,
		).toBe(400);
		expect(calls).toEqual([]);
	});

	test("a host without the skills addon answers 404", async () => {
		expect(
			(await call(setup({ prompts: true }), "GET", "skill-groups")).status,
		).toBe(404);
	});

	ownerOnly("a group's delete", {
		method: "DELETE",
		path: "skill-groups/coding",
		unknown: "skill-groups/ghost",
	});
	ownerOnly("applying a group", {
		method: "POST",
		path: "skill-groups/coding/apply",
		body: { agent: "scout" },
		unknown: "skill-groups/ghost/apply",
	});
	test("listing and saving: a member is refused, and nothing is saved", async () => {
		const server = setup();
		actAs({ id: "member", name: "Mel", tier: "member" });
		expect((await call(server, "GET", "skill-groups")).status).toBe(403);
		expect(
			(
				await call(server, "PUT", "skill-groups/notes", {
					body: { description: "x", skills: [] },
				})
			).status,
		).toBe(403);
		expect(calls).toEqual([]);
	});
});
