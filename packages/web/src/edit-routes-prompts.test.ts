import { describe, expect, test } from "bun:test";
import type {
	ApiError,
	PromptConflict,
	PromptHistoryView,
	PromptsView,
	PromptView,
	SessionView,
} from "./api-types.ts";

// The routes that edit the main prompts and the skills' SKILL.md files: the owner-only rules every
// write shares, the 409 of a stale save, and the words of a refusal. The core's own behavior (the
// frontmatter rules, the history) has its tests in the core; here the registry is a stand-in.
import {
	AT,
	actAs,
	call,
	calls,
	document,
	documents,
	editHostPerTest,
	ownerOnly,
	setup,
} from "./testing/edit-routes-host.ts";

editHostPerTest();

describe("api/prompts", () => {
	test("lists the documents without their text, and says which differ from the file", async () => {
		const response = await call(setup(), "GET", "prompts");
		expect(response.status).toBe(200);
		const view = (await response.json()) as PromptsView;
		expect(view.documents).toEqual([
			{ id: "shared", label: "shared prompt", differs: false },
			{
				id: "guest",
				label: "guest prompt",
				differs: true,
				override: { by: "Riley", at: AT.toISOString() },
			},
		]);
	});

	test("a document whose file version cannot be read is marked in the list and the read, and the others are listed as before", async () => {
		const server = setup();
		documents.set(
			"aria",
			document("aria", {
				text: "",
				fileText: "",
				broken: "ENOENT: persona/aria.md",
			}),
		);
		const listed = (await (
			await call(server, "GET", "prompts")
		).json()) as PromptsView;
		expect(listed.documents.map((one) => one.id)).toEqual([
			"shared",
			"guest",
			"aria",
		]);
		expect(listed.documents.map((one) => one.broken)).toEqual([
			undefined,
			undefined,
			"ENOENT: persona/aria.md",
		]);
		const read = await call(server, "GET", "prompts/aria");
		expect(read.status).toBe(200);
		expect(((await read.json()) as PromptView).broken).toBe(
			"ENOENT: persona/aria.md",
		);
	});

	test("reads one document with its text and the file version", async () => {
		const view = (await (
			await call(setup(), "GET", "prompts/guest")
		).json()) as PromptView;
		expect(view).toMatchObject({
			id: "guest",
			text: "Owner's guest text.",
			fileText: "File text.",
			differs: true,
			maxChars: 20_000,
		});
	});

	test("a save names the text it was edited from and is kept under the owner's name", async () => {
		const server = setup();
		const response = await call(server, "PUT", "prompts/shared", {
			body: { text: "New text.", base: "File text." },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as PromptView).text).toBe("New text.");
		expect(calls).toEqual(["set shared by Riley"]);
	});

	test("a save from text that is no longer the current one is a 409 that carries the current document, and writes nothing", async () => {
		const server = setup();
		const response = await call(server, "PUT", "prompts/guest", {
			body: { text: "Mine.", base: "File text." },
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as PromptConflict;
		expect(body.conflict).toBe("changed");
		expect(body.current.text).toBe("Owner's guest text.");
		expect(calls).toEqual([]);
	});

	test("a refused text is a 400 with the core's words; a bad body is a 400", async () => {
		const server = setup();
		const empty = await call(server, "PUT", "prompts/shared", {
			body: { text: "  ", base: "File text." },
		});
		expect(empty.status).toBe(400);
		expect(((await empty.json()) as ApiError).error).toContain("1 to 20000");
		for (const body of [{ text: 1, base: "x" }, { text: "x" }, {}]) {
			expect(
				(await call(server, "PUT", "prompts/shared", { body })).status,
			).toBe(400);
		}
		expect(calls).toEqual([]);
	});

	test("the largest body follows the document's maxChars: a long text of a roomy document is saved, a body past the limit is a 413", async () => {
		const server = setup();
		// 60,000 characters of three bytes each is 180 KB, more than the 20,000-character default allows for.
		documents.set("roomy", document("roomy", { maxChars: 60_000 }));
		// Built at run time, so this file does not trip the public scan for Chinese text.
		const long = String.fromCodePoint(0x5b57).repeat(60_000);
		const saved = await call(server, "PUT", "prompts/roomy", {
			body: { text: long, base: "File text." },
		});
		expect(saved.status).toBe(200);
		expect(((await saved.json()) as PromptView).text).toBe(long);
		expect(calls).toEqual(["set roomy by Riley"]);
		// A document that keeps the default limit refuses a body far past what its texts can fill.
		const past = await call(server, "PUT", "prompts/shared", {
			body: { text: "x".repeat(300_000), base: "File text." },
		});
		expect(past.status).toBe(413);
		expect(calls).toEqual(["set roomy by Riley"]);
	});

	test("reverting returns to the file version and is kept under the owner's name; a document without an override is a 400", async () => {
		const server = setup();
		const response = await call(server, "POST", "prompts/guest/revert", {
			body: { base: "Owner's guest text." },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as PromptView).differs).toBe(false);
		expect(calls).toEqual(["revert guest by Riley"]);
		expect(
			(
				await call(server, "POST", "prompts/shared/revert", {
					body: { base: "File text." },
				})
			).status,
		).toBe(400);
	});

	test("a revert from text that is no longer the current one is a 409 that carries the current document, and writes nothing", async () => {
		const server = setup();
		const response = await call(server, "POST", "prompts/guest/revert", {
			body: { base: "The text a tab loaded earlier." },
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as PromptConflict;
		expect(body.conflict).toBe("changed");
		expect(body.current.text).toBe("Owner's guest text.");
		expect(calls).toEqual([]);
	});

	test("a revert that does not name the text it was asked from is a 400", async () => {
		const server = setup();
		for (const body of [{}, { base: 1 }])
			expect(
				(await call(server, "POST", "prompts/guest/revert", { body })).status,
			).toBe(400);
		expect(calls).toEqual([]);
	});

	test("the history lists who changed it, when, and the text each change replaced", async () => {
		const view = (await (
			await call(setup(), "GET", "prompts/guest/history")
		).json()) as PromptHistoryView;
		expect(view.versions).toEqual([
			{
				id: 2,
				action: "set",
				text: "Owner's guest text.",
				previous: "File text.",
				by: "Riley",
				at: AT.toISOString(),
			},
		]);
	});

	test("a host without prompt documents answers 404", async () => {
		const server = setup({ skills: true });
		expect((await call(server, "GET", "prompts")).status).toBe(404);
	});

	test("an unsupported method is refused", async () => {
		const server = setup();
		expect((await call(server, "DELETE", "prompts")).status).toBe(405);
		expect((await call(server, "DELETE", "prompts/shared")).status).toBe(404);
	});

	ownerOnly("a save", {
		method: "PUT",
		path: "prompts/shared",
		body: { text: "x", base: "File text." },
		unknown: "prompts/nope",
	});
	ownerOnly("a revert", {
		method: "POST",
		path: "prompts/guest/revert",
		body: { base: "Owner's guest text." },
		unknown: "prompts/nope/revert",
	});
	ownerOnly("a read", {
		method: "GET",
		path: "prompts/shared",
		unknown: "prompts/nope",
	});
	ownerOnly("the history", {
		method: "GET",
		path: "prompts/shared/history",
		unknown: "prompts/nope/history",
	});
});

describe("agent prompt history and the name a change is kept under", () => {
	test("lists an agent's prompt versions, newest first", async () => {
		const view = (await (
			await call(setup(), "GET", "agents/scout/prompt-history")
		).json()) as PromptHistoryView;
		expect(view.versions.map((v) => [v.by, v.previous, v.text])).toEqual([
			["doctor", "You scout.", "You scout well."],
		]);
	});

	test("a member and an unknown agent are refused", async () => {
		const server = setup();
		expect(
			(await call(server, "GET", "agents/nobody/prompt-history")).status,
		).toBe(404);
		actAs({ id: "member", name: "Mel", tier: "member" });
		expect(
			(await call(server, "GET", "agents/scout/prompt-history")).status,
		).toBe(403);
	});

	test("a prompt saved through PATCH is kept under the owner's name", async () => {
		const server = setup();
		const response = await call(server, "PATCH", "agents/scout", {
			body: { prompt: "You scout better." },
		});
		expect(response.status).toBe(200);
		expect(calls).toEqual(["update scout by Riley"]);
	});
});

describe("what the session says the host can edit", () => {
	test("prompts and skills are announced when the host has them, and only then", async () => {
		const both = (await (
			await call(setup(), "GET", "session")
		).json()) as SessionView;
		expect(both).toMatchObject({ prompts: true, skillEdit: true });
		const neither = (await (
			await call(setup({}), "GET", "session")
		).json()) as SessionView;
		expect(neither.prompts).toBeUndefined();
		expect(neither.skillEdit).toBeUndefined();
	});
});
