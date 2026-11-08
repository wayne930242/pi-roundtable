import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dir = resolve(root, ".github/workflows");
const workflows = readdirSync(dir)
	.filter((name) => name.endsWith(".yml"))
	.map((name) => ({ name, text: readFileSync(resolve(dir, name), "utf8") }));
const checking = workflows.filter(({ name }) =>
	["ci.yml", "pi-canary.yml", "publish.yml"].includes(name),
);
const action = (name: string) =>
	readFileSync(resolve(root, ".github/actions", name, "action.yml"), "utf8");

// A bun download from GitHub releases failed a tag's publish with a 504; the npm registry is a second origin.
test("bun comes from npm first, and setup-bun is only the local action's fallback", () => {
	for (const { name, text } of checking) {
		expect(text, name).not.toContain("oven-sh/setup-bun");
		expect(text, name).toContain("./.github/actions/setup-bun");
	}
	const setup = action("setup-bun");
	expect(setup).toContain("npm install");
	expect(setup).toContain("oven-sh/setup-bun@");
	expect(setup).toMatch(/steps\.npm\.outcome == 'failure'/);
});

// canvas downloads its prebuilt binary from GitHub releases without a retry, and node-gyp then fails without headers.
test("every bun install retries through the local install action", () => {
	for (const { name, text } of checking) {
		expect(text, name).not.toMatch(/^\s*(- )?run: bun install/m);
		expect(text, name).toContain("./.github/actions/install");
	}
	const install = action("install");
	expect(install).toMatch(/for attempt in/);
	expect(install).toContain("bun install");
});

test("the canvas prebuilt is cached where a cache cannot reach a job that publishes", () => {
	for (const name of ["ci.yml", "pi-canary.yml"])
		expect(workflows.find((w) => w.name === name)?.text, name).toContain(
			"cache: true",
		);
	for (const name of ["publish.yml"]) {
		const text = workflows.find((w) => w.name === name)?.text ?? "";
		expect(text, name).not.toContain("cache: true");
		expect(text, name).toContain("id-token: write");
	}
	const install = action("install");
	expect(install).toContain("~/.npm/_prebuilds");
	expect(install).toMatch(/inputs\.cache == 'true'/);
});

test("the prebuilt install needs no apt packages", () => {
	for (const { name, text } of workflows)
		expect(text, name).not.toContain("apt-get");
});
