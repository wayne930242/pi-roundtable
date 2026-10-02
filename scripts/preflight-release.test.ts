import { expect, test } from "bun:test";
import { ReleaseContractError } from "./check-release.ts";
import { checkPack } from "./preflight-release.ts";

const pkg = { name: "pi-roundtable-web", path: "packages/web" };
const paths = [
	"package.json",
	"README.md",
	"LICENSE",
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
