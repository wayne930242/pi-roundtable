import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillRegistry } from "pi-roundtable";

// Skills for the Skills page: one with long values, a long line, and a long code line, so a
// document dialog can be checked for wrapping and for scrolling inside the code block.
export const SKILL_CATALOG = [
	{
		name: "code-review",
		source: { kind: "builtin" as const },
		description: "Review a change set for correctness, security and style.",
		groups: [],
		carriers: [],
	},
	{
		name: "deploy-notes",
		source: { kind: "written" as const },
		description: "Write release notes from merged changes.",
		groups: ["release"],
		carriers: ["guide"],
	},
];
export const SKILL_DOCUMENTS: Record<
	string,
	{ frontmatter: Record<string, unknown>; body: string }
> = {
	"code-review": {
		frontmatter: {
			name: "code-review",
			description:
				"Use when reviewing a diff, a pull request or a commit range: read the change, run its tests, and report findings by severity with the file and line each one points to, rather than a general impression of the whole change.",
			license: "MIT",
			metadata: { version: "1.4.0", tags: ["review", "quality", "security"] },
		},
		body: `# Code review

Read the change before reading the code around it. A review answers one question: **is this change safe to merge?**

## Steps

1. List the files the change touches and group them by purpose.
2. Run the tests the change claims to cover, and the ones it forgot.
3. Read each hunk. For every finding note the file, the line, and why it matters.

## Severity

- **P0** breaks the build or loses data.
- **P1** a defect a user can reach.
- **P2** style, naming, a missing test.

> A finding without a line number is an opinion, not a finding.

\`\`\`ts
// A long line, to see the block scroll sideways rather than the dialog: the review reports every finding it makes with its file, line and severity.
export function report(findings: Finding[]): string { return findings.map((f) => \`\${f.severity} \${f.file}:\${f.line} \${f.text}\`).join("\\n"); }
\`\`\`

| Severity | Blocks merge |
| --- | --- |
| P0 | yes |
| P1 | yes |
| P2 | no |

Finish with a one-line verdict.`,
	},
	"deploy-notes": {
		frontmatter: {
			name: "deploy-notes",
			description:
				"Use when writing release notes from the changes merged since the last release.",
		},
		body: "Group the merged changes by area, then write one line for each.\n\n- Fixes first\n- Then features",
	},
};

/** The Skills pane's feature port over the host's own registry, so what the pane lists is what the editor opens and saves. */
export const registrySkills = (registry: SkillRegistry) => ({
	catalog: () => registry.catalog().map(({ file: _file, ...entry }) => entry),
	read: async (name: string) => {
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
			(await registry.document(name)).text,
		);
		return { frontmatter, body };
	},
});
