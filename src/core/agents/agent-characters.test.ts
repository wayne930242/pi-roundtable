import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CATALOG,
	resolveCharacter,
	suggestCharacter,
} from "../../characters/index.ts";
import { AgentError } from "../domain/errors.ts";
import { describeDb } from "../testing/database.ts";
import { characterOf } from "./agent-rules.ts";
import {
	duringTurn,
	ENTRY,
	fx,
	settle,
	useTeamFixture,
} from "./agent-team-fixture.ts";
import { FileAvatarStudio } from "./avatar-studio.ts";
import { discordKey } from "./team-keys.ts";

const REFERENCE = join(import.meta.dir, "..", "assets", "neutral.png");
const COORDINATOR = {
	name: "coordinator",
	session: discordKey(ENTRY),
	home: discordKey(ENTRY),
};

let dir = "";
let studio: FileAvatarStudio;
const rendered: string[] = [];

/** The real studio over a fresh directory, recording each render. */
function realStudio() {
	dir = mkdtempSync(join(tmpdir(), "roundtable-av2-"));
	rendered.length = 0;
	studio = new FileAvatarStudio({ dir, referencePath: REFERENCE });
	const render = studio.render.bind(studio);
	return {
		url: (hash: string | undefined) => studio.url(hash),
		render: async (...args: Parameters<typeof render>) => {
			const hash = await render(...args);
			rendered.push(hash);
			return hash;
		},
		draw: async () => "a".repeat(64),
		edit: async () => "b".repeat(64),
	};
}

const pictureExists = (hash: string | undefined) =>
	hash !== undefined && existsSync(join(dir, `${hash}.png`));

describeDb("agent characters", () => {
	useTeamFixture({ studio: realStudio });

	const create = (name: string, displayName: string, prompt: string) =>
		duringTurn(() =>
			fx.team.create(COORDINATOR, {
				name,
				displayName,
				prompt,
				task: "Say hi.",
			}),
		).then(() => settle());

	test("an agent created without a character gets the one its role suggests and a picture", async () => {
		await create("rev", "Reviewer", "review code");
		const agent = fx.store.agent("rev");
		expect(agent?.character?.class).toBe("knight");
		expect(pictureExists(agent?.avatarHash)).toBe(true);
	});

	test("a given class or palette is kept, and the rest comes from the role", async () => {
		await duringTurn(() =>
			fx.team.create(COORDINATOR, {
				name: "rev",
				displayName: "Reviewer",
				prompt: "review code",
				character: { palette: "vert" },
				task: "Say hi.",
			}),
		);
		const character = fx.store.agent("rev")?.character;
		expect(character?.class).toBe("knight");
		expect(character?.colors).toEqual(CATALOG.palettes.vert);
	});

	test("dress keeps the class, changes the colors and the picture, and tells onChange", async () => {
		await create("rev", "Reviewer", "review code");
		const before = fx.store.agent("rev");
		const other = before?.character?.palette === "vert" ? "gules" : "vert";
		let changes = 0;
		fx.team.onChange(() => changes++);
		const dressed = await fx.team.dress("rev", { palette: other });
		expect(dressed.character?.class).toBe("knight");
		expect(dressed.character?.colors).toEqual(CATALOG.palettes[other]);
		expect(dressed.avatarHash).not.toBe(before?.avatarHash);
		expect(pictureExists(dressed.avatarHash)).toBe(true);
		expect(fx.store.agent("rev")?.character).toEqual(dressed.character);
		expect(changes).toBeGreaterThan(0);
	});

	test("a new class alone keeps the agent's colors, a palette with it replaces them", async () => {
		await create("rev", "Reviewer", "review code");
		const before = fx.store.agent("rev")?.character;
		if (!before) throw new Error("not dressed");
		const sage = await fx.team.dress("rev", { class: "scholar" });
		expect(sage.character?.class).toBe("scholar");
		expect(sage.character?.colors).toEqual(before.colors);
		expect(sage.character?.hat).toBe(
			resolveCharacter({ class: "scholar" }).hat,
		);
		const teal = await fx.team.dress("rev", {
			class: "monk",
			palette: "teal",
		});
		expect(teal.character?.colors).toEqual(CATALOG.palettes.teal);
	});

	test("dress with an unknown part is an AgentError that names the field", async () => {
		await create("rev", "Reviewer", "review code");
		const error = await fx.team
			.dress("rev", { hat: "crown" } as never)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AgentError);
		expect((error as Error).message).toContain("hat");
		expect(fx.store.agent("rev")?.character?.hat).not.toBe("crown");
		await expect(
			fx.team.dress("ghost", { class: "monk" }),
		).rejects.toBeInstanceOf(AgentError);
	});

	test("at start a pre-migration row gets its seed's character, or a suggestion, and a second start changes nothing", async () => {
		// The seeds were dressed at the fixture's start: the coordinator took its seed's look.
		const coordinator = fx.store.agent("coordinator");
		expect(coordinator?.character).toEqual(
			resolveCharacter({ class: "navigator", palette: "amber" }),
		);
		expect(pictureExists(coordinator?.avatarHash)).toBe(true);
		// A row from before the migration: a drawn hash and no character.
		const drawn = "f".repeat(64);
		await fx.store.createAgent({
			name: "old",
			displayName: "Reviewer",
			prompt: "review code",
			avatarHash: drawn,
		});
		expect(fx.store.agent("old")?.character).toBeUndefined();
		await fx.team.start();
		await settle();
		const old = fx.store.agent("old");
		expect(old?.character?.class).toBe("knight");
		expect(old?.avatarHash).not.toBe(drawn);
		expect(pictureExists(old?.avatarHash)).toBe(true);
		// The suggestion avoids the palettes the seeds already wear.
		for (const seeded of ["coordinator", "doctor", "infra"])
			expect(old?.character?.palette).not.toBe(
				fx.store.agent(seeded)?.character?.palette,
			);
		const snapshot = JSON.stringify(
			fx.store.agents().map((a) => [a.name, a.character, a.avatarHash]),
		);
		const renders = rendered.length;
		await fx.team.start();
		await settle();
		expect(rendered.length).toBe(renders);
		expect(
			JSON.stringify(
				fx.store.agents().map((a) => [a.name, a.character, a.avatarHash]),
			),
		).toBe(snapshot);
		// An agent read before the team dressed it falls back to its role's suggestion.
		const bare = { name: "x", displayName: "Reviewer", prompt: "review code" };
		expect(characterOf(bare)).toEqual(suggestCharacter(bare));
		if (old?.character) expect(characterOf(old)).toEqual(old.character);
	});
});
