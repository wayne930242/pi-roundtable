import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { unixBrokerRequest } from "../worker/transport.ts";
import { SandboxRuntime, type SandboxRuntimeOptions } from "./runtime.ts";
import { resolveSandboxRuntimeOptions } from "./runtime-options.ts";
import { loadSealedSkills } from "./skills.ts";

const speaker = { id: "guest", name: "Guest", principalId: "p_guest" };

function skill(
	dir: string,
	name: string,
	description = "Reads cards",
	body = "Body.",
	extra = "",
) {
	const folder = join(dir, name);
	mkdirSync(folder, { recursive: true });
	writeFileSync(
		join(folder, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`,
	);
	return folder;
}

function tree(): { root: string; dir: string } {
	const root = mkdtempSync("/tmp/sb-skills-");
	const dir = join(root, "skills");
	mkdirSync(dir);
	return { root, dir };
}

test("a skills directory loads each folder's name and description into an index", () => {
	const { root, dir } = tree();
	try {
		skill(dir, "tarot-reading", "Draw and read tarot cards");
		skill(dir, "magick", "Ritual   practice and   theory");
		const loaded = loadSealedSkills([dir]);
		expect(loaded.skills.map((entry) => entry.name)).toEqual([
			"magick",
			"tarot-reading",
		]);
		expect(loaded.index).toContain("host_read_skill");
		expect(loaded.index).toContain("- magick: Ritual practice and theory");
		expect(loaded.index).toContain(
			"- tarot-reading: Draw and read tarot cards",
		);
		// The index is one sentence plus the list; nothing else.
		expect(
			loaded.index.split("\n").filter((line) => !line.startsWith("- ")).length,
		).toBeLessThanOrEqual(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	[
		"a missing directory",
		(_dir: string, root: string) => [join(root, "nope")],
		"nope",
	],
	["a relative directory", () => ["skills"], "absolute"],
	[
		"a folder without SKILL.md",
		(dir: string) => {
			mkdirSync(join(dir, "empty"));
			return [dir];
		},
		"empty",
	],
	[
		"no frontmatter",
		(dir: string) => {
			mkdirSync(join(dir, "plain"));
			writeFileSync(join(dir, "plain/SKILL.md"), "Just text");
			return [dir];
		},
		"plain",
	],
	[
		"a name that differs from the folder",
		(dir: string) => {
			mkdirSync(join(dir, "folder"));
			writeFileSync(
				join(dir, "folder/SKILL.md"),
				"---\nname: other\ndescription: d\n---\nx",
			);
			return [dir];
		},
		"folder",
	],
	[
		"a missing description",
		(dir: string) => {
			mkdirSync(join(dir, "nodesc"));
			writeFileSync(join(dir, "nodesc/SKILL.md"), "---\nname: nodesc\n---\nx");
			return [dir];
		},
		"description",
	],
	[
		"broken frontmatter",
		(dir: string) => {
			mkdirSync(join(dir, "broken"));
			writeFileSync(join(dir, "broken/SKILL.md"), "---\nname: [broken\n---\nx");
			return [dir];
		},
		"broken",
	],
	[
		"an unterminated frontmatter",
		(dir: string) => {
			mkdirSync(join(dir, "open"));
			writeFileSync(
				join(dir, "open/SKILL.md"),
				"---\nname: open\ndescription: d\n",
			);
			return [dir];
		},
		"open",
	],
])("%s stops startup", (_name, prepare, mention) => {
	const { root, dir } = tree();
	try {
		expect(() => loadSealedSkills(prepare(dir, root))).toThrow(mention);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("two skills of one name stop startup naming both paths", () => {
	const { root, dir } = tree();
	const other = join(root, "more");
	mkdirSync(other);
	try {
		skill(dir, "magick");
		skill(other, "magick");
		expect(() => loadSealedSkills([dir, other])).toThrow(
			new RegExp(`${join(dir, "magick")}.*${join(other, "magick")}`, "s"),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function options(
	root: string,
	extra: Partial<SandboxRuntimeOptions> = {},
): SandboxRuntimeOptions {
	return {
		image: "sandbox:fake",
		runRoot: join(root, "run"),
		workspaceRoot: join(root, "work"),
		model: "fake",
		modelUrl: "https://models.example/chat",
		apiKey: () => "k",
		driver: { run: async () => ({ ok: true, text: "done" }) },
		...extra,
	};
}

test("a configured host tool named read_skill stops startup", () => {
	const { root, dir } = tree();
	try {
		skill(dir, "magick");
		expect(() =>
			resolveSandboxRuntimeOptions(
				options(root, {
					skills: [dir],
					tools: [
						{
							name: "read_skill",
							description: "x",
							parameters: { type: "object" },
							run: () => "",
						},
					],
				}),
			),
		).toThrow("read_skill");
		// Without skills the name is free, as before.
		resolveSandboxRuntimeOptions(
			options(root, {
				tools: [
					{
						name: "read_skill",
						description: "x",
						parameters: { type: "object" },
						run: () => "",
					},
				],
			}),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the prompt and the skill index share promptBytes, and startup names both sizes", () => {
	const { root, dir } = tree();
	try {
		skill(dir, "magick", "x".repeat(300));
		const loaded = loadSealedSkills([dir]);
		const indexBytes = Buffer.byteLength(JSON.stringify(loaded.index));
		const prompt = "p".repeat(1000);
		const total = Buffer.byteLength(
			JSON.stringify(`${prompt}\n\n${loaded.index}`),
		);
		expect(() =>
			resolveSandboxRuntimeOptions(
				options(root, {
					skills: [dir],
					prompt,
					budgets: { promptBytes: total - 1 },
				}),
			),
		).toThrow(
			new RegExp(
				`prompt.*1002.*skill index.*${indexBytes}.*${total}.*${total - 1}`,
				"s",
			),
		);
		const resolved = resolveSandboxRuntimeOptions(
			options(root, { skills: [dir], prompt, budgets: { promptBytes: total } }),
		);
		expect(resolved.prompt).toBe(`${prompt}\n\n${loaded.index}`);
		// The default 8,192 applies once skills are set, so an oversized prompt no longer passes silently.
		expect(() =>
			resolveSandboxRuntimeOptions(
				options(root, { skills: [dir], prompt: "p".repeat(9000) }),
			),
		).toThrow("8192");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the turn carries the index in its prompt and read_skill among its tools; the model sees host_read_skill", async () => {
	const { root, dir } = tree();
	const seen: { prompt: string; tools: string[] }[] = [];
	try {
		skill(dir, "magick", "Ritual practice");
		const runtime = new SandboxRuntime(
			options(root, {
				skills: [dir],
				prompt: "You are Heilun.",
				driver: {
					run: async (_spec, turn) => {
						seen.push({
							prompt: turn.prompt,
							tools: turn.tools.map((tool) => tool.name),
						});
						return { ok: true, text: "done" };
					},
				},
			}),
		);
		await runtime.runTurn("fake:a", speaker, "a");
		await runtime.dispose();
		expect(seen[0]?.prompt.startsWith("You are Heilun.")).toBe(true);
		expect(
			seen[0]?.prompt.trimEnd().endsWith("- magick: Ritual practice"),
		).toBe(true);
		expect(seen[0]?.tools).toEqual(["read_skill"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

async function readSkill(
	root: string,
	dir: string,
	input: Record<string, unknown>,
	toolResultBytes?: number,
) {
	let body: { text?: string } = {};
	const runtime = new SandboxRuntime(
		options(root, {
			skills: [dir],
			...(toolResultBytes ? { budgets: { toolResultBytes } } : {}),
			driver: {
				run: async (spec) => {
					body = (
						await unixBrokerRequest(
							"/tools/read_skill",
							input,
							join(spec.runDir, "broker.sock"),
						)
					).body as { text?: string };
					return { ok: true, text: "done" };
				},
			},
		}),
	);
	await runtime.runTurn("fake:a", speaker, "a");
	await runtime.dispose();
	return body.text ?? "";
}

test("host_read_skill returns SKILL.md, a file inside the folder, and another skill's file by its name", async () => {
	const { root, dir } = tree();
	try {
		const folder = skill(dir, "tarot-reading", "Cards", "Draw three cards.");
		skill(dir, "magick", "Ritual", "Banish first.");
		mkdirSync(join(folder, "ref"));
		writeFileSync(join(folder, "ref/spreads.md"), "Celtic cross");
		expect(await readSkill(root, dir, { name: "tarot-reading" })).toContain(
			"Draw three cards.",
		);
		expect(
			await readSkill(root, dir, {
				name: "tarot-reading",
				path: "ref/spreads.md",
			}),
		).toBe("Celtic cross");
		expect(await readSkill(root, dir, { name: "magick" })).toContain(
			"Banish first.",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host_read_skill refuses paths outside the skill's folder, links out of it, and unknown skills", async () => {
	const { root, dir } = tree();
	try {
		const folder = skill(dir, "tarot-reading");
		skill(dir, "magick", "Ritual", "Secret ritual.");
		writeFileSync(join(root, "outside.txt"), "outside");
		symlinkSync(join(root, "outside.txt"), join(folder, "leak.md"));
		symlinkSync(join(dir, "magick", "SKILL.md"), join(folder, "other.md"));
		for (const path of [
			"../magick/SKILL.md",
			"/etc/passwd",
			"ref//x",
			"a/../../magick/SKILL.md",
			"",
			"leak.md",
			"other.md",
			"nope.md",
			".",
		])
			expect(
				await readSkill(root, dir, { name: "tarot-reading", path }),
			).toStartWith("Error:");
		expect(await readSkill(root, dir, { name: "nope" })).toStartWith("Error:");
		expect(
			await readSkill(root, dir, { name: "../tarot-reading" }),
		).toStartWith("Error:");
		expect(await readSkill(root, dir, {})).toStartWith("Error:");
		expect(
			await readSkill(root, dir, { name: "tarot-reading", offset: -3 }),
		).toStartWith("Error:");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host_read_skill pages within the result allowance, first line naming the next offset", async () => {
	const { root, dir } = tree();
	try {
		skill(dir, "long", "Long skill", "字".repeat(3000));
		const budget = 1000;
		let offset = 0;
		let text = "";
		for (let guard = 0; guard < 50; guard++) {
			const page = await readSkill(root, dir, { name: "long", offset }, budget);
			expect(page.length).toBeGreaterThan(0);
			const [first = "", ...rest] = page.split("\n");
			const next = /^\[More: next offset (\d+)\]$/.exec(first);
			text += next ? rest.join("\n") : page;
			if (!next) break;
			offset = Number(next[1]);
		}
		expect(text).toContain("字".repeat(3000));
		expect(text.startsWith("---\nname: long")).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
