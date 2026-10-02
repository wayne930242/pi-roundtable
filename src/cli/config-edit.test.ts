import { describe, expect, test } from "bun:test";
import { addPluginToConfig, ConfigEditError } from "./config-edit.ts";

const notes = { name: "my-notes", ident: "myNotes" };
const edit = (source: string) => addPluginToConfig(source, notes);
const refusal = (source: string): string => {
	try {
		edit(source);
	} catch (error) {
		if (error instanceof ConfigEditError) return error.message;
		throw error;
	}
	return "";
};

describe("addPluginToConfig", () => {
	test("adds the import after the imports and the entry after the last one", () => {
		const source = `import type { Config } from "node:fs";
import { hello } from "./plugins/hello.ts";

export default {
	name: "Bot",
	plugins: [hello],
} satisfies Config;
`;
		expect(edit(source)).toBe(`import type { Config } from "node:fs";
import { hello } from "./plugins/hello.ts";
import { myNotes } from "./plugins/my-notes.ts";

export default {
	name: "Bot",
	plugins: [hello, myNotes],
} satisfies Config;
`);
	});

	test("puts the import in sorted place among the relative imports", () => {
		const source = `import { agents } from "./agents.ts";
import { hello } from "./plugins/hello.ts";
import { zed } from "./plugins/zed.ts";

export default { plugins: [hello, zed] };
`;
		const lines = edit(source).split("\n");
		expect(lines.slice(0, 4)).toEqual([
			'import { agents } from "./agents.ts";',
			'import { hello } from "./plugins/hello.ts";',
			'import { myNotes } from "./plugins/my-notes.ts";',
			'import { zed } from "./plugins/zed.ts";',
		]);
	});

	test("keeps a multi-line list's layout, with or without a trailing comma", () => {
		const bare = `import { a } from "./plugins/a.ts";
export default {
	plugins: [
		a,
	],
};
`;
		expect(edit(bare)).toContain("\t\ta,\n\t\tmyNotes,\n\t],");
		const noComma = bare.replace("a,\n\t]", "a\n\t]");
		expect(edit(noComma)).toContain("\t\ta,\n\t\tmyNotes\n\t],");
	});

	test("puts a one-line list one element a line once the line would pass 80 columns, as the formatter does", () => {
		// `\tplugins: [<name>, myNotes],` is the name's length plus 23 columns, a tab counting as 2.
		const config = (name: string) => `export default {
	plugins: [${name}],
};
`;
		const fits = "a".repeat(57);
		expect(edit(config(fits))).toContain(`\tplugins: [${fits}, myNotes],\n`);
		const over = "a".repeat(58);
		expect(edit(config(over))).toContain(
			`\tplugins: [\n\t\t${over},\n\t\tmyNotes,\n\t],\n`,
		);
		// A list holding a comment keeps its line; the formatter's verdict on it is left to the owner.
		const commented = config(`${over} /* keep */`);
		expect(edit(commented)).toContain(`${over}, myNotes /* keep */],`);
	});

	test("fills an empty list and adds the import to a file without imports", () => {
		const edited = edit("export default { plugins: [] };\n");
		expect(edited).toBe(
			'import { myNotes } from "./plugins/my-notes.ts";\n\nexport default { plugins: [myNotes] };\n',
		);
	});

	test("finds the list under as, satisfies, parentheses, and a named constant", () => {
		for (const source of [
			"export default { plugins: [a] } as const;",
			"export default ({ plugins: [a] });",
			"export default { plugins: [a] as Plugin[] };",
			"const config = { plugins: [a] } satisfies X;\nexport default config;",
			'export default { "plugins": [a] };',
		])
			expect(edit(source)).toContain("a, myNotes]");
	});

	test("leaves comments and every other byte as they were", () => {
		const source = `// the bot
import { a } from "./plugins/a.ts";

export default {
	// who
	owner: { id: "1" },
	plugins: [a /* first */], // done
};
`;
		const edited = edit(source);
		expect(edited).toContain("// the bot");
		expect(edited).toContain("// who");
		// The entry goes right after the last element, before anything that follows it on the line.
		expect(edited).toContain("plugins: [a, myNotes /* first */], // done");
	});

	test("refuses a default export with no plugin list, naming the file and what to add", () => {
		for (const source of [
			"export default { name: 'x' };",
			"export default { plugins: somePlugins };",
			"export default makeConfig();",
			"export const config = { plugins: [] };",
			"export default { other: { plugins: [] } };",
		]) {
			const text = refusal(source);
			expect(text).toContain("roundtable.config.ts");
			expect(text).toContain("cannot find the plugin list");
			expect(text).toContain('import { myNotes } from "./plugins/my-notes.ts"');
		}
	});

	test("refuses a name the file already uses, and a plugin already listed", () => {
		expect(
			refusal(
				'import { myNotes } from "./plugins/my-notes.ts";\nexport default { plugins: [myNotes] };',
			),
		).toContain("myNotes is already used");
		expect(
			refusal("const myNotes = 1;\nexport default { plugins: [] };"),
		).toContain("already used");
	});

	test("refuses a file that does not parse and says so", () => {
		expect(refusal("export default { plugins: [ ")).toContain("does not parse");
	});
});
