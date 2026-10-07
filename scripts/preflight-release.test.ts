import { expect, test } from "bun:test";
import { ReleaseContractError } from "./check-release.ts";
import {
	checkPack,
	firstPublicationNeeded,
	registryName,
} from "./preflight-release.ts";

const pkg = { name: "pi-roundtable-web", path: "packages/web" };
const paths = [
	"package.json",
	"README.md",
	"LICENSE",
	"src/index.ts",
	"dist/index.html",
	"dist/page.js",
	"dist/page.css",
];

function report(files = paths, name = pkg.name): string {
	return JSON.stringify(
		[{ name, version: "0.8.0", files: files.map((path) => ({ path })) }],
		null,
		2,
	);
}

test("accepts npm JSON even when web prepack writes build output first", () => {
	expect(() =>
		checkPack(`dist/page.js\ndist/index.html\n${report()}`, pkg, "0.8.0"),
	).not.toThrow();
});

test("accepts npm 12's report keyed by package name, after prepack output", () => {
	const keyed = JSON.stringify(
		{
			[pkg.name]: {
				name: pkg.name,
				version: "0.8.0",
				files: paths.map((path) => ({ path })),
			},
		},
		null,
		2,
	);
	expect(() =>
		checkPack(`dist/page.js\ndist/index.html\n${keyed}`, pkg, "0.8.0"),
	).not.toThrow();
	expect(() => checkPack(keyed, pkg, "0.9.0")).toThrow(ReleaseContractError);
});

test("reads the registry name from npm 11's string and npm 12's one-element array", () => {
	expect(registryName(`"${pkg.name}"`, pkg)).toBe(pkg.name);
	expect(registryName(`[\n  "${pkg.name}"\n]`, pkg)).toBe(pkg.name);
	expect(registryName(`["a", "b"]`, pkg)).not.toBe(pkg.name);
	expect(() => registryName("not-json", pkg)).toThrow(ReleaseContractError);
});

test("refuses a web tarball missing the page or either bundle", () => {
	for (const missing of ["dist/index.html", "dist/page.js", "dist/page.css"])
		expect(() =>
			checkPack(report(paths.filter((path) => path !== missing)), pkg, "0.8.0"),
		).toThrow(ReleaseContractError);
});

test("refuses pack identity/version mismatch or unreadable pack output", () => {
	for (const output of [report(paths, "pi-roundtable-coding"), "not-json"])
		expect(() => checkPack(output, pkg, "0.8.0")).toThrow(ReleaseContractError);
	expect(() => checkPack(report(), pkg, "0.9.0")).toThrow(ReleaseContractError);
});

test("drawing must pack its font and font license", () => {
	const drawing = { name: "pi-roundtable-drawing", path: "packages/drawing" };
	const files = [
		"package.json",
		"README.md",
		"LICENSE",
		"src/index.ts",
		"fonts/NotoSansTC-Bold.otf",
		"fonts/OFL.txt",
	];
	expect(() =>
		checkPack(report(files, drawing.name), drawing, "0.8.0"),
	).not.toThrow();
	expect(() =>
		checkPack(report(files.slice(0, -1), drawing.name), drawing, "0.8.0"),
	).toThrow("fonts/OFL.txt");
});

for (const name of ["mcp", "sandbox"]) {
	test(`${name} must pack its entry and sandbox must pack its complete worker`, () => {
		const pkg = { name: `pi-roundtable-${name}`, path: `packages/${name}` };
		const files = ["package.json", "README.md", "LICENSE", "src/index.ts"];
		if (name === "sandbox")
			files.push(
				"src/protocol.ts",
				"worker/Dockerfile",
				"worker/main.ts",
				"worker/agent.ts",
				"worker/memory.ts",
				"worker/transport.ts",
			);
		expect(() =>
			checkPack(report(files, pkg.name), pkg, "0.8.0"),
		).not.toThrow();
		for (const missing of files.slice(3))
			expect(() =>
				checkPack(
					report(
						files.filter((file) => file !== missing),
						pkg.name,
					),
					pkg,
					"0.8.0",
				),
			).toThrow(missing);
	});
}

test("a package missing from npm is refused with the steps of its manual first publication", () => {
	const error = firstPublicationNeeded("pi-roundtable-webchat");
	expect(error).toBeInstanceOf(ReleaseContractError);
	expect(error.message).toContain(
		"pi-roundtable-webchat needs its manual first publication before a lockstep tag",
	);
	expect(error.message).toContain(
		".github/PACKAGE-RELEASES.md#webchats-first-publication",
	);
});
