import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import {
	agentReply,
	type Booted,
	boot,
	Client,
	GUIDE,
	MEL,
	ORIGIN,
	ofType,
	PNG,
	rest,
	SCOUT,
} from "../testing/app-host.ts";

describeDb("the owner app over a real host", () => {
	let app: Booted;

	beforeAll(async () => {
		app = await boot({ auth: "verifier", graceSeconds: 0.4 });
		await app.host.context.services.get(IDENTITY).resolve(MEL);
	}, 30_000);

	afterAll(async () => {
		await app.stop();
	});

	afterEach(() => app.reset());

	test("an upload goes with a message and the agent reads it through the surface", async () => {
		const form = new FormData();
		form.set("file", new File([PNG], "pixel.png", { type: "image/png" }));
		const uploaded = await fetch("http://localhost/console/api/uploads", {
			method: "POST",
			body: form,
			headers: { "x-actor": "owner", origin: ORIGIN },
			unix: app.socket,
		} as never);
		expect(uploaded.status).toBe(200);
		const file = (await uploaded.json()) as { id: string; name: string };
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		// Someone else's id, an unknown one, or a file named twice is refused.
		tab.send({
			type: "send",
			id: "u0",
			room: SCOUT,
			text: "x",
			uploads: [crypto.randomUUID()],
		});
		expect((await tab.take(ofType("refused"))).code).toBe("unknown_upload");
		tab.send({
			type: "send",
			id: "u1",
			room: SCOUT,
			text: "look at this",
			uploads: [file.id],
		});
		const accepted = await tab.take(ofType("accepted"));
		expect(accepted.message.files).toMatchObject([
			{ id: file.id, name: "pixel.png" },
		]);
		await tab.take(agentReply("scout"));
		const turn = app.seen.find((r) => r.text.includes("look at this"));
		expect(turn?.attachments?.files.map((f) => f.name)).toEqual(["pixel.png"]);
		// The stored file is served as itself, an image inline, and never as a page.
		const served = await rest(app, `files/${file.id}`);
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toBe("image/png");
		expect(served.headers.get("content-security-policy")).toBe("sandbox");
		expect(served.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
		// Used once; a second message cannot name it.
		tab.send({
			type: "send",
			id: "u2",
			room: SCOUT,
			text: "again",
			uploads: [file.id],
		});
		expect((await tab.take(ofType("refused"))).code).toBe("unknown_upload");
		// A file that is not what its type says is not kept.
		const fake = new FormData();
		fake.set("file", new File(["not a png"], "x.png", { type: "image/png" }));
		const refused = await fetch("http://localhost/console/api/uploads", {
			method: "POST",
			body: fake,
			headers: { "x-actor": "owner", origin: ORIGIN },
			unix: app.socket,
		} as never);
		expect(refused.status).toBe(415);
		tab.close();
	});

	test("an ordinary file of any kind goes with a message, and the agent turn gets it saved as it was", async () => {
		const upload = async (file: File) => {
			const form = new FormData();
			form.set("file", file);
			return fetch("http://localhost/console/api/uploads", {
				method: "POST",
				body: form,
				headers: { "x-actor": "owner", origin: ORIGIN },
				unix: app.socket,
			} as never);
		};
		const notes = "# Notes\n\n- one\n- \u4e8c\n";
		const text = await upload(new File([notes], "notes.md", { type: "" }));
		expect(text.status).toBe(200);
		const textView = (await text.json()) as { id: string; type: string };
		expect(textView.type).toBe("text/markdown");
		const zipBytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0xff, 0, 1]);
		const zip = await upload(
			new File([zipBytes], "bundle.zip", { type: "application/zip" }),
		);
		expect(zip.status).toBe(200);
		const zipView = (await zip.json()) as { id: string; type: string };
		expect(zipView.type).toBe("application/octet-stream");
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({
			type: "send",
			id: "t1",
			room: SCOUT,
			text: "read the notes",
			uploads: [textView.id, zipView.id],
		});
		await tab.take(ofType("accepted"));
		await tab.take(agentReply("scout"));
		const turn = app.seen.find((r) => r.text.includes("read the notes"));
		const files = turn?.attachments?.files ?? [];
		expect(files.map((f) => f.name)).toEqual(["notes.md", "bundle.zip"]);
		// The agent can open what the owner sent, byte for byte.
		expect(await Bun.file(files[0]?.path ?? "").text()).toBe(notes);
		expect(
			new Uint8Array(await Bun.file(files[1]?.path ?? "").arrayBuffer()),
		).toEqual(zipBytes);
		// Served back as downloads, never as pages.
		const served = await rest(app, `files/${textView.id}`);
		expect(served.headers.get("content-type")).toBe("application/octet-stream");
		expect(served.headers.get("content-disposition")).toContain("attachment");
		expect(await served.text()).toBe(notes);
		tab.close();
	});

	test("a file over the old limit of 10 MiB goes through, as a stream", async () => {
		const big = new Uint8Array(12 * 1024 * 1024).map((_, i) => (i * 13) % 253);
		big[0] = 0;
		const form = new FormData();
		form.set(
			"file",
			new File([big], "big.bin", { type: "application/octet-stream" }),
		);
		const uploaded = await fetch("http://localhost/console/api/uploads", {
			method: "POST",
			body: form,
			headers: { "x-actor": "owner", origin: ORIGIN },
			unix: app.socket,
		} as never);
		expect(uploaded.status).toBe(200);
		const view = (await uploaded.json()) as { id: string; size: number };
		expect(view.size).toBe(big.byteLength);
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		const ready = await tab.take(ofType("ready"));
		expect(ready.uploads).toEqual({ maxBytes: 104857600, perMessage: 4 });
		tab.send({
			type: "send",
			id: "b1",
			room: SCOUT,
			text: "big file",
			uploads: [view.id],
		});
		await tab.take(ofType("accepted"));
		const served = await rest(app, `files/${view.id}`);
		expect(served.headers.get("content-length")).toBe(String(big.byteLength));
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(big);
		await tab.take(agentReply("scout")); // else it lands in the next test's socket
		tab.close();
	});

	test("a 30 MiB upload reaches the agent's turn as a file of its own, which its tools can open", async () => {
		const big = new Uint8Array(30 * 1024 * 1024).map((_, i) => (i * 7) % 251);
		big[0] = 0;
		const form = new FormData();
		form.set(
			"file",
			new File([big], "data.bin", { type: "application/octet-stream" }),
		);
		const uploaded = await fetch("http://localhost/console/api/uploads", {
			method: "POST",
			body: form,
			headers: { "x-actor": "owner", origin: ORIGIN },
			unix: app.socket,
		} as never);
		expect(uploaded.status).toBe(200);
		const view = (await uploaded.json()) as { id: string };
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({
			type: "send",
			id: "huge",
			room: SCOUT,
			text: "open the thirty",
			uploads: [view.id],
		});
		await tab.take(ofType("accepted"));
		await tab.take(agentReply("scout"));
		const turn = app.seen.find((r) => r.text.includes("open the thirty"));
		const files = turn?.attachments?.files ?? [];
		expect(files.map((f) => [f.name, f.size])).toEqual([
			["data.bin", big.byteLength],
		]);
		// Over 25 MiB the turn's text says it is kept for tools; the tool opens the very bytes.
		expect(turn?.text).not.toContain("larger than");
		expect(
			new Uint8Array(await Bun.file(files[0]?.path ?? "").arrayBuffer()),
		).toEqual(big);
		tab.close();
	});

	test("RV-F003: a waiting upload is deleted over REST by its owner, and a message cannot name it afterwards", async () => {
		const form = new FormData();
		form.set("file", new File(["scrap"], "scrap.txt", { type: "text/plain" }));
		const uploaded = await fetch("http://localhost/console/api/uploads", {
			method: "POST",
			body: form,
			headers: { "x-actor": "owner", origin: ORIGIN },
			unix: app.socket,
		} as never);
		const { id } = (await uploaded.json()) as { id: string };
		// Without the console's Origin, and for a member, nothing is deleted.
		expect(
			(await rest(app, `uploads/${id}`, { method: "DELETE", origin: null }))
				.status,
		).toBe(403);
		expect(
			(await rest(app, `uploads/${id}`, { method: "DELETE", who: "member" }))
				.status,
		).toBe(403);
		expect(
			(await rest(app, `uploads/${crypto.randomUUID()}`, { method: "DELETE" }))
				.status,
		).toBe(404);
		expect(
			(await rest(app, `uploads/${id}`, { method: "DELETE" })).status,
		).toBe(200);
		expect(
			(await rest(app, `uploads/${id}`, { method: "DELETE" })).status,
		).toBe(404);
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "d1", room: SCOUT, text: "x", uploads: [id] });
		expect((await tab.take(ofType("refused"))).code).toBe("unknown_upload");
		tab.close();
	});

	test("a reply's files are kept and served as downloads", async () => {
		app.scripts.set("make-file", async () => ({
			ok: true,
			text: "here you go",
			files: [
				{
					name: "page.html",
					data: new TextEncoder().encode("<script>1</script>"),
				},
			],
		}));
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "f1", room: SCOUT, text: "make-file" });
		const reply = await tab.take(agentReply("scout"));
		if (reply.type !== "message") throw new Error("expected a message");
		const [file] = reply.message.files;
		expect(file).toMatchObject({ name: "page.html" });
		const served = await rest(app, `files/${file?.id}`);
		expect(served.headers.get("content-disposition")).toContain("attachment");
		expect(served.headers.get("content-type")).toBe("application/octet-stream");
		expect(served.headers.get("content-security-policy")).toBe("sandbox");
		expect((await rest(app, "files/not-an-id")).status).toBe(404);
		tab.close();
	});

	test("a reply's files download as one zip: each under its own name, the swept ones left out, for the owner only", async () => {
		const bytes = (text: string) => new TextEncoder().encode(text);
		app.scripts.set("zip-these", async () => ({
			ok: true,
			text: "three files",
			files: [
				{ name: "notes.md", data: bytes("# one") },
				{ name: "notes.md", data: bytes("# two") },
				{ name: "gone.pdf", data: bytes("%PDF") },
			],
		}));
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "z1", room: SCOUT, text: "zip-these" });
		const reply = await tab.take(agentReply("scout"));
		tab.close();
		if (reply.type !== "message") throw new Error("expected a message");
		const { id, files } = reply.message;
		expect(files.map((f) => f.name)).toEqual([
			"notes.md",
			"notes.md",
			"gone.pdf",
		]);
		rmSync(join(app.dataDir, "web", "files", files[2]?.id ?? "missing"));
		const path = `files/zip?room=${encodeURIComponent(SCOUT)}&message=${id}`;
		const served = await rest(app, path);
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toBe("application/zip");
		expect(served.headers.get("content-disposition")).toMatch(
			/^attachment; filename="attachments-\d{8}-\d{4}\.zip"$/,
		);
		const zip = join(app.dataDir, "reply.zip");
		writeFileSync(zip, new Uint8Array(await served.arrayBuffer()));
		if (Bun.which("unzip")) {
			const listed = Bun.spawnSync(["unzip", "-Z1", zip]).stdout.toString();
			expect(listed.trim().split("\n")).toEqual(["notes.md", "notes-2.md"]);
			const second = Bun.spawnSync(["unzip", "-p", zip, "notes-2.md"]);
			expect(second.stdout.toString()).toBe("# two");
		}
		// A member may not read the agent room: the same refusal as for a file of it.
		const member = await rest(app, path, { who: "member" });
		expect(member.status).toBe(
			(await rest(app, `files/${files[0]?.id}`, { who: "member" })).status,
		);
		expect(member.status).toBe(403);
		expect(
			(
				await rest(
					app,
					`files/zip?room=${encodeURIComponent(SCOUT)}&message=99999999`,
				)
			).status,
		).toBe(404);
		expect(
			(
				await rest(
					app,
					`files/zip?room=${encodeURIComponent(GUIDE)}&message=${id}`,
				)
			).status,
		).toBe(404);
	});
});

describeDb("the owner app with a small upload limit", () => {
	let small: Booted;
	beforeAll(async () => {
		small = await boot({ auth: "verifier", uploadMaxBytes: 1024 * 1024 });
	});
	afterAll(async () => {
		await small.stop();
	});
	afterEach(() => small.reset());

	test("a file over the limit is refused with 413 and the page is told the limit", async () => {
		const send = (bytes: number) => {
			const data = new Uint8Array(bytes).fill(9);
			data[0] = 0;
			const form = new FormData();
			form.set("file", new File([data], "x.bin", { type: "application/zip" }));
			return fetch("http://localhost/console/api/uploads", {
				method: "POST",
				body: form,
				headers: { "x-actor": "owner", origin: ORIGIN },
				unix: small.socket,
			} as never);
		};
		const over = await send(2 * 1024 * 1024);
		expect(over.status).toBe(413);
		expect(((await over.json()) as { error: string }).error).toContain(
			"too large",
		);
		expect((await send(1024 * 1024)).status).toBe(200);
		const tab = await Client.open(small, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		expect((await tab.take(ofType("ready"))).uploads.maxBytes).toBe(
			1024 * 1024,
		);
		tab.close();
	});
});
