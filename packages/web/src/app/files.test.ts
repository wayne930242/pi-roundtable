import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Authenticated } from "../auth/authenticator.ts";
import { FileApi } from "./file-routes.ts";
import { FileDir, fileResponse, safeName } from "./files.ts";

test("RV-F006: a file name in the download header is percent-encoded to the characters RFC 5987 allows", () => {
	const meta = { id: "i", name: "a(b)*'c d.txt", type: "text/plain", size: 1 };
	const header =
		fileResponse(meta, new Blob(["x"])).headers.get("content-disposition") ??
		"";
	expect(header).toBe("attachment; filename*=UTF-8''a%28b%29%2A%27c%20d.txt");
	for (const char of ["(", ")", "*", "'"])
		expect(header.slice(header.indexOf("''") + 2)).not.toContain(char);
	// Non-ASCII stays encoded as before.
	expect(
		fileResponse(
			{ ...meta, name: "\u6a94\u6848.md" },
			new Blob(["x"]),
		).headers.get("content-disposition"),
	).toBe("attachment; filename*=UTF-8''%E6%AA%94%E6%A1%88.md");
});

test("RV-F006: a file name loses the bidirectional controls that make 'invoice\\u202Egpj.exe' read as something else", () => {
	expect(safeName("invoice\u202Egpj.exe")).toBe("invoicegpj.exe");
	expect(safeName("a\u2066b\u2069c\u202Ad\u202C.txt")).toBe("abcd.txt");
	expect(safeName("\u202E")).toBe("file");
	// Ordinary right-to-left text is not touched.
	expect(safeName("שלום.txt")).toBe("שלום.txt");
});

const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg"><style>@keyframes a{}</style></svg>';
const SVG_POLICY =
	"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'";

test("an SVG is served inline as image/svg+xml, sandboxed with no script, and nosniff", () => {
	const meta = {
		id: "i",
		name: "comp.svg",
		type: "image/svg+xml",
		size: SVG.length,
	};
	const response = fileResponse(meta, new Blob([SVG]), "image");
	expect(response.headers.get("content-type")).toBe("image/svg+xml");
	expect(response.headers.get("content-disposition")).toBe("inline");
	expect(response.headers.get("content-security-policy")).toBe(SVG_POLICY);
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response.headers.get("vary")).toBe("sec-fetch-dest");
	// Opened by its own address, the page may not run script: the sandbox has no allow-scripts.
	expect(response.headers.get("content-security-policy")).not.toContain(
		"allow-",
	);
	expect(response.headers.get("content-security-policy")).not.toContain(
		"script-src",
	);
});

test("an SVG opened as a document or with no fetch destination is a download, still under its policy", () => {
	const meta = { id: "i", name: "a b.svg", type: "image/svg+xml", size: 1 };
	for (const dest of ["document", "iframe", null, undefined]) {
		const response = fileResponse(meta, new Blob([SVG]), dest);
		expect(response.headers.get("content-type")).toBe(
			"application/octet-stream",
		);
		expect(response.headers.get("content-disposition")).toBe(
			"attachment; filename*=UTF-8''a%20b.svg",
		);
		expect(response.headers.get("content-security-policy")).toBe(SVG_POLICY);
		expect(response.headers.get("vary")).toBe("sec-fetch-dest");
	}
});

test("the other types are served as before: a raster inline under a bare sandbox, the rest a download", async () => {
	const png = fileResponse(
		{ id: "i", name: "a.png", type: "image/png", size: 1 },
		new Blob(["x"]),
	);
	expect(png.headers.get("content-type")).toBe("image/png");
	expect(png.headers.get("content-disposition")).toBe("inline");
	expect(png.headers.get("content-security-policy")).toBe("sandbox");
	for (const type of [
		"text/html",
		"application/xml",
		"text/xml",
		"image/svg",
	]) {
		const other = fileResponse(
			{ id: "i", name: "a.x", type, size: 1 },
			new Blob(["x"]),
		);
		expect(other.headers.get("content-type")).toBe("application/octet-stream");
		expect(other.headers.get("content-disposition")).toStartWith("attachment");
		expect(other.headers.get("content-security-policy")).toBe("sandbox");
		expect(other.headers.get("x-content-type-options")).toBe("nosniff");
	}
});

test("a stored SVG with a script is served as it is, under the sandbox", async () => {
	const dir = mkdtempSync(join(tmpdir(), "files-svg-"));
	try {
		const files = new FileDir(dir);
		const text =
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
		const stored = files.put(
			"x.svg",
			"image/svg+xml",
			new TextEncoder().encode(text),
		);
		const meta = files.meta(stored.id);
		const blob = files.blob(stored.id);
		if (!meta || !blob) throw new Error("the file was not stored");
		const response = fileResponse(meta, blob, "image");
		expect(await response.text()).toBe(text);
		expect(response.headers.get("content-security-policy")).toBe(SVG_POLICY);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the file route serves a stored SVG inline to an image load and as a download to anything else", async () => {
	const dir = mkdtempSync(join(tmpdir(), "files-route-"));
	try {
		const files = new FileDir(dir);
		const { id } = files.put(
			"x.svg",
			"image/svg+xml",
			new TextEncoder().encode(SVG),
		);
		const api = new FileApi({
			files,
			log: () => {},
		} as unknown as ConstructorParameters<typeof FileApi>[0]);
		const owner = {
			visitor: { id: "owner", tier: "owner" },
		} as unknown as Authenticated;
		const get = (headers: Record<string, string>) =>
			api.file(id, owner, new Request(`http://x/api/files/${id}`, { headers }));
		const image = await get({ "sec-fetch-dest": "image" });
		expect(image.headers.get("content-type")).toBe("image/svg+xml");
		expect(image.headers.get("content-disposition")).toBe("inline");
		const bare = await get({});
		expect(bare.headers.get("content-type")).toBe("application/octet-stream");
		expect(bare.headers.get("content-disposition")).toStartWith("attachment");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
