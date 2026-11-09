import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	base,
	files,
	hex,
	log,
	OWNER,
	outside,
	refused,
	root,
	sandboxPerTest,
	sha,
	untouched,
} from "../testing/workspace-sandbox.ts";
import { WorkspaceFiles } from "./workspace-files.ts";

sandboxPerTest();

const bytesOf = (...parts: (number[] | string)[]): Buffer =>
	Buffer.concat(
		parts.map((part) =>
			typeof part === "string"
				? Buffer.from(part, "latin1")
				: Buffer.from(part),
		),
	);
const PAD = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** One small file of each kind a preview shows, with the bytes that kind starts with. */
const SAMPLES: Record<string, { bytes: Buffer; type: string; kind: string }> = {
	"a.png": {
		bytes: bytesOf([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], PAD),
		type: "image/png",
		kind: "image",
	},
	"a.jpg": {
		bytes: bytesOf([0xff, 0xd8, 0xff, 0xe0], PAD),
		type: "image/jpeg",
		kind: "image",
	},
	"a.jpeg": {
		bytes: bytesOf([0xff, 0xd8, 0xff, 0xe0], PAD),
		type: "image/jpeg",
		kind: "image",
	},
	"a.gif": { bytes: bytesOf("GIF89a", PAD), type: "image/gif", kind: "image" },
	"a.webp": {
		bytes: bytesOf("RIFF", [1, 0, 0, 0], "WEBPVP8 ", PAD),
		type: "image/webp",
		kind: "image",
	},
	"a.avif": {
		bytes: bytesOf([0, 0, 0, 0x1c], "ftypavif", PAD),
		type: "image/avif",
		kind: "image",
	},
	"a.bmp": { bytes: bytesOf("BM", PAD), type: "image/bmp", kind: "image" },
	"a.ico": {
		bytes: bytesOf([0, 0, 1, 0, 1, 0], PAD),
		type: "image/x-icon",
		kind: "image",
	},
	"a.svg": {
		bytes: bytesOf(
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
		),
		type: "image/svg+xml",
		kind: "image",
	},
	"a.pdf": {
		bytes: bytesOf("%PDF-1.7\n", PAD),
		type: "application/pdf",
		kind: "pdf",
	},
	"a.mp3": {
		bytes: bytesOf("ID3", [3, 0, 0, 0, 0, 0, 0], PAD),
		type: "audio/mpeg",
		kind: "audio",
	},
	"a.m4a": {
		bytes: bytesOf([0, 0, 0, 0x20], "ftypM4A ", PAD),
		type: "audio/mp4",
		kind: "audio",
	},
	"a.aac": {
		bytes: bytesOf([0xff, 0xf1, 0x50, 0x80], PAD),
		type: "audio/aac",
		kind: "audio",
	},
	"a.ogg": { bytes: bytesOf("OggS", PAD), type: "audio/ogg", kind: "audio" },
	"a.opus": { bytes: bytesOf("OggS", PAD), type: "audio/ogg", kind: "audio" },
	"a.wav": {
		bytes: bytesOf("RIFF", [1, 0, 0, 0], "WAVEfmt ", PAD),
		type: "audio/wav",
		kind: "audio",
	},
	"a.flac": { bytes: bytesOf("fLaC", PAD), type: "audio/flac", kind: "audio" },
	"a.weba": {
		bytes: bytesOf([0x1a, 0x45, 0xdf, 0xa3], PAD),
		type: "audio/webm",
		kind: "audio",
	},
	"a.mp4": {
		bytes: bytesOf([0, 0, 0, 0x20], "ftypisom", PAD),
		type: "video/mp4",
		kind: "video",
	},
	"a.m4v": {
		bytes: bytesOf([0, 0, 0, 0x20], "ftypM4V ", PAD),
		type: "video/mp4",
		kind: "video",
	},
	"a.mov": {
		bytes: bytesOf([0, 0, 0, 0x14], "ftypqt  ", PAD),
		type: "video/quicktime",
		kind: "video",
	},
	"a.webm": {
		bytes: bytesOf([0x1a, 0x45, 0xdf, 0xa3], PAD),
		type: "video/webm",
		kind: "video",
	},
};

describe("previews of media", () => {
	test("each kind is served with the type the allowlist gives it, inline, and never as something a browser runs", async () => {
		const service = files();
		for (const [name, sample] of Object.entries(SAMPLES)) {
			writeFileSync(join(root, name), sample.bytes);
			const view = await service.read("agents", name);
			expect([name, view.media]).toEqual([name, sample.kind]);
			const response = await service.raw("agents", name, false);
			expect([name, response.headers.get("content-type")]).toEqual([
				name,
				sample.type,
			]);
			expect(response.headers.get("content-disposition")).toBe("inline");
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(response.headers.get("accept-ranges")).toBe("bytes");
			const policy = response.headers.get("content-security-policy") ?? "";
			expect(policy).toContain("default-src 'none'");
			// A PDF is shown by the browser's own viewer, which a sandboxed response would block.
			if (sample.kind === "pdf") expect(policy).not.toContain("sandbox");
			else expect(policy).toStartWith("sandbox;");
			expect(response.headers.get("etag")).toBeTruthy();
			expect(response.headers.get("last-modified")).toBeTruthy();
			expect(Buffer.from(await response.arrayBuffer()).toString("hex")).toBe(
				sample.bytes.toString("hex"),
			);
		}
	});

	test("a script, a page or a style sheet is a download whatever its bytes say, and an extension is not enough", async () => {
		const service = files();
		for (const name of [
			"p.html",
			"p.htm",
			"p.xhtml",
			"p.xml",
			"p.xsl",
			"p.mht",
			"p.js",
			"p.css",
			"p.mjs",
		]) {
			writeFileSync(join(root, name), "<script>alert(1)</script>");
			const response = await service.raw("agents", name, false);
			const type = response.headers.get("content-type") ?? "";
			expect([name, /html|xml|javascript|css|svg/.test(type)]).toEqual([
				name,
				false,
			]);
			expect(response.headers.get("content-disposition")).toStartWith(
				name.endsWith(".js") || name.endsWith(".css") || name.endsWith(".mjs")
					? "inline"
					: "attachment",
			);
			await response.arrayBuffer();
		}
		// A name that claims a type its bytes are not is no preview: the page text it holds is text.
		writeFileSync(join(root, "lie.png"), "<html><script>alert(1)</script>");
		writeFileSync(join(root, "lie.pdf"), "<html>");
		writeFileSync(join(root, "lie.mp4"), "<html>");
		for (const name of ["lie.png", "lie.pdf", "lie.mp4"]) {
			expect((await service.read("agents", name)).media).toBeUndefined();
			const response = await service.raw("agents", name, false);
			expect(response.headers.get("content-type")).toBe(
				"text/plain; charset=utf-8",
			);
			await response.arrayBuffer();
		}
	});

	test("a svg is a picture for <img>, behind a sandbox, and still text to edit", async () => {
		writeFileSync(join(root, "p.svg"), SAMPLES["a.svg"]?.bytes ?? "");
		const service = files();
		const view = await service.read("agents", "p.svg");
		expect(view).toMatchObject({ media: "image", editable: true });
		expect(view.text).toContain("<svg");
		const response = await service.raw("agents", "p.svg", false);
		expect(response.headers.get("content-security-policy")).toContain(
			"sandbox;",
		);
		await response.arrayBuffer();
		const forced = await service.raw("agents", "p.svg", true);
		expect(forced.headers.get("content-disposition")).toStartWith("attachment");
		await forced.arrayBuffer();
	});

	test("a download is an attachment even for a kind that previews", async () => {
		writeFileSync(join(root, "a.mp3"), SAMPLES["a.mp3"]?.bytes ?? "");
		const response = await files().raw("agents", "a.mp3", true);
		expect(response.headers.get("content-disposition")).toStartWith(
			"attachment; filename*=UTF-8''a.mp3",
		);
		await response.arrayBuffer();
	});

	test("a range is answered with 206 and the bytes asked for, or 416 when it starts past the end", async () => {
		const body = bytesOf("ID3", [3, 0, 0, 0, 0, 0, 0], "0123456789");
		writeFileSync(join(root, "a.mp3"), body);
		const service = files();
		const range = async (header: string | undefined) =>
			service.raw("agents", "a.mp3", false, header ? { range: header } : {});
		const first = await range("bytes=0-3");
		expect(first.status).toBe(206);
		expect(first.headers.get("content-range")).toBe(`bytes 0-3/${body.length}`);
		expect(first.headers.get("content-length")).toBe("4");
		expect(hex(await first.arrayBuffer())).toBe(hex(body.subarray(0, 4)));
		const open = await range("bytes=10-");
		expect(open.status).toBe(206);
		expect(open.headers.get("content-range")).toBe(
			`bytes 10-${body.length - 1}/${body.length}`,
		);
		expect(hex(await open.arrayBuffer())).toBe(hex(body.subarray(10)));
		const tail = await range("bytes=-5");
		expect(tail.status).toBe(206);
		expect(hex(await tail.arrayBuffer())).toBe(hex(body.subarray(-5)));
		const clamped = await range(`bytes=5-${body.length + 100}`);
		expect(clamped.headers.get("content-range")).toBe(
			`bytes 5-${body.length - 1}/${body.length}`,
		);
		await clamped.arrayBuffer();
		const past = await range(`bytes=${body.length}-`);
		expect(past.status).toBe(416);
		expect(past.headers.get("content-range")).toBe(`bytes */${body.length}`);
		await past.arrayBuffer();
		// What is not one plain range is ignored: the whole file, as a server may answer.
		for (const odd of [
			"bytes=0-1,4-5",
			"items=0-1",
			"bytes=5-2",
			"bytes=a-b",
			"bytes=-",
		]) {
			const whole = await range(odd);
			expect([odd, whole.status]).toEqual([odd, 200]);
			expect(hex(await whole.arrayBuffer())).toBe(hex(body));
		}
	});

	test("an unchanged file answers 304 to its ETag, and a range is dropped when If-Range names another version", async () => {
		const body = bytesOf("ID3", [3, 0, 0, 0, 0, 0, 0], "0123456789");
		writeFileSync(join(root, "a.mp3"), body);
		const service = files();
		const first = await service.raw("agents", "a.mp3", false);
		const etag = first.headers.get("etag") ?? "";
		await first.arrayBuffer();
		const same = await service.raw("agents", "a.mp3", false, {
			ifNoneMatch: etag,
		});
		expect(same.status).toBe(304);
		expect(await same.text()).toBe("");
		const star = await service.raw("agents", "a.mp3", false, {
			ifNoneMatch: "*",
		});
		expect(star.status).toBe(304);
		const other = await service.raw("agents", "a.mp3", false, {
			ifNoneMatch: '"nope"',
		});
		expect(other.status).toBe(200);
		await other.arrayBuffer();
		const kept = await service.raw("agents", "a.mp3", false, {
			range: "bytes=0-1",
			ifRange: etag,
		});
		expect(kept.status).toBe(206);
		await kept.arrayBuffer();
		const dropped = await service.raw("agents", "a.mp3", false, {
			range: "bytes=0-1",
			ifRange: '"stale"',
		});
		expect(dropped.status).toBe(200);
		await dropped.arrayBuffer();
	});

	test("If-Range matches a strong ETag only, and the raw headers forbid framing and caching", async () => {
		writeFileSync(
			join(root, "a.mp3"),
			bytesOf("ID3", [3, 0, 0, 0, 0, 0, 0], "0123456789"),
		);
		const service = files();
		const first = await service.raw("agents", "a.mp3", false);
		const etag = first.headers.get("etag") ?? "";
		expect(etag).not.toStartWith("W/");
		expect(first.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'self'",
		);
		expect(first.headers.get("cache-control")).toBe("no-store");
		await first.arrayBuffer();
		const weak = await service.raw("agents", "a.mp3", false, {
			range: "bytes=0-1",
			ifRange: `W/${etag}`,
		});
		expect(weak.status).toBe(200);
		await weak.arrayBuffer();
	});

	test("the guards see ſ as s: .rt-traſh is the trash", async () => {
		writeFileSync(join(root, "a.txt"), "a");
		const service = files();
		await service.remove("agents", "a.txt", OWNER);
		writeFileSync(join(root, "b.txt"), "b");
		expect(
			(await refused(service.rename("agents", "b.txt", ".rt-traſh", OWNER)))
				.reason,
		).toBe("trash-dir");
	});

	test("a root missing at the start that appears as a link to the data directory is refused", async () => {
		const data = join(base, "data");
		mkdirSync(data);
		writeFileSync(join(data, "auth.json"), "SECRET");
		const later = join(base, "later");
		const service = new WorkspaceFiles({
			roots: [{ id: "scratch", label: "S", dir: later, writable: true }],
			logger: log.logger,
			protectedDirs: [data],
		});
		symlinkSync(data, later);
		expect((await refused(service.read("scratch", "auth.json"))).reason).toBe(
			"outside",
		);
		expect(
			(
				await refused(
					service.save(
						"scratch",
						"auth.json",
						{ text: "x", baseHash: sha("SECRET") },
						OWNER,
					),
				)
			).reason,
		).toBe("outside");
		expect(readFileSync(join(data, "auth.json"), "utf8")).toBe("SECRET");
	});

	test("the raw route has the read route's refusals: traversal, a link out of the place, a pipe, a folder", async () => {
		symlinkSync(join(outside, "secret.txt"), join(root, "out.mp3"));
		mkdirSync(join(root, "dir"));
		const service = files();
		for (const path of [
			"../outside/secret.txt",
			"/etc/hosts",
			"a/../../outside/secret.txt",
			"out.mp3",
			"dir",
			"x\0y",
		]) {
			await refused(service.raw("agents", path, false));
			await refused(service.raw("agents", path, false, { range: "bytes=0-3" }));
		}
		untouched();
	});

	test("a file over the download cap is refused for a preview too", async () => {
		const path = join(root, "big.mp4");
		writeFileSync(path, SAMPLES["a.mp4"]?.bytes ?? "");
		Bun.spawnSync(["truncate", "-s", String(50 * 1024 * 1024 + 1), path]);
		expect(
			(await refused(files().raw("agents", "big.mp4", false))).status,
		).toBe(413);
	});
});
