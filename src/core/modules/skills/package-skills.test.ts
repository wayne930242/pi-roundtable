import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginError } from "../../errors.ts";
import { discoverPackageSkills } from "./package-skills.ts";
import { installPackage, packageDirIn } from "./package-skills-fixture.ts";

const roots: string[] = [];
const host = () => {
	const root = mkdtempSync(join(tmpdir(), "roundtable-package-skills-"));
	roots.push(root);
	return root;
};
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const failure = (run: () => unknown): string => {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(PluginError);
		return (error as Error).message;
	}
	throw new Error("expected a PluginError");
};

describe("discoverPackageSkills", () => {
	test("reads every skill under the pi.skills folders, named by its frontmatter and sorted", () => {
		const root = host();
		installPackage(root, "pi-aaaav", {
			coding: "Use when changing code.",
			grilling: "Use when deciding.",
		});
		const found = discoverPackageSkills(["pi-aaaav"], packageDirIn(root));
		expect(found.map((s) => [s.name, s.package])).toEqual([
			["coding", "pi-aaaav"],
			["grilling", "pi-aaaav"],
		]);
		expect(found[0]?.file).toEndWith(
			join("node_modules", "pi-aaaav", "skills", "coding", "SKILL.md"),
		);
	});

	test("no packages offer no skills", () => {
		expect(discoverPackageSkills([])).toEqual([]);
	});

	test("a package that is not installed stops with the fix", () => {
		const message = failure(() =>
			discoverPackageSkills(["pi-missing"], packageDirIn(host())),
		);
		expect(message).toContain('"pi-missing" is not installed');
		expect(message).toContain("skills.packages");
	});

	test("a package without pi.skills stops with the fix", () => {
		const root = host();
		installPackage(root, "pi-plain", { a: "Use when a." }, { pi: {} });
		const message = failure(() =>
			discoverPackageSkills(["pi-plain"], packageDirIn(root)),
		);
		expect(message).toContain('"pi-plain" lists no skills');
	});

	test("a pi.skills path that is missing or outside the package stops", () => {
		const root = host();
		installPackage(root, "pi-gone", {}, { pi: { skills: ["./nowhere"] } });
		expect(
			failure(() => discoverPackageSkills(["pi-gone"], packageDirIn(root))),
		).toContain("not in the installed package");
		installPackage(root, "pi-escape", {}, { pi: { skills: ["../other"] } });
		expect(
			failure(() => discoverPackageSkills(["pi-escape"], packageDirIn(root))),
		).toContain("outside the package");
	});

	test("a package whose folders hold no SKILL.md stops", () => {
		const root = host();
		installPackage(root, "pi-empty", {});
		mkdirSync(join(root, "node_modules/pi-empty/skills"), { recursive: true });
		expect(
			failure(() => discoverPackageSkills(["pi-empty"], packageDirIn(root))),
		).toContain("no SKILL.md");
	});

	test("two packages offering one name stop", () => {
		const root = host();
		installPackage(root, "pi-one", { coding: "Use when one." });
		installPackage(root, "pi-two", { coding: "Use when two." });
		const message = failure(() =>
			discoverPackageSkills(["pi-one", "pi-two"], packageDirIn(root)),
		);
		expect(message).toContain('"coding" comes from both "pi-one" and "pi-two"');
	});

	test("a built-in name stops", () => {
		const root = host();
		installPackage(root, "pi-shadow", { "writing-skills": "Use when x." });
		expect(
			failure(() => discoverPackageSkills(["pi-shadow"], packageDirIn(root))),
		).toContain("built-in");
	});

	test("an unreadable skill file names the file", () => {
		const root = host();
		installPackage(root, "pi-bad", { good: "Use when good." });
		writeFileSync(
			join(root, "node_modules/pi-bad/skills/good/SKILL.md"),
			"---\nname: good\n---\n",
		);
		expect(
			failure(() => discoverPackageSkills(["pi-bad"], packageDirIn(root))),
		).toContain(join("skills", "good", "SKILL.md"));
	});
});
