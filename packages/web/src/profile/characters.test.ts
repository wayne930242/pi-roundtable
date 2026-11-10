import { afterAll, beforeAll, expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import type { ProfileView, SessionView } from "../api-types.ts";
import { APP_MIGRATIONS } from "../app/migrations.ts";
import {
	bootE,
	Client,
	type EHost,
	MEL,
	ofType,
	principalOf,
	rest,
	SAM,
} from "../testing/e-host.ts";
import type { LinkProver } from "../web-app.ts";
import { PersonCharacters } from "./characters.ts";

/** A prover whose links the test sets by hand: a person not in `linked` stays at the gate. */
function prover(): LinkProver & { linked: Set<string> } {
	const linked = new Set<string>();
	return {
		provider: "line",
		label: "LINE",
		linked,
		status: async (principalId) =>
			linked.has(principalId)
				? { linked: { subject: "u", linkedAt: new Date(0) } }
				: {},
		issue: async () => {
			throw new Error("not issued here");
		},
		confirm: async () => undefined,
		cancel: async () => undefined,
		unlink: async () => undefined,
	};
}

const put = (app: EHost, who: string, character: unknown) =>
	rest(app, "profile/character", {
		method: "PUT",
		who,
		body: JSON.stringify({ character }),
	});

const profileOf = async (app: EHost, who: string) =>
	(await (await rest(app, "profile", { who })).json()) as ProfileView;

/** The `ready` frame of a fresh socket of `who`. */
async function readyOf(app: EHost, who: string) {
	const client = await Client.open(app, who);
	if (!client) throw new Error(`${who} was not let in`);
	try {
		return await client.take(ofType("ready"));
	} finally {
		client.close();
	}
}

describeDb("a person's own knight over a real host", () => {
	const line = prover();
	let app: EHost;
	let owner = "";
	let mel = "";
	let sam = "";
	beforeAll(async () => {
		app = await bootE({
			// Sam never links the account, so Sam stays at the gate; the owner's configuration links it.
			console: { onboarding: { links: { line: "required" } } },
			extra: (web) => web.registerLinkProver(line),
		});
		mel = await principalOf(app.host, MEL);
		sam = await principalOf(app.host, SAM);
		line.linked.add(mel);
		app.app.onboarding.changed(mel);
		const sql = app.host.context.database();
		await sql`DELETE FROM web_person_characters`;
		const session = (await (
			await rest(app, "session", { who: "owner" })
		).json()) as SessionView;
		owner = session.principal.id;
	}, 30_000);
	afterAll(async () => {
		await app.host.context.database()`DELETE FROM web_person_characters`;
		await app.stop();
	});

	test("the migration is the web app's own and makes the table", async () => {
		expect(PersonCharacters.migration.name).toBe("web-person-characters");
		expect(APP_MIGRATIONS).toContain(PersonCharacters.migration);
		const sql = app.host.context.database();
		const columns: { column_name: string; data_type: string }[] = await sql`
			SELECT column_name, data_type FROM information_schema.columns
			WHERE table_name = 'web_person_characters' ORDER BY ordinal_position`;
		expect(columns.map((c) => [c.column_name, c.data_type])).toEqual([
			["principal_id", "text"],
			["character", "jsonb"],
			["updated_at", "timestamp with time zone"],
		]);
	});

	test("the three people are who the suite takes them for: two past the gate, one at it", async () => {
		const gateOf = async (who: string) =>
			(
				(await (await rest(app, "session", { who })).json()) as SessionView
			).gate?.map((step) => step.id);
		expect(await gateOf("owner")).toBeUndefined();
		expect(await gateOf("mel")).toBeUndefined();
		expect(await gateOf("sam")).toEqual(["link:line"]);
	});

	test("PUT stores the knight and answers the profile with it; GET api/profile carries it from then on", async () => {
		expect((await profileOf(app, "owner")).character).toBeUndefined();
		const saved = await put(app, "owner", { class: "wizard", hat: "beret" });
		expect(saved.status).toBe(200);
		const view = (await saved.json()) as ProfileView;
		expect(view.principal).toBe(owner);
		expect(view.character?.v).toBe(1);
		expect(view.character?.class).toBe("wizard");
		expect(view.character?.hat).toBe("beret");
		expect((await profileOf(app, "owner")).character).toEqual(view.character);
		// The row holds the spec itself, not the text of it.
		const sql = app.host.context.database();
		const [row]: { kind: string }[] = await sql`
			SELECT jsonb_typeof(character) AS kind FROM web_person_characters
			WHERE principal_id = ${owner}`;
		expect(row?.kind).toBe("object");
	});

	test("a later PUT is resolved over the stored knight: only the fields sent change", async () => {
		const before = (await profileOf(app, "owner")).character;
		const build = before?.build === "stout" ? "slim" : "stout";
		const saved = await put(app, "owner", { build });
		expect(saved.status).toBe(200);
		const { character } = (await saved.json()) as ProfileView;
		expect(character).toEqual({ ...before, build } as typeof character);
		const [count]: { n: number }[] = await app.host.context.database()`
			SELECT count(*)::int AS n FROM web_person_characters WHERE principal_id = ${owner}`;
		expect(count?.n).toBe(1);
	});

	test("a refused field answers 400 naming it, and nothing is stored", async () => {
		const before = (await profileOf(app, "owner")).character;
		const bad = await put(app, "owner", { class: "dragon" });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { field?: string }).field).toBe("class");
		const unknown = await put(app, "owner", { tail: "long" });
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as { field?: string }).field).toBe("tail");
		const color = await put(app, "owner", { colors: { primary: "red" } });
		expect(color.status).toBe(400);
		expect(((await color.json()) as { field?: string }).field).toBe(
			"colors.primary",
		);
		for (const body of [{ character: "wizard" }, { character: [] }, {}]) {
			const refused = await rest(app, "profile/character", {
				method: "PUT",
				body: JSON.stringify(body),
			});
			expect(refused.status).toBe(400);
		}
		const large = await put(app, "owner", { class: "x".repeat(5000) });
		expect(large.status).toBe(413);
		expect((await profileOf(app, "owner")).character).toEqual(before);
		expect(
			(await rest(app, "profile/character", { method: "POST" })).status,
		).toBe(405);
	});

	test("a member's first knight starts from the look their id suggests, and is theirs alone", async () => {
		const saved = await put(app, "mel", {});
		expect(saved.status).toBe(200);
		const first = ((await saved.json()) as ProfileView).character;
		expect(first?.v).toBe(1);
		// The same person and the same input give the same look.
		const again = ((await (await put(app, "mel", {})).json()) as ProfileView)
			.character;
		expect(again).toEqual(first);
		expect((await profileOf(app, "owner")).character?.class).toBe("wizard");
	});

	test("GET api/people/<id>/character: another person's past the gate, 403 at it, 404 without one", async () => {
		const mine = await rest(app, `people/${owner}/character`);
		expect(mine.status).toBe(200);
		expect(mine.headers.get("cache-control")).toBe("private, max-age=300");
		const read = await rest(app, `people/${owner}/character`, { who: "mel" });
		expect(read.status).toBe(200);
		expect(((await read.json()) as ProfileView).character).toEqual(
			(await profileOf(app, "owner")).character,
		);
		// Sam is at the gate: another person's waits, Sam's own does not.
		expect(
			(await rest(app, `people/${owner}/character`, { who: "sam" })).status,
		).toBe(403);
		expect(
			(await rest(app, `people/${sam}/character`, { who: "sam" })).status,
		).toBe(404);
		// Nobody past the gate learns more than that Sam has none.
		expect(
			(await rest(app, `people/${sam}/character`, { who: "mel" })).status,
		).toBe(404);
		expect((await rest(app, "people/nobody/character")).status).toBe(404);
		expect(
			(await rest(app, `people/${owner}/character`, { method: "PUT" })).status,
		).toBe(405);
		expect((await rest(app, `people/${owner}/other`)).status).toBe(404);
	});

	test("a person at the gate may make their own knight and read it", async () => {
		const saved = await put(app, "sam", { class: "knight" });
		expect(saved.status).toBe(200);
		const own = await rest(app, `people/${sam}/character`, { who: "sam" });
		expect(own.status).toBe(200);
		expect(((await own.json()) as ProfileView).character?.class).toBe("knight");
		expect((await readyOf(app, "sam")).character?.class).toBe("knight");
	});

	test("ready carries the person's own knight on each connect, and none once it is removed", async () => {
		const stored = (await profileOf(app, "owner")).character;
		expect((await readyOf(app, "owner")).character).toEqual(stored);
		// Each person gets their own, never another's.
		expect((await readyOf(app, "mel")).character).toEqual(
			(await profileOf(app, "mel")).character,
		);
		const removed = await rest(app, "profile/character", { method: "DELETE" });
		expect(removed.status).toBe(200);
		expect(((await removed.json()) as ProfileView).character).toBeUndefined();
		expect((await profileOf(app, "owner")).character).toBeUndefined();
		const ready = await readyOf(app, "owner");
		expect("character" in ready).toBe(false);
		expect((await rest(app, `people/${owner}/character`)).status).toBe(404);
		// Removing what is not there is the same answer.
		expect(
			(await rest(app, "profile/character", { method: "DELETE" })).status,
		).toBe(200);
		// Mel's is untouched.
		expect((await profileOf(app, "mel")).character).toBeDefined();
	});

	test("a stored knight the kit no longer takes is read as none, not as an error", async () => {
		const sql = app.host.context.database();
		await sql`
			INSERT INTO web_person_characters (principal_id, character)
			VALUES (${owner}, ${JSON.stringify({ v: 1, class: "gone" })}::text::jsonb)`;
		expect((await rest(app, "profile")).status).toBe(200);
		expect((await profileOf(app, "owner")).character).toBeUndefined();
		expect((await rest(app, `people/${owner}/character`)).status).toBe(404);
		expect("character" in (await readyOf(app, "owner"))).toBe(false);
		// The next save starts over from the suggestion and replaces the row.
		const saved = await put(app, "owner", { class: "bard" });
		expect(saved.status).toBe(200);
		expect((await profileOf(app, "owner")).character?.class).toBe("bard");
	});

	test("a stored knight with one unknown part id still gives a knight", async () => {
		const sql = app.host.context.database();
		await sql`
			INSERT INTO web_person_characters (principal_id, character)
			VALUES (${owner}, ${JSON.stringify({ v: 1, class: "knight", hat: "gone-hat" })}::text::jsonb)
			ON CONFLICT (principal_id) DO UPDATE SET character = EXCLUDED.character`;
		expect((await profileOf(app, "owner")).character?.class).toBe("knight");
	});
});
